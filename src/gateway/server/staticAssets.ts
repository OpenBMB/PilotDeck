import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function serveStaticAsset(staticRoot: string, requestPath: string, response: ServerResponse): boolean {
  const root = resolve(staticRoot);
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = resolve(join(root, normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "")));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return false;
  }
  const filePath = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(root, "index.html");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }

  response.writeHead(200, { "content-type": CONTENT_TYPES[filePath.slice(filePath.lastIndexOf("."))] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
  return true;
}
