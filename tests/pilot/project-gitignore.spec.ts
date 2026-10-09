import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePilotProjectGitIgnore } from "../../src/pilot/paths.js";
import { runRepositoryOperation } from "../../src/session/checkpoints/repositoryOperation.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { createPlanFileManager } from "../../src/tool/builtin/planFile.js";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd })).stdout.trim();

async function writeInternalFiles(project: string) {
  await mkdir(join(project, ".pilotdeck", "tool-results"), { recursive: true });
  await writeFile(join(project, ".pilotdeck", "tool-results", "cache.txt"), "cache");
  await writeFile(join(project, "result.txt"), "deliverable");
}

test("PD Git Init repairs an existing internal directory without changing root ignore rules", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gitignore-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeInternalFiles(root);
  await writeFile(join(root, ".gitignore"), "custom-cache/\n");
  await runRepositoryOperation(root, { operation: "init" });
  assert.equal(await git(root, "status", "--short", "--untracked-files=all"), "?? .gitignore\n?? result.txt");
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "custom-cache/\n");
  await git(root, "add", ".");
  assert.equal(await git(root, "ls-files"), ".gitignore\nresult.txt");
});

test("a session in an externally cloned repository ignores internal data and its ignore file", async t => {
  const base = await mkdtemp(join(tmpdir(), "pilotdeck-gitignore-clone-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await git(base, "init", "--bare", "remote.git");
  await git(base, "clone", join(base, "remote.git"), "clone");
  const root = join(base, "clone");
  createAgentProjectSessionStorage({ projectRoot: root, pilotHome: join(base, "home"), sessionId: "web:clone" });
  await writeInternalFiles(root);
  assert.equal(await git(root, "status", "--short", "--untracked-files=all"), "?? result.txt");
  const rules = await git(root, "check-ignore", ".pilotdeck/.gitignore", ".pilotdeck/tool-results/cache.txt");
  assert.equal(rules, ".pilotdeck/.gitignore\n.pilotdeck/tool-results/cache.txt");
});

test("internal plan data stays ignored when Git is initialized later in an ancestor", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gitignore-later-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "nested-project");
  await mkdir(project);
  const plans = createPlanFileManager({ projectRoot: project, pilotHome: join(root, "home") });
  await writeFile(join(plans.getPlanDirectoryPath(), "plan.md"), "internal plan");
  await writeFile(join(project, "result.txt"), "deliverable");
  await git(root, "init");
  assert.equal(await git(root, "status", "--short", "--untracked-files=all"), "?? nested-project/result.txt");
});

test("repair preserves existing rules, is idempotent, and leaves tracked internal files visible", async t => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-gitignore-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeInternalFiles(root);
  await git(root, "init");
  await git(root, "add", ".pilotdeck/tool-results/cache.txt");
  const ignore = join(root, ".pilotdeck", ".gitignore");
  await writeFile(ignore, "# existing rules\r\n*.tmp\r\n!keep.txt");
  ensurePilotProjectGitIgnore(root);
  const repaired = await readFile(ignore, "utf8");
  assert.ok(repaired.startsWith("# existing rules\r\n*.tmp\r\n!keep.txt\n"));
  ensurePilotProjectGitIgnore(root);
  assert.equal(await readFile(ignore, "utf8"), repaired);
  assert.equal(await git(root, "status", "--short", "--untracked-files=all"), "A  .pilotdeck/tool-results/cache.txt\n?? result.txt");
});
