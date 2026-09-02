import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager } from "../../src/extension/skills/SkillManager.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("skill query preserves legacy groups and provides stable pagination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skills-query-"));
  const project = join(root, "project");
  const builtin = join(root, "builtin");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeSkill(join(builtin, "alpha"), "Alpha", "search target one"),
    writeSkill(join(root, "skills", "beta"), "Beta", "search target two"),
    writeSkill(join(project, ".pilotdeck", "skills", "gamma"), "Gamma", "search target three"),
  ]);
  const manager = new SkillManager({ pilotHome: root, builtinSkillsRoot: builtin });
  const first = await manager.list({ projectKey: project, query: "target", limit: 2 });
  const second = await manager.list({ projectKey: project, query: "target", limit: 2, cursor: first.nextCursor });
  assert.equal(first.builtin.length, 1);
  assert.equal(first.user.length, 1);
  assert.equal(first.project.length, 1);
  assert.deepEqual([...first.items, ...second.items].map((item) => item.command), ["/alpha", "/beta", "/gamma"]);
  assert.equal(first.items.every((item) => item.matches?.some((match) => match.field === "description")), true);
});

test("gateway rejects invalid permission modes before touching the session router", async () => {
  const gateway = new InProcessGateway({} as SessionRouter);
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "session", channelKey: "test", message: "hello",
    mode: "unsafe" as "default",
  })) events.push(event);
  assert.deepEqual(events, [{
    type: "error", code: "INVALID_PERMISSION_MODE", message: "Invalid mode: unsafe.", recoverable: true,
  }]);
});

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
}
