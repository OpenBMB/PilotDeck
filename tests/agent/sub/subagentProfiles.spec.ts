import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SUBAGENT_DEPTH,
  formatSubagentCatalog,
  parseSubagentProfiles,
  resolveSubagentProfiles,
} from "../../../src/agent/sub/subagentProfiles.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";

test("MAX_SUBAGENT_DEPTH is 5", () => {
  assert.equal(MAX_SUBAGENT_DEPTH, 5);
});

test("parseSubagentProfiles returns undefined for omitted config", () => {
  assert.equal(parseSubagentProfiles(undefined), undefined);
  assert.equal(parseSubagentProfiles(null), undefined);
});

test("parseSubagentProfiles normalizes a valid profile table", () => {
  const parsed = parseSubagentProfiles({
    vision: {
      description: "Read image files and report visual details.",
      model: "zhipu/glm-5.3-flash",
      tools: ["read_file"],
      readOnly: true,
      enabled: true,
    },
    consultant: {
      description: "Analyze difficult questions.",
      model: "inherit",
    },
  });
  assert.deepEqual(parsed, {
    vision: {
      description: "Read image files and report visual details.",
      model: "zhipu/glm-5.3-flash",
      tools: ["read_file"],
      readOnly: true,
      enabled: true,
    },
    consultant: {
      description: "Analyze difficult questions.",
      model: "inherit",
    },
  });
});

test("parseSubagentProfiles throws readable errors that include the config path", () => {
  const cases: Array<[unknown, RegExp]> = [
    ["nope", /agent\.subagents\.profiles must be an object/],
    [["vision"], /agent\.subagents\.profiles must be an object/],
    [{ Vision: { description: "x" } }, /agent\.subagents\.profiles\.Vision[\s\S]*lowercase/],
    [{ "": { description: "x" } }, /agent\.subagents\.profiles/],
    [{ ["a".repeat(65)]: { description: "x" } }, /agent\.subagents\.profiles/],
    [{ general_purpose: { description: "x" } }, /general_purpose/],
    [{ explorer: { description: "x" } }, /explorer.*explore/],
    [{ constructor: { description: "x" } }, /agent\.subagents\.profiles\.constructor/],
    [{ vision: "nope" }, /agent\.subagents\.profiles\.vision must be an object/],
    [{
      vision: { description: "x", extra: true },
    }, /agent\.subagents\.profiles\.vision\.extra/],
    [{ vision: { description: "   " } }, /agent\.subagents\.profiles\.vision\.description/],
    [{ vision: {} }, /agent\.subagents\.profiles\.vision\.description/],
    [{ vision: { description: "y".repeat(2001) } }, /2000/],
    [{ vision: { description: "x", model: "   " } }, /\.model/],
    [{ vision: { description: "x", model: "no-slash" } }, /\.model[\s\S]*provider\/model/],
    [{ vision: { description: "x", model: "/leading" } }, /\.model/],
    [{ vision: { description: "x", model: "zhipu/glm 5" } }, /\.model/],
    [{ vision: { description: "x", tools: "read_file" } }, /\.tools must be an array/],
    [{ vision: { description: "x", tools: ["read_file", "  "] } }, /\.tools/],
    [{ vision: { description: "x", tools: [42] } }, /\.tools/],
    [{ vision: { description: "x", tools: ["read_file", "read_file"] } }, /duplicate/],
    [{ vision: { description: "x", readOnly: "yes" } }, /\.readOnly must be a boolean/],
    [{ vision: { description: "x", enabled: "yes" } }, /\.enabled must be a boolean/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => parseSubagentProfiles(value), pattern, JSON.stringify(value));
  }
});

test("parseSubagentProfiles rejects unsafe builtin permission widening", () => {
  assert.throws(
    () => parseSubagentProfiles({ explore: { description: "x", readOnly: false } }),
    /explore[\s\S]*read-only/,
  );
  assert.throws(
    () => parseSubagentProfiles({ plan: { description: "x", tools: ["read_file", "write_file"] } }),
    /plan[\s\S]*write_file/,
  );
  // Narrowing plus explicit agent for nested dispatch is allowed.
  assert.deepEqual(
    parseSubagentProfiles({ explore: { description: "x", tools: ["read_file", "agent"] } }),
    { explore: { description: "x", tools: ["read_file", "agent"] } },
  );
  // general-purpose may pick an arbitrary tool list.
  assert.deepEqual(
    parseSubagentProfiles({ "general-purpose": { description: "x", tools: ["bash"] } }),
    { "general-purpose": { description: "x", tools: ["bash"] } },
  );
});

test("resolveSubagentProfiles without config returns all enabled builtins", () => {
  const resolved = resolveSubagentProfiles();
  assert.deepEqual(resolved.map((profile) => profile.id), [
    "general-purpose",
    "explore",
    "plan",
    "verify",
  ]);
  for (const profile of resolved) {
    assert.equal(profile.enabled, true);
    assert.equal(profile.builtIn, true);
    assert.equal(profile.model, undefined);
  }
  assert.deepEqual(
    resolved.find((profile) => profile.id === "explore")?.allowedTools,
    SUBAGENT_DEFINITIONS.explore.allowedTools,
  );
});

test("resolveSubagentProfiles merges builtin overrides and appends customs in stable order", () => {
  const profiles = parseSubagentProfiles({
    explore: { description: "Fast file finder.", enabled: false },
    vision: { description: "Vision reviewer.", model: "zhipu/glm-5.3-flash", tools: ["read_file"] },
    consultant: { description: "Consultant." },
  });
  const resolved = resolveSubagentProfiles(profiles);
  assert.deepEqual(resolved.map((profile) => profile.id), [
    "general-purpose",
    "explore",
    "plan",
    "verify",
    "vision",
    "consultant",
  ]);
  const explore = resolved.find((profile) => profile.id === "explore");
  assert.equal(explore?.description, "Fast file finder.");
  assert.equal(explore?.enabled, false);
  assert.equal(explore?.isReadOnly, true, "builtin read-only preset cannot lose read-only");
  assert.deepEqual(explore?.allowedTools, SUBAGENT_DEFINITIONS.explore.allowedTools);

  const vision = resolved.find((profile) => profile.id === "vision");
  assert.equal(vision?.builtIn, false);
  assert.equal(vision?.enabled, true);
  assert.equal(vision?.model, "zhipu/glm-5.3-flash");
  assert.equal(vision?.isReadOnly, true, "custom profiles default to read-only");
  assert.deepEqual(vision?.allowedTools, ["read_file"]);

  const consultant = resolved.find((profile) => profile.id === "consultant");
  assert.equal(consultant?.model, undefined);
  assert.equal(consultant?.isReadOnly, true);
  assert.deepEqual(consultant?.allowedTools, ["read_file", "grep", "glob"]);
});

test("resolveSubagentProfiles normalizes inherit models and honors readOnly widening for customs", () => {
  const profiles = parseSubagentProfiles({
    consultant: { description: "Consultant.", model: "inherit", readOnly: false },
  });
  const resolved = resolveSubagentProfiles(profiles);
  const consultant = resolved.find((profile) => profile.id === "consultant");
  assert.equal(consultant?.model, undefined);
  assert.equal(consultant?.isReadOnly, false);
});

test("formatSubagentCatalog lists enabled profiles with ids and descriptions only", () => {
  const profiles = parseSubagentProfiles({
    explore: { description: "Disabled explore.", enabled: false },
    vision: { description: "Vision reviewer.", model: "zhipu/glm-5.3-flash" },
  });
  const catalog = formatSubagentCatalog(resolveSubagentProfiles(profiles));
  assert.match(catalog, /- general-purpose: /);
  assert.match(catalog, /- vision: Vision reviewer\./);
  assert.match(catalog, /- plan: /);
  assert.match(catalog, /- verify: /);
  assert.doesNotMatch(catalog, /explore/);
  assert.doesNotMatch(catalog, /zhipu\/glm-5\.3-flash/);
  assert.doesNotMatch(catalog, /\bmodel\b/i);
});

test("formatSubagentCatalog returns an empty string when no profile is enabled", () => {
  const profiles = parseSubagentProfiles({
    "general-purpose": { description: "off", enabled: false },
    explore: { description: "off", enabled: false },
    plan: { description: "off", enabled: false },
    verify: { description: "off", enabled: false },
  });
  assert.equal(formatSubagentCatalog(resolveSubagentProfiles(profiles)), "");
});
