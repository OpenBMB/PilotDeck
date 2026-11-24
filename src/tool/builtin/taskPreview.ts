import { request } from "node:http";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type TaskPreviewInput = {
  taskId: string;
  url: string;
  expectedText: string;
};

export type TaskPreviewOutput = {
  taskId: string;
  url: string;
  httpStatus: number;
  checkedAt: string;
  verification: "http-content";
  browserVerified: false;
  scope: "gateway-loopback";
};

export type TaskPreviewRuntime = Pick<BackgroundTaskRuntime, "get" | "getOutput">
  & Partial<Pick<BackgroundTaskRuntime, "getStartupOutput">>;

type AnnouncedHost = "localhost" | "127.0.0.1" | "0.0.0.0" | "[::]" | "[::1]";
type LoopbackTargetHost = "127.0.0.1" | "[::1]";

type AnnouncedOrigin = {
  host: AnnouncedHost;
  port: number;
  displayOrigin: string;
};

const MAX_HTML_BYTES = 512 * 1024;
const RETRYABLE_LOOPBACK_CODES = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"]);

/** Local readiness is distinct from browser acceptance and client reachability. */
export function createTaskPreviewTool(runtime: TaskPreviewRuntime): PilotDeckToolDefinition<TaskPreviewInput, TaskPreviewOutput> {
  return {
    name: "task_preview",
    description:
      "Verify a running development server before handing it to the user. Pass its task_create taskId, exact HTTP page URL on the origin announced in that task's output, and a distinctive expectedText from the initial page HTML. Checks HTTP success, HTML content and that marker; does not execute JavaScript or open a browser. Use browser-use separately for visual/interaction acceptance. The URL is on the executing Gateway, not necessarily the user's machine; never invent forwarding. Include the verified URL and task_stop taskId in your final response, and leave the requested preview running.",
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["taskId", "url", "expectedText"],
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          description: "Running task_create development server owned by this session and workspace.",
        },
        url: {
          type: "string",
          description:
            "Exact HTTP page URL on localhost, 127.0.0.1 or [::1], with the non-default port announced by the task. Wildcard binds (0.0.0.0 or [::]) map to loopback on the same port. Redirects are not followed.",
        },
        expectedText: {
          type: "string",
          description:
            "Distinctive nonempty text present in the raw initial HTML, matched exactly including case and whitespace; for client-rendered SPAs, set a project-specific <title> in index.html rather than a scaffold default or JS-rendered text (max 1024 characters).",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw invalid("Provide a valid preview URL.");
      }
      if (
        url.protocol !== "http:"
        || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || !url.port
        || Number(url.port) === 0
        || url.username
        || url.password
        || url.hash
      ) {
        throw invalid(
          "Preview requires a loopback HTTP URL with an explicit nonzero, non-default port, no credentials and no fragment. If the server prints 0.0.0.0 or [::], retry the same port on 127.0.0.1, [::1] or localhost.",
        );
      }
      if (!input.expectedText.trim() || input.expectedText.length > 1024) {
        throw invalid("expectedText must contain 1-1024 characters identifying the page HTML.");
      }

      const assertTask = () => {
        const task = runtime.get(input.taskId);
        if (!task || task.sessionId !== context.sessionId || path.resolve(task.cwd) !== path.resolve(context.cwd)) {
          throw invalid("Preview requires a task owned by the current session and workspace.");
        }
        if (task.status !== "running") {
          throw invalid("Preview task is not running. Inspect task_output and restart it if needed.");
        }
      };
      assertTask();

      const slice = runtime.getOutput(input.taskId, 0);
      const startup = slice.truncated ? (runtime.getStartupOutput?.(input.taskId) ?? "") : "";
      const combinedOutput = startup ? `${startup}\n${slice.content}` : slice.content;
      const announced = parseAnnouncedOrigins(combinedOutput);
      const probeHosts = resolveProbeHosts(announced, url);
      if (!probeHosts) {
        throw invalid(formatMissingOriginMessage(url, announced, slice.truncated && !startup));
      }

      const timeout = AbortSignal.timeout(5000);
      const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;

      // Pin loopback probes to literal IPv4/IPv6 addresses without DNS or ambient proxies.
      try {
        signal.throwIfAborted();
        let lastError: unknown;
        for (let index = 0; index < probeHosts.length; index++) {
          const target = new URL(url);
          target.hostname = probeHosts[index];
          try {
            await checkHtml(target, url.host, input.expectedText, signal);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (index + 1 >= probeHosts.length || !RETRYABLE_LOOPBACK_CODES.has(code)) {
              throw error;
            }
          }
        }
        if (lastError) {
          throw lastError;
        }
      } catch (error) {
        if (context.abortSignal?.aborted) {
          throw new PilotDeckToolRuntimeError("tool_aborted", "Preview check cancelled.");
        }
        if (timeout.aborted) {
          throw new PilotDeckToolRuntimeError(
            "tool_execution_failed",
            "Preview check timed out after 5 seconds. Inspect task_output and retry task_preview.",
          );
        }
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `Preview is not ready: ${error instanceof Error ? error.message : String(error)} Inspect task_output, fix the server and retry task_preview.`,
        );
      }

      assertTask();
      const data: TaskPreviewOutput = {
        taskId: input.taskId,
        url: url.href,
        httpStatus: 200,
        checkedAt: (context.now?.() ?? new Date()).toISOString(),
        verification: "http-content",
        browserVerified: false,
        scope: "gateway-loopback",
      };
      return {
        content: [{
          type: "text",
          text:
            `[Open preview](<${data.url}>)\n\n`
            + `HTTP HTML and expected content verified at ${data.checkedAt}; browser rendering has not been verified.\n`
            + "This address is local to the executing Gateway. Remote/Docker clients may need port forwarding.\n"
            + `Leave the preview running for review. Stop with task_stop({ taskId: ${JSON.stringify(data.taskId)} }).`,
        }],
        data,
      };
    },
  };
}

// Startup banners can contain ANSI color codes. Extract announced loopback/wildcard
// HTTP origins so callers can verify routes beneath the service's bound port.
function parseAnnouncedOrigins(output: string): AnnouncedOrigin[] {
  const matches = stripVTControlCharacters(output).matchAll(
    /(?:^|[\s"'(<=>])http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):([0-9]{1,5})(?=$|[\s/?#"'<>),;])/gi,
  );
  const origins: AnnouncedOrigin[] = [];
  const seen = new Set<string>();
  for (const [, printedHost, printedPort] of matches) {
    const port = Number(printedPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const host = printedHost.toLowerCase() as AnnouncedHost;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const loopbackHost = host === "0.0.0.0" ? "127.0.0.1" : host === "[::]" ? "[::1]" : host;
    origins.push({ host, port, displayOrigin: `http://${loopbackHost}:${port}` });
  }
  return origins;
}

function resolveProbeHosts(announced: AnnouncedOrigin[], url: URL): LoopbackTargetHost[] | null {
  const port = Number(url.port);
  const matching = announced.filter(entry => entry.port === port);
  if (matching.length === 0) return null;

  const allowsIpv4 = matching.some(entry =>
    entry.host === "127.0.0.1" || entry.host === "0.0.0.0" || entry.host === "localhost" || entry.host === "[::]",
  );
  const allowsIpv6 = matching.some(entry =>
    entry.host === "[::1]" || entry.host === "[::]" || entry.host === "localhost",
  );

  if (url.hostname === "127.0.0.1") {
    return allowsIpv4 ? ["127.0.0.1"] : null;
  }
  if (url.hostname === "[::1]") {
    return allowsIpv6 ? ["[::1]"] : null;
  }
  const hosts: LoopbackTargetHost[] = [];
  if (allowsIpv4) hosts.push("127.0.0.1");
  if (allowsIpv6) hosts.push("[::1]");
  return hosts.length > 0 ? hosts : null;
}

function formatMissingOriginMessage(url: URL, announced: AnnouncedOrigin[], startupEvicted: boolean): string {
  if (announced.length > 0) {
    const list = [...new Set(announced.map(entry => entry.displayOrigin))].slice(0, 4).join(", ");
    return `The preview origin was not found in this task's retained output (requested ${url.origin}; announced: ${list}). Inspect task_output and use an origin announced by that service.`;
  }
  if (startupEvicted) {
    return `The preview origin was not found in this task's retained output (requested ${url.origin}; early startup output was evicted from the output buffer). Inspect task_output or restart the service so it announces its http:// URL.`;
  }
  return `The preview origin was not found in this task's retained output (requested ${url.origin}; no http:// loopback or wildcard URL announced yet). Inspect task_output and ensure the server logs its http://host:port URL.`;
}

function invalid(message: string): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError("invalid_tool_input", message);
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  const cleaned = stripVTControlCharacters(match[1]).replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}...` : cleaned;
}

function checkHtml(url: URL, host: string, expectedText: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", headers: { host, accept: "text/html", "accept-encoding": "identity" }, signal },
      res => {
        const contentType = res.headers["content-type"] ?? "";
        let failure: string | undefined;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          failure = `Received HTTP ${res.statusCode} redirect; redirects are not followed. Use the exact HTML page URL.`;
        } else if (res.statusCode !== 200) {
          failure = `Expected HTTP 200, received ${res.statusCode}.`;
        } else if (!/^text\/html\b/i.test(contentType)) {
          failure = `Expected text/html, received ${contentType || "no content-type"} (HTTP 200).`;
        } else if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          failure = `Unsupported content-encoding: ${res.headers["content-encoding"]}; serve uncompressed HTML.`;
        }
        if (failure) {
          res.destroy();
          reject(new Error(failure));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTML_BYTES) {
            req.destroy(new Error("Preview HTML exceeds 512 KiB."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          if (!html.includes(expectedText)) {
            const title = extractHtmlTitle(html);
            const titleHint = title ? ` (initial <title>: ${JSON.stringify(title)})` : "";
            reject(new Error(
              `Page initial HTML${titleHint} does not contain expectedText. task_preview checks raw server HTML before JavaScript executes; for client-rendered apps, set a project-specific <title> in index.html and match it.`,
            ));
            return;
          }
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
