#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";
const fixtureRoot = await mkdtemp(join(tmpdir(), "pilotdeck-skill-b0-differential-"));
const FIXED_MTIME = 1_700_000_000_000;

try {
  const b0Module = await import(pathToFileURL(join(b0Root, "dist/src/extension/skills/SkillManager.js")).href);
  const candidateModule = await import(pathToFileURL(join(candidateRoot, "dist/src/extension/skills/SkillManager.js")).href);
  const b0Fixture = await createFixture(join(fixtureRoot, "b0"));
  const candidateFixture = await createFixture(join(fixtureRoot, "candidate"));
  const b0Manager = new b0Module.SkillManager(b0Fixture.options);
  const candidateManager = new candidateModule.SkillManager(candidateFixture.options);

  const cases = [
    { name: "list-all", invoke: (manager, fixture) => manager.list({ projectKey: fixture.projectRoot }) },
    { name: "list-general-chat", invoke: (manager, fixture) => manager.list({ projectKey: fixture.pilotHome }) },
    { name: "list-builtin", invoke: (manager) => manager.list({ scope: "builtin" }) },
    { name: "list-query", invoke: (manager, fixture) => manager.list({ projectKey: fixture.projectRoot, query: "shared", limit: 1 }) },
    {
      name: "list-pagination",
      invoke: async (manager, fixture) => {
        const first = await manager.list({ projectKey: fixture.projectRoot, limit: 1 });
        const second = first.nextCursor
          ? await manager.list({ projectKey: fixture.projectRoot, limit: 1, cursor: first.nextCursor })
          : null;
        return { first, second };
      },
    },
    { name: "read-builtin", invoke: (manager) => manager.read({ scope: "builtin", slug: "shared" }) },
    { name: "read-project", invoke: (manager, fixture) => manager.read({ scope: "project", slug: "shared", projectKey: fixture.projectRoot }) },
    { name: "validate", invoke: (manager, fixture) => manager.validate({ sourcePath: join(fixture.projectRoot, ".pilotdeck", "skills", "project-only") }) },
    { name: "scan", invoke: (manager, fixture) => manager.scan({ parentPath: join(fixture.projectRoot, ".pilotdeck", "skills") }) },
    {
      name: "write-create-delete",
      invoke: async (manager, fixture) => {
        const created = await manager.create({ scope: "project", slug: "differential", projectKey: fixture.projectRoot, name: "Differential" });
        const written = await manager.write({ scope: "project", slug: "differential", projectKey: fixture.projectRoot, content: "---\nname: differential\ndescription: generated\n---\n\n# Generated\n" });
        const deleted = await manager.delete({ scope: "project", slug: "differential", projectKey: fixture.projectRoot });
        return { created, written, deleted };
      },
    },
    {
      name: "write-refresh-read",
      invoke: async (manager, fixture) => {
        const written = await manager.write({
          scope: "project",
          slug: "project-only",
          projectKey: fixture.projectRoot,
          content: "---\nname: refreshed\ndescription: refreshed description\n---\n\n# Refreshed\n",
        });
        const listed = await manager.list({ projectKey: fixture.projectRoot, scope: "project" });
        const read = await manager.read({ scope: "project", slug: "project-only", projectKey: fixture.projectRoot });
        return { written, listed, read };
      },
    },
    {
      name: "validate-manifest",
      invoke: (manager) => manager.validate({
        skillMdContent: "---\nname: manifest\ndescription: checked\n---\n\n# Manifest\n",
        files: [
          { relativePath: "SKILL.md", size: 64 },
          { relativePath: "references/policy.md", size: 32 },
        ],
      }),
    },
    {
      name: "import-copy",
      invoke: (manager, fixture) => manager.import({
        scope: "project",
        projectKey: fixture.projectRoot,
        sourcePath: fixture.importSource,
        slug: "imported-skill",
        mode: "copy",
      }),
    },
    {
      name: "import-missing-error",
      invoke: async (manager, fixture) => {
        try {
          await manager.import({ scope: "project", projectKey: fixture.projectRoot, sourcePath: join(fixture.root, "missing-source") });
          return { ok: false };
        } catch (error) {
          return { ok: false, error: serializeError(error) };
        }
      },
    },
    {
      name: "invalid-input-error",
      invoke: async (manager) => {
        try {
          await manager.read({ scope: "project", slug: "../escape", projectKey: "/project" });
          return { ok: false };
        } catch (error) {
          return { ok: false, error: serializeError(error) };
        }
      },
    },
  ];

  const normalized = [];
  for (const testCase of cases) {
    const b0 = await runCase(testCase, b0Manager, b0Fixture);
    const candidate = await runCase(testCase, candidateManager, candidateFixture);
    const expected = normalize(b0, b0Fixture.root, candidateFixture.root);
    const actual = normalize(candidate, candidateFixture.root, candidateFixture.root);
    assert.deepEqual(actual, expected, `Skill differential mismatch in ${testCase.name}`);
    normalized.push({ name: testCase.name, result: actual });
  }

  const altered = structuredClone(normalized[0].result);
  if (altered && typeof altered === "object" && !Array.isArray(altered)) altered.sentinel = "changed";
  assert.notDeepEqual(altered, normalized[0].result, "comparator sensitivity fixture did not detect a changed field");
  process.stdout.write(JSON.stringify({
    status: "PASS",
    baseline: b0Root,
    candidate: candidateRoot,
    cases: normalized.map(({ name }) => name),
    compared: normalized.length,
  }, null, 2) + "\n");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function createFixture(root) {
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  const builtinRoot = join(root, "builtin");
  await writeSkill(builtinRoot, "shared", "Builtin shared");
  await writeSkill(builtinRoot, "builtin-only", "Builtin only");
  await writeSkill(join(pilotHome, "skills"), "shared", "User shared");
  await writeSkill(join(pilotHome, "skills"), "user-only", "User only");
  await writeSkill(join(projectRoot, ".pilotdeck", "skills"), "shared", "Project shared");
  await writeSkill(join(projectRoot, ".pilotdeck", "skills"), "project-only", "Project only");
  const importSource = join(root, "import-source");
  await writeSkill(importSource, "source-skill", "Imported source");
  await mkdir(join(importSource, "references"), { recursive: true });
  await writeFile(join(importSource, "references", "policy.md"), "# Imported policy\n", "utf8");
  return {
    root,
    pilotHome,
    projectRoot,
    importSource,
    options: { pilotHome, builtinSkillsRoot: builtinRoot },
  };
}

async function writeSkill(root, slug, description) {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  const skillFile = join(dir, "SKILL.md");
  await writeFile(skillFile, `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`, "utf8");
  // Keep independently-created baseline/candidate fixtures comparable while still checking mtime.
  await utimes(skillFile, 1_700_000_000, 1_700_000_000);
}

async function runCase(testCase, manager, fixture) {
  try {
    return { ok: true, value: await testCase.invoke(manager, fixture) };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

function normalize(value, fromRoot, toRoot) {
  if (typeof value === "string") {
    return value.replaceAll(fromRoot, toRoot);
  }
  return normalizeValue(value, fromRoot, toRoot);
}

function normalizeValue(value, fromRoot, toRoot, key) {
  // Filesystem timestamps are environment-dependent; retain and compare the field deterministically.
  if (key === "mtime" && typeof value === "number") return FIXED_MTIME;
  if (key === "nextCursor" && typeof value === "string") {
    return normalizeCursor(value, fromRoot, toRoot);
  }
  if (typeof value === "string") {
    return value.replaceAll(fromRoot, toRoot);
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, fromRoot, toRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [
      entryKey,
      normalizeValue(item, fromRoot, toRoot, entryKey),
    ]));
  }
  return value;
}

function normalizeCursor(cursor, fromRoot, toRoot) {
  try {
    const decoded = decodeBase64Json(cursor);
    const normalized = normalizeEncodedCursorObject(decoded, fromRoot, toRoot);
    return encodeBase64Json(normalized);
  } catch {
    return cursor.replaceAll(fromRoot, toRoot);
  }
}

function normalizeEncodedCursorObject(value, fromRoot, toRoot) {
  if (Array.isArray(value)) return value.map((item) => normalizeEncodedCursorObject(item, fromRoot, toRoot));
  if (!value || typeof value !== "object") return normalize(value, fromRoot, toRoot);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "signature" && typeof item === "string") {
      try {
        return [key, encodeBase64Json(normalizeEncodedCursorObject(decodeBase64Json(item), fromRoot, toRoot))];
      } catch {
        return [key, normalize(item, fromRoot, toRoot)];
      }
    }
    return [key, normalizeEncodedCursorObject(item, fromRoot, toRoot)];
  }));
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
