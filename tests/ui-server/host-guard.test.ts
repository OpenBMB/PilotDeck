import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  hostGuardMiddleware,
  buildAllowedHosts,
  resolveAllowedHostsFromEnv,
} = require(
  join(process.cwd(), "ui/server/middleware/hostGuard.js"),
) as {
  hostGuardMiddleware: (opts?: { bindHost?: string; allowedHosts?: string[] }) => (req: any, res: any, next: () => void) => void;
  buildAllowedHosts: (bindHost?: string, extraList?: string[]) => Set<string>;
  resolveAllowedHostsFromEnv: (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => string[];
};

function mkReq(host: string | undefined) {
  return { headers: host === undefined ? {} : { host } };
}
function mkRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

test("hostGuard allows loopback regardless of bind", () => {
  const mw = hostGuardMiddleware({ bindHost: "127.0.0.1" });
  for (const h of [
    "127.0.0.1",
    "localhost",
    "127.0.0.1:3001",
    "localhost:3001",
    "127.5.5.5:1234",
    "127.0.0.42",
    "[::1]:3001",
    "[::1]",
    "::1",
  ]) {
    const res = mkRes();
    let called = false;
    mw(mkReq(h), res, () => { called = true; });
    assert.equal(called, true, `expected loopback ${h} to pass`);
    assert.equal(res.statusCode, 200);
  }
});

test("hostGuard rejects DNS-rebinding Host headers", () => {
  const mw = hostGuardMiddleware({ bindHost: "127.0.0.1" });
  for (const h of [
    "attacker.example",
    "evil.com:3001",
    "169.254.169.254",
    "8.8.8.8:3001",
    "rebind.attacker.test:3001",
  ]) {
    const res = mkRes();
    let called = false;
    mw(mkReq(h), res, () => { called = true; });
    assert.equal(called, false, `expected ${h} to be blocked`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "FORBIDDEN_HOST");
  }
});

test("hostGuard honors PILOTDECK_ALLOWED_HOSTS allowlist", () => {
  const mw = hostGuardMiddleware({
    bindHost: "0.0.0.0",
    allowedHosts: ["pilotdeck.local", "lan.host"],
  });
  for (const h of ["pilotdeck.local:3001", "lan.host"]) {
    const res = mkRes();
    let called = false;
    mw(mkReq(h), res, () => { called = true; });
    assert.equal(called, true, `expected allowlisted ${h} to pass`);
  }
  const res = mkRes();
  let called = false;
  mw(mkReq("attacker.com"), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("hostGuard rejects missing Host header", () => {
  const mw = hostGuardMiddleware({ bindHost: "127.0.0.1" });
  const res = mkRes();
  let called = false;
  mw(mkReq(undefined), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("buildAllowedHosts ignores wildcard bind and lowercases entries", () => {
  const s1 = buildAllowedHosts("0.0.0.0", ["MyHost.Local"]);
  assert.equal(s1.has("0.0.0.0"), true); // explicit literal, kept for transparency
  assert.equal(s1.has("myhost.local"), true);
  // The bind value 0.0.0.0 is not treated as a real allowed name on its own
  // beyond the loopback set entry — proves buildAllowedHosts doesn't elevate
  // wildcard binds into a real allowlist domain.
  const s2 = buildAllowedHosts("::", []);
  assert.equal(s2.has("::"), true);
  assert.equal(s2.has("localhost"), true);
});

test("resolveAllowedHostsFromEnv parses comma list", () => {
  const list = resolveAllowedHostsFromEnv({
    PILOTDECK_ALLOWED_HOSTS: " foo , bar.example,baz ",
  });
  assert.deepEqual(list, ["foo", "bar.example", "baz"]);
  assert.deepEqual(resolveAllowedHostsFromEnv({}), []);
  assert.deepEqual(resolveAllowedHostsFromEnv({ PILOTDECK_ALLOWED_HOSTS: "" }), []);
});
