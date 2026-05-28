/**
 * `/api/web/*` HTTP router.
 *
 * Bound by `GatewayServer` so the Web UI can call REST-style endpoints
 * for file/git/project surfaces that are awkward over the streaming
 * WebSocket. All endpoints require `Authorization: Bearer <token>`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ProjectFileService, WorkspaceBoundaryError } from "./projectFiles.js";
import { ProjectGitService } from "./projectGit.js";
import type { Gateway } from "../../gateway/protocol/types.js";

export type WebHttpRouterOptions = {
  gateway: Gateway;
  token: string;
  /** Resolves a projectKey from the URL into an absolute project root. */
  resolveProject?: (projectKey: string) => string;
};

const PROJECT_RE = /^\/api\/web\/projects(?:\/([^/]+)(\/.*)?)?$/;

export async function handleWebApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebHttpRouterOptions,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/web/")) {
    return false;
  }

  if (!isAuthorized(request, options.token)) {
    sendJson(response, 401, { error: { code: "unauthorized", message: "missing or invalid token" } });
    return true;
  }

  const match = PROJECT_RE.exec(url.pathname);
  if (url.pathname === "/api/web/projects" && request.method === "GET") {
    const result = await options.gateway.listProjects();
    sendJson(response, 200, result);
    return true;
  }

  if (match && match[1] && (!match[2] || match[2] === "/")) {
    if (request.method === "GET") {
      try {
        const summary = await options.gateway.describeProject({
          projectKey: decodeURIComponent(match[1]),
        });
        sendJson(response, 200, summary);
      } catch (error) {
        sendJson(response, 404, errorBody("project_not_found", error));
      }
      return true;
    }
  }

  if (match && match[1] && match[2]) {
    const projectKey = decodeURIComponent(match[1]);
    const projectRoot = options.resolveProject
      ? options.resolveProject(projectKey)
      : projectKey;
    const subPath = match[2];

    try {
      if (subPath === "/files/tree" && request.method === "GET") {
        const path = url.searchParams.get("path") ?? ".";
        const fileService = new ProjectFileService({ projectRoot });
        const result = await fileService.readTree(path);
        sendJson(response, 200, result);
        return true;
      }
      if (subPath === "/files/read" && request.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) {
          sendJson(response, 400, { error: { code: "missing_path", message: "?path required" } });
          return true;
        }
        const fileService = new ProjectFileService({ projectRoot });
        const result = await fileService.readFile(path);
        sendJson(response, 200, result);
        return true;
      }
      if (subPath === "/files/write" && request.method === "POST") {
        const body = await readJsonBody<{ path?: string; content?: string; encoding?: "utf8" | "base64" }>(request);
        if (!body?.path || typeof body.content !== "string") {
          sendJson(response, 400, {
            error: { code: "invalid_body", message: "Expected { path, content[, encoding] }" },
          });
          return true;
        }
        const fileService = new ProjectFileService({ projectRoot });
        await fileService.writeFile(body.path, body.content, body.encoding);
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (subPath === "/git/status" && request.method === "GET") {
        const gitService = new ProjectGitService({ projectRoot });
        const status = await gitService.status();
        sendJson(response, 200, status);
        return true;
      }
      if (subPath === "/git/diff" && request.method === "GET") {
        const path = url.searchParams.get("path") ?? undefined;
        const gitService = new ProjectGitService({ projectRoot });
        const diff = await gitService.diff(path);
        sendJson(response, 200, diff);
        return true;
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) {
        sendJson(response, 403, errorBody("workspace_boundary", error));
        return true;
      }
      sendJson(response, 500, errorBody("internal_error", error));
      return true;
    }
  }

  sendJson(response, 404, { error: { code: "not_found", message: `No /api/web route for ${url.pathname}` } });
  return true;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] === token;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorBody(code: string, error: unknown): unknown {
  return {
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export { ProjectFileService, ProjectGitService };
export { WorkspaceBoundaryError } from "./projectFiles.js";
