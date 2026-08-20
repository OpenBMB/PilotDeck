import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleWebApiRequest } from "../../src/adapters/web/httpRouter.js";
import type { Gateway } from "../../src/gateway/index.js";

test("files/write rejects malformed path, content, and encoding without writing", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-web-write-"));
  const server = createServer((request, response) => {
    void handleWebApiRequest(request, response, {
      gateway: {} as Gateway,
      token: "test-token",
      resolveProject: () => projectRoot,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(projectRoot, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/web/projects/project/files/write`;
  const invalidBodies = [
    { path: 42, content: "value" },
    { path: "", content: "value" },
    { path: "invalid-content.txt", content: 42 },
    { path: "invalid-encoding.txt", content: "value", encoding: "hex" },
  ];

  for (const body of invalidBodies) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "invalid_body");
  }

  await assert.rejects(() => stat(join(projectRoot, "invalid-content.txt")));
  await assert.rejects(() => stat(join(projectRoot, "invalid-encoding.txt")));

  const valid = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: "valid.txt", content: "dmFsdWU=", encoding: "base64" }),
  });
  assert.equal(valid.status, 200);
  assert.equal(await readFile(join(projectRoot, "valid.txt"), "utf8"), "value");
});
