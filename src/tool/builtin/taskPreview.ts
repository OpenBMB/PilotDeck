import { request } from "node:http";
import path from "node:path";
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

const MAX_HTML_BYTES = 512 * 1024;

/** Local readiness is distinct from browser acceptance and client reachability. */
export function createTaskPreviewTool(runtime: BackgroundTaskRuntime): PilotDeckToolDefinition<TaskPreviewInput, TaskPreviewOutput> {
  return {
    name: "task_preview",
    description: "Verify a running development server before handing it to the user. Pass its task_create taskId, exact loopback HTTP URL from task_output, and a distinctive expectedText from the page HTML. Checks HTTP success, HTML content and that marker; does not execute JavaScript or open a browser. Use browser-use separately for visual/interaction acceptance. The URL is on the executing Gateway, not necessarily the user's machine; never invent forwarding. Include the verified URL and task_stop taskId in your final response, and leave the requested preview running.",
    kind: "network",
    inputSchema: {
      type: "object", required: ["taskId", "url", "expectedText"], additionalProperties: false,
      properties: {
        taskId: { type: "string", description: "Running task_create development server owned by this session and workspace." },
        url: { type: "string", description: "Exact HTTP page URL on localhost, 127.0.0.1 or [::1], with an explicit nonzero port. Redirects are not followed." },
        expectedText: { type: "string", description: "Distinctive nonempty text present in the initial HTML, such as this application's title (max 1024 characters). This is an HTTP content check, not rendered-page acceptance." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      let url: URL;
      try { url = new URL(input.url); } catch { throw invalid("Provide a valid preview URL."); }
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || !url.port || Number(url.port) === 0 || url.username || url.password || url.hash) {
        throw invalid("Preview requires a loopback HTTP URL with an explicit nonzero port, no credentials and no fragment.");
      }
      if (!input.expectedText.trim() || input.expectedText.length > 1024) {
        throw invalid("expectedText must contain 1-1024 characters identifying the page HTML.");
      }
      const assertTask = () => {
        const task = runtime.get(input.taskId);
        if (!task || task.sessionId !== context.sessionId || path.resolve(task.cwd) !== path.resolve(context.cwd)) {
          throw invalid("Preview requires a task owned by the current session and workspace.");
        }
        if (task.status !== "running") throw invalid("Preview task is not running. Inspect task_output and restart it if needed.");
      };
      assertTask();
      context.abortSignal?.throwIfAborted();
      // Pin localhost to loopback without DNS or ambient proxy configuration.
      // Vite may bind localhost on IPv6 only, so retry a refused IPv4 connection.
      const target = new URL(url);
      if (target.hostname === "localhost") target.hostname = "127.0.0.1";
      try {
        try {
          await checkHtml(target, url.host, input.expectedText, context.abortSignal);
        } catch (error) {
          if (url.hostname !== "localhost" || (error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
          target.hostname = "[::1]";
          await checkHtml(target, url.host, input.expectedText, context.abortSignal);
        }
      } catch (error) {
        if (context.abortSignal?.aborted) throw new PilotDeckToolRuntimeError("tool_aborted", "Preview check cancelled.");
        throw new PilotDeckToolRuntimeError("tool_execution_failed", `Preview is not ready: ${error instanceof Error ? error.message : String(error)} Inspect task_output, fix the server and retry task_preview.`);
      }
      assertTask();
      const data: TaskPreviewOutput = {
        taskId: input.taskId, url: url.href, httpStatus: 200,
        checkedAt: (context.now?.() ?? new Date()).toISOString(),
        verification: "http-content", browserVerified: false, scope: "gateway-loopback",
      };
      return {
        content: [{ type: "text", text: `[Open preview](<${data.url}>)\n\nHTTP HTML and expected content verified at ${data.checkedAt}; browser rendering has not been verified.\nThis address is local to the executing Gateway. Remote/Docker clients may need port forwarding.\nLeave the preview running for review. Stop with task_stop({ taskId: ${JSON.stringify(data.taskId)} }).` }],
        data,
      };
    },
  };
}

function invalid(message: string): PilotDeckToolRuntimeError {
  return new PilotDeckToolRuntimeError("invalid_tool_input", message);
}

function checkHtml(url: URL, host: string, expectedText: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: { host, accept: "text/html", "accept-encoding": "identity" }, signal }, res => {
      if (res.statusCode !== 200 || !/^text\/html\b/i.test(res.headers["content-type"] ?? "")) {
        res.destroy();
        reject(new Error(`Expected HTTP 200 HTML, received ${res.statusCode}. Redirects are not followed.`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_HTML_BYTES) { req.destroy(new Error("Preview HTML exceeds 512 KiB.")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        if (!html.includes(expectedText)) { reject(new Error("Page HTML does not contain expectedText; check the exact URL and application.")); return; }
        resolve();
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Preview check timed out after 5 seconds.")), 5000);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}
