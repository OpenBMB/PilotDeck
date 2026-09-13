import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkDelivery,
  hasDeliveryContent,
  parseDelivery,
  validateDeliveryContract,
} from "../../../../src/agent/sub/delivery/checks.js";

async function tmpWorkspace(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pd-delivery-checks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// validateDeliveryContract
// ---------------------------------------------------------------------------

test("validateDeliveryContract: empty/undefined contracts normalize to {}", () => {
  assert.deepEqual(validateDeliveryContract(undefined), {});
  assert.deepEqual(validateDeliveryContract(null), {});
  assert.deepEqual(validateDeliveryContract({}), {});
});

test("validateDeliveryContract: accepts schema and review", () => {
  const contract = validateDeliveryContract({
    review: true,
    schema: {
      type: "object",
      title: "Delivery",
      description: "d",
      properties: {
        summary: { type: "string", description: "what happened" },
        rows: { type: "array", items: { type: "object", properties: { n: { type: "number" } } } },
        report: { type: "string", "x-file": true },
      },
    },
  });
  assert.equal(contract.review, true);
  assert.ok(contract.schema && typeof contract.schema === "object");
});

test("validateDeliveryContract rejects unknown options and bad shapes", () => {
  assert.throws(() => validateDeliveryContract({ unknownOption: 1 }), /unknown/i);
  assert.throws(() => validateDeliveryContract([1, 2]), /object/);
  assert.throws(() => validateDeliveryContract("nope"), /object/);
  assert.throws(() => validateDeliveryContract({ review: "yes" }), /review/);
  assert.throws(() => validateDeliveryContract({ schema: "not-an-object" }), /schema/);
});

test("validateDeliveryContract rejects unsupported schema keywords", () => {
  for (const keyword of ["required", "minimum", "maximum", "const", "enum", "pattern", "format"]) {
    const schema = keyword === "required"
      ? { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
      : { type: "object", properties: { a: { [keyword]: "x" } } };
    assert.throws(() => validateDeliveryContract({ schema }), new RegExp(keyword), keyword);
  }
});

test("validateDeliveryContract rejects unknown schema keyword anywhere in tree", () => {
  const schema = {
    type: "object",
    properties: {
      nested: { type: "array", items: { type: "object", properties: { x: { type: "string", bogus: 1 } } } },
    },
  };
  assert.throws(() => validateDeliveryContract({ schema }), /bogus/);
});

test("validateDeliveryContract: type must be explicit when node constrains value", () => {
  assert.throws(() => validateDeliveryContract({ schema: { type: "object", properties: { a: { properties: {} } } } }), /type/);
  assert.throws(() => validateDeliveryContract({ schema: { type: "object", properties: { a: { items: {} } } } }), /type/);
  assert.throws(() => validateDeliveryContract({ schema: { type: "object", properties: { a: { properties: {}, type: "string" } } } }), /type/);
  assert.throws(() => validateDeliveryContract({ schema: { type: "object", properties: { a: { type: "integer" } } } }), /type/);
});

test("validateDeliveryContract enforces structural bounds", () => {
  // Depth bound.
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 40; i++) deep = { type: "object", properties: { n: deep } };
  assert.throws(() => validateDeliveryContract({ schema: deep }), /depth/i);

  // Node bound.
  const wide: Record<string, unknown> = { type: "object", properties: {} };
  const props = wide.properties as Record<string, unknown>;
  for (let i = 0; i < 600; i++) props[`k${i}`] = { type: "string" };
  assert.throws(() => validateDeliveryContract({ schema: wide }), /nodes|size|complexity/i);
});

// ---------------------------------------------------------------------------
// hasDeliveryContent
// ---------------------------------------------------------------------------

test("hasDeliveryContent treats absent/null/whitespace/empty containers as empty", () => {
  for (const empty of [undefined, null, "", "   \n\t", [], {}, { a: { b: [] } }, { a: [null, ""] }, [{}], [""], { a: { b: { c: " " } } }]) {
    assert.equal(hasDeliveryContent(empty), false, JSON.stringify(empty));
  }
});

test("hasDeliveryContent treats 0 and false as real content", () => {
  assert.equal(hasDeliveryContent(0), true);
  assert.equal(hasDeliveryContent(false), true);
  assert.equal(hasDeliveryContent({ retry: false }), true);
  assert.equal(hasDeliveryContent({ attempts: 0 }), true);
  assert.equal(hasDeliveryContent([0]), true);
  assert.equal(hasDeliveryContent({ a: { b: false } }), true);
});

test("hasDeliveryContent is bounded (deep + cyclic input)", () => {
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 64; i++) deep = { n: deep };
  assert.equal(hasDeliveryContent(deep), true); // Unknown deep content is never silently classed as absent.

  const cyclic: Record<string, unknown> = { a: "text" };
  cyclic.self = cyclic;
  assert.equal(hasDeliveryContent(cyclic), true);
});

// ---------------------------------------------------------------------------
// parseDelivery
// ---------------------------------------------------------------------------

test("parseDelivery: empty text becomes empty object", () => {
  assert.deepEqual(parseDelivery("").value, {});
  assert.deepEqual(parseDelivery("   \n").value, {});
});

test("parseDelivery accepts a plain JSON object", () => {
  const parsed = parseDelivery('{"summary":"done","attempts":0}');
  assert.deepEqual(parsed.value, { summary: "done", attempts: 0 });
  assert.equal(parsed.issue, undefined);
});

test("parseDelivery accepts a single enclosing json fence", () => {
  for (const text of [
    "```json\n{\"summary\":\"done\"}\n```",
    "```\n{\"summary\":\"done\"}\n```",
    "```json {\"summary\":\"done\"} ```",
  ]) {
    const parsed = parseDelivery(text);
    assert.deepEqual(parsed.value, { summary: "done" }, text);
  }
});

test("parseDelivery tolerates one unclosed opening fence whose full body parses to one object", () => {
  for (const text of [
    "```json\n{\"summary\":\"done\"}", // the live edge: the child never closed the fence
    "```json\r\n{\"summary\":\"done\"}", // CRLF opening fence
    "```\n{\"summary\":\"done\"}", // untyped fence wrapping JSON
    "```JSON\n{\"summary\":\"done\"}", // case-insensitive info string
    "```json {\"summary\":\"done\"}", // inline, unclosed
  ]) {
    const parsed = parseDelivery(text);
    assert.deepEqual(parsed.value, { summary: "done" }, text);
    assert.equal(parsed.issue, undefined, text);
    assert.equal(parsed.rawText, undefined, text);
  }
});

test("parseDelivery: a malformed JSON-looking fence is malformed_json, never prose/skipped", () => {
  for (const text of [
    "```json\n{\"summary\":", // unclosed fence, broken JSON
    "```json\n{\"summary\":\"done\"}\nand some trailing prose", // json fence, body is not one object
    "```\n{oops}", // untyped fence, JSON-looking malformed body
    "```json\n{\"summary\":\"done\"}\n```\nthanks!", // closed fence plus trailing text
  ]) {
    const parsed = parseDelivery(text);
    assert.ok(parsed.issue, text);
    assert.equal(parsed.issue!.code, "malformed_json", text);
    assert.equal(parsed.value, undefined, text);
    assert.equal(parsed.rawText, undefined, text);
  }
});

test("parseDelivery: plain prose (even inside an untyped unclosed fence) stays rawText", () => {
  for (const text of [
    "I finished the task. All tests pass.",
    "```\nHere is my free-form report.\n",
    "```text\nstep one done, step two pending",
  ]) {
    const parsed = parseDelivery(text);
    assert.equal(parsed.value, undefined, text);
    assert.equal(parsed.issue, undefined, text);
    assert.equal(parsed.rawText, text, text);
  }
});

test("parseDelivery: ordinary prose becomes rawText", () => {
  const parsed = parseDelivery("I finished the task. All tests pass.");
  assert.equal(parsed.value, undefined);
  assert.match(parsed.rawText ?? "", /finished the task/);
});

test("parseDelivery: malformed JSON-looking data yields an issue, not a silent fix", () => {
  for (const text of ['{"summary":', "[1,2,3]", '"just a string"', "```json\n{oops}\n```"]) {
    const parsed = parseDelivery(text);
    assert.ok(parsed.issue, text);
    assert.ok(parsed.issue!.path.length >= 0);
    assert.ok(parsed.issue!.code.length > 0);
    assert.equal(parsed.value, undefined);
  }
});

test("parseDelivery enforces the 1 MiB limit", () => {
  const big = `{"summary":"${"x".repeat(1024 * 1024 + 64)}"}`;
  const parsed = parseDelivery(big);
  assert.ok(parsed.issue);
  assert.match(parsed.issue!.code, /large|limit/i);
  assert.match(parsed.issue!.message, /1048576-byte limit \(\d+ bytes\)/); // explicit original byte count
});

// ---------------------------------------------------------------------------
// checkDelivery
// ---------------------------------------------------------------------------

test("checkDelivery: all-empty delivery is skipped, never passed", async (t) => {
  const cwd = await tmpWorkspace(t);
  const checks = await checkDelivery({ summary: "", inputs: {}, changes: [], artifacts: [null, ""] }, { cwd });
  assert.equal(checks.status, "skipped");
  assert.equal(checks.checked, 0);
  assert.deepEqual(checks.issues, []);
  assert.ok(checks.reason);
});

test("checkDelivery: 0/false are real, empty containers do not increment checked", async (t) => {
  const cwd = await tmpWorkspace(t);
  const checks = await checkDelivery({ flags: { retry: false, attempts: 0 }, note: "ok" }, { cwd });
  assert.equal(checks.status, "skipped");
  assert.equal(checks.checked, 0); // no schema, no files: nothing checkable

  const schema = {
    type: "object",
    properties: {
      flags: { type: "object", properties: { retry: { type: "boolean" }, attempts: { type: "number" } } },
    },
  };
  const withSchema = await checkDelivery({ flags: { retry: false, attempts: 0 } }, { cwd, schema });
  assert.equal(withSchema.status, "passed");
  assert.equal(withSchema.checked, 4); // Root and flags types plus two populated leaves.
});

test("checkDelivery: schema type failure fails with path + code", async (t) => {
  const cwd = await tmpWorkspace(t);
  const schema = {
    type: "object",
    properties: { attempts: { type: "number" } },
  };
  const checks = await checkDelivery({ attempts: "three" }, { cwd, schema });
  assert.equal(checks.status, "failed");
  assert.equal(checks.issues.length, 1);
  assert.equal(checks.issues[0]!.path, "attempts");
  assert.match(checks.issues[0]!.code, /type/i);
});

test("checkDelivery: custom schema renamed fields are honored", async (t) => {
  const cwd = await tmpWorkspace(t);
  const schema = {
    type: "object",
    properties: { deliverable_path: { type: "string" } },
  };
  const ok = await checkDelivery({ deliverable_path: "out/thing.txt" }, { cwd, schema });
  assert.equal(ok.status, "passed");

  const bad = await checkDelivery({ deliverable_path: 42 }, { cwd, schema });
  assert.equal(bad.status, "failed");
});

test("checkDelivery: x-file string field must exist as regular file in workspace", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "notes.md"), "hello");
  const schema = { type: "object", properties: { report: { type: "string", "x-file": true } } };

  const ok = await checkDelivery({ report: "notes.md" }, { cwd, schema });
  assert.equal(ok.status, "passed");
  // Root object type + leaf type + file existence were all meaningfully checked.
  assert.ok(ok.checked >= 3);

  const missing = await checkDelivery({ report: "absent.md" }, { cwd, schema });
  assert.equal(missing.status, "failed");
  assert.match(missing.issues[0]!.code, /missing|not_found/i);
  assert.equal(missing.issues[0]!.path, "report");

  const wrongType = await checkDelivery({ report: 42 }, { cwd, schema });
  assert.equal(wrongType.status, "failed");
  assert.match(wrongType.issues[0]!.code, /type|file_field/i);

  // Empty x-file value is skipped like any other empty field.
  const empty = await checkDelivery({ report: "" }, { cwd, schema });
  assert.equal(empty.status, "skipped");
});

test("checkDelivery: {file:string} objects anywhere are checked, nested flexibly", async (t) => {
  const cwd = await tmpWorkspace(t);
  await mkdir(path.join(cwd, "out"), { recursive: true });
  await writeFile(path.join(cwd, "out", "deck.pptx"), "fake");

  const ok = await checkDelivery(
    { steps: [{ name: "render", output: { format: "pptx", file: "out/deck.pptx" } }] },
    { cwd },
  );
  assert.equal(ok.status, "passed");
  assert.equal(ok.checked, 1);

  const missing = await checkDelivery(
    { steps: [{ name: "render", output: { file: "out/missing.pptx" } }] },
    { cwd },
  );
  assert.equal(missing.status, "failed");
  assert.equal(missing.issues[0]!.path, "steps.0.output.file");
  assert.match(missing.issues[0]!.code, /missing|not_found/i);
});

test("checkDelivery: arbitrary path-looking strings are never guessed as files", async (t) => {
  const cwd = await tmpWorkspace(t);
  const checks = await checkDelivery(
    { notes: "see /etc/passwd, docs/readme.md and C:\\Windows for details" },
    { cwd },
  );
  assert.equal(checks.status, "skipped");
  assert.deepEqual(checks.issues, []);
});

test("checkDelivery: line locations valid / out-of-range / ordering / partial", async (t) => {
  const cwd = await tmpWorkspace(t);
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(path.join(cwd, "a.txt"), body);
  const base = { file: "a.txt" };

  const valid = await checkDelivery({ c: [{ ...base, locations: [{ startLine: 2, endLine: 3 }] }] }, { cwd });
  assert.equal(valid.status, "passed");

  const beyond = await checkDelivery({ c: [{ ...base, locations: [{ startLine: 11 }] }] }, { cwd });
  assert.equal(beyond.status, "failed");
  assert.match(beyond.issues[0]!.code, /range|line/i);

  const unordered = await checkDelivery({ c: [{ ...base, locations: [{ startLine: 3, endLine: 2 }] }] }, { cwd });
  assert.equal(unordered.status, "failed");
  assert.match(unordered.issues[0]!.code, /order/i);

  const invalid = await checkDelivery({ c: [{ ...base, locations: [{ startLine: 0 }, { startLine: 1.5 }] }] }, { cwd });
  assert.equal(invalid.status, "failed");
  assert.match(invalid.issues[0]!.code, /locator|integer/i);

  const partial = await checkDelivery({ c: [{ ...base, locations: [{ endLine: 5 }] }] }, { cwd });
  assert.equal(partial.status, "passed");

  const beyondEndOnly = await checkDelivery({ c: [{ ...base, locations: [{ endLine: 99 }] }] }, { cwd });
  assert.equal(beyondEndOnly.status, "failed");
});

test("checkDelivery: binary files pass stats-only checks but fail locator checks", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "movie.mp4"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));

  const statsOnly = await checkDelivery({ artifact: { file: "movie.mp4" } }, { cwd });
  assert.equal(statsOnly.status, "passed");

  const withLocations = await checkDelivery(
    { artifact: { file: "movie.mp4", locations: [{ startLine: 1 }] } },
    { cwd },
  );
  assert.equal(withLocations.status, "failed");
  assert.match(withLocations.issues[0]!.code, /binary/i);
});

test("checkDelivery: symlinks escaping the workspace produce issues, not expanded access", async (t) => {
  const cwd = await tmpWorkspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), "pd-delivery-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await writeFile(path.join(outside, "inner.txt"), "inner");
  await symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
  await symlink(outside, path.join(cwd, "out-dir"));

  const fileLink = await checkDelivery({ att: { file: "link.txt" } }, { cwd });
  assert.equal(fileLink.status, "failed");
  assert.match(fileLink.issues[0]!.code, /outside|workspace/i);

  const dirLink = await checkDelivery({ att: { file: "out-dir/inner.txt" } }, { cwd });
  assert.equal(dirLink.status, "failed");
  assert.match(dirLink.issues[0]!.code, /outside|workspace/i);

  // Internal symlink to an internal file is fine.
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(path.join(cwd, "docs", "real.txt"), "real");
  await symlink(path.join("docs", "real.txt"), path.join(cwd, "alias.txt"));
  const internal = await checkDelivery({ att: { file: "alias.txt" } }, { cwd });
  assert.equal(internal.status, "passed");
});

test("checkDelivery: a file declaration cannot bypass existence using an arbitrary deletion flag", async (t) => {
  const cwd = await tmpWorkspace(t);
  const checks = await checkDelivery(
    { changes: [{ file: "gone.txt", op: "delete" }, { file: "also-gone.txt", deleted: true }] },
    { cwd },
  );
  assert.equal(checks.status, "failed");
});

test("checkDelivery: aborted signal yields error status", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "x");
  const controller = new AbortController();
  controller.abort();
  const checks = await checkDelivery({ f: { file: "a.txt" } }, { cwd, signal: controller.signal });
  assert.equal(checks.status, "error");
  assert.match(checks.reason ?? "", /abort/i);
});

test("checkDelivery: no schema means no type policing", async (t) => {
  const cwd = await tmpWorkspace(t);
  const checks = await checkDelivery({ anything: { deep: [1, 2, 3] } }, { cwd });
  assert.equal(checks.status, "skipped");
  assert.equal(checks.checked, 0);
});


test("checkDelivery: excessive nesting is unverified, not silently skipped", async t => {
  const cwd = await tmpWorkspace(t);
  let value: unknown = { file: "missing.txt" };
  for (let i = 0; i < 64; i++) value = { nested: value };
  assert.equal((await checkDelivery(value, { cwd })).status, "failed");
});

test("checkDelivery: omitted and empty locations are skipped", async t => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "a.txt"), "line");
  for (const locations of ["", null, [{}], [{ startLine: null }]]) {
    const result = await checkDelivery({ file: "a.txt", locations }, { cwd });
    assert.equal(result.status, "passed");
    assert.equal(result.checked, 1);
  }
});

test("checkDelivery: x-file schema and generic {file} walk dedupe to one resolution per field", async (t) => {
  const cwd = await tmpWorkspace(t);
  const schema = {
    type: "object",
    properties: {
      result: { type: "object", properties: { file: { type: "string", "x-file": true } } },
    },
  };

  // The same result.file field is visited by both walkers; exactly one
  // missing-file issue may be reported.
  const missing = await checkDelivery({ result: { file: "absent.md" } }, { cwd, schema });
  assert.equal(missing.status, "failed");
  assert.equal(missing.issues.length, 1);
  assert.equal(missing.issues[0]!.code, "file_missing");
  assert.equal(missing.issues[0]!.path, "result.file");

  // Generic location validation stays active even when the resolution is deduped.
  await writeFile(
    path.join(cwd, "a.txt"),
    Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  const outOfRange = await checkDelivery(
    { result: { file: "a.txt", locations: [{ startLine: 99 }] } },
    { cwd, schema },
  );
  assert.equal(outOfRange.status, "failed");
  assert.equal(outOfRange.issues.length, 1);
  assert.equal(outOfRange.issues[0]!.path, "result.file.locations.0.startLine");
  assert.match(outOfRange.issues[0]!.code, /range|line/i);

  const ok = await checkDelivery(
    { result: { file: "a.txt", locations: [{ startLine: 2, endLine: 3 }] } },
    { cwd, schema },
  );
  assert.equal(ok.status, "passed");
  assert.deepEqual(ok.issues, []);
});
