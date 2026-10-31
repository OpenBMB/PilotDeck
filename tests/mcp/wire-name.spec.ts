import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMcpToolWireName,
  parseMcpToolWireName,
} from "../../src/mcp/runtime/wireName.js";

function roundTrip(serverId: string, toolName: string) {
  return parseMcpToolWireName(buildMcpToolWireName(serverId, toolName));
}

test("plain server and tool names round-trip", () => {
  assert.deepEqual(roundTrip("filesystem", "read_file"), {
    serverId: "filesystem",
    toolName: "read_file",
  });
});

test("server IDs with double underscores build an unambiguous wire name", () => {
  const wireName = buildMcpToolWireName("0__A", "a");
  assert.equal(wireName, "mcp__0_A__a");
  assert.deepEqual(parseMcpToolWireName(wireName), {
    serverId: "0_A",
    toolName: "a",
  });
});

test("server IDs ending in an underscore keep the separator unambiguous", () => {
  const wireName = buildMcpToolWireName("srv_", "tool");
  assert.equal(wireName, "mcp__srv__tool");
  assert.deepEqual(parseMcpToolWireName(wireName), {
    serverId: "srv",
    toolName: "tool",
  });
});

test("sanitized characters cannot form a bogus separator", () => {
  // "a..b" would previously normalize to "a__b" and split as server "a".
  const wireName = buildMcpToolWireName("a..b", "tool");
  assert.equal(wireName, "mcp__a_b__tool");
  assert.deepEqual(parseMcpToolWireName(wireName), {
    serverId: "a_b",
    toolName: "tool",
  });
});

test("tool names may contain double underscores", () => {
  assert.deepEqual(roundTrip("srv", "a__b"), {
    serverId: "srv",
    toolName: "a__b",
  });
});

test("single underscores inside a server ID are preserved", () => {
  assert.deepEqual(roundTrip("my_server", "tool"), {
    serverId: "my_server",
    toolName: "tool",
  });
});
