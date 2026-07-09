import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";

function codeFor(message: string): string {
  return normalizeModelError("test", "openai", new Error(message)).code;
}

test("normalizeModelError classifies common network failures", () => {
  assert.equal(codeFor("getaddrinfo ENOTFOUND api.test"), "dns_error");
  assert.equal(codeFor("read ECONNRESET"), "connection_reset");
  assert.equal(codeFor("connect ECONNREFUSED 127.0.0.1:443"), "connection_refused");
  assert.equal(codeFor("certificate has expired"), "tls_error");
  assert.equal(codeFor("proxy CONNECT failed"), "proxy_error");
});
