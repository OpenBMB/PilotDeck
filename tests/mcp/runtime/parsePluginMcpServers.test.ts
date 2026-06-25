import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";

import { parsePluginMcpServers } from "../../../src/mcp/runtime/parsePluginMcpServers.js";

test("plugin MCP server specs expand env and userHome placeholders", () => {
  const previousToken = process.env.PLUGIN_MCP_TOKEN;
  process.env.PLUGIN_MCP_TOKEN = "secret-token";

  try {
    const result = parsePluginMcpServers({
      local: {
        command: "${userHome}/bin/server",
        args: ["--config", "${userHome}/mcp.json", "--missing=${env:MISSING_PLUGIN_MCP_TOKEN}"],
        cwd: "${userHome}/work",
        env: {
          TOKEN: "${env:PLUGIN_MCP_TOKEN}",
          HOME_PATH: "${userHome}/data",
        },
      },
      remote: {
        url: "https://example.test/${env:PLUGIN_MCP_TOKEN}",
        headers: {
          Authorization: "Bearer ${env:PLUGIN_MCP_TOKEN}",
          Root: "${userHome}",
        },
      },
    });

    assert.deepEqual(result.diagnostics, []);
    const local = result.servers[0];
    assert.equal(local?.transport, "stdio");
    if (!local || local.transport !== "stdio") return;
    assert.equal(local.command, `${homedir()}/bin/server`);
    assert.deepEqual(local.args, ["--config", `${homedir()}/mcp.json`, "--missing="]);
    assert.equal(local.cwd, `${homedir()}/work`);
    assert.deepEqual(local.env, {
      TOKEN: "secret-token",
      HOME_PATH: `${homedir()}/data`,
    });

    const remote = result.servers[1];
    assert.equal(remote?.transport, "streamable_http");
    if (!remote || remote.transport !== "streamable_http") return;
    assert.equal(remote.url, "https://example.test/secret-token");
    assert.deepEqual(remote.headers, {
      Authorization: "Bearer secret-token",
      Root: homedir(),
    });
  } finally {
    if (previousToken === undefined) {
      delete process.env.PLUGIN_MCP_TOKEN;
    } else {
      process.env.PLUGIN_MCP_TOKEN = previousToken;
    }
  }
});
