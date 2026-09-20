import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(process.cwd(), "src");

test("core AgentLoop and module transport remain independent of composition owners", async () => {
  const coreFiles = [
    join(ROOT, "agent", "loop", "AgentLoop.ts"),
    join(ROOT, "agent", "loop", "AgentLoopRuntimeFactory.ts"),
    join(ROOT, "agent", "loop", "AgentTurnCapabilities.ts"),
    join(ROOT, "agent", "modules"),
  ];
  const files = await collectTypeScriptFiles(coreFiles);
  const forbidden = /(?:[\\/]composition[\\/]|staffdeck|StaffDeck|KnowledgeModule|SkillManager)/u;
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (forbidden.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, [], "core dependency boundary was crossed");
});

test("composition owns external binding selection while SOP stays a decorator", async () => {
  const runtimePorts = await readFile(join(ROOT, "composition", "runtimePorts.ts"), "utf8");
  const sessionBundle = await readFile(join(ROOT, "agent", "session", "AgentSessionRuntimeBundle.ts"), "utf8");
  const sopLoop = await readFile(join(ROOT, "sop", "staffdeck", "SopAgentLoop.ts"), "utf8");

  assert.match(runtimePorts, /createHostModelInvokerPort/u);
  assert.match(runtimePorts, /createHostCapabilityToolPort/u);
  assert.match(runtimePorts, /createHostContextRuntime/u);
  assert.match(sessionBundle, /createRuntimeModulePorts/u);
  assert.match(sessionBundle, /composeToolPorts/u);
  assert.match(sopLoop, /runnerFactory/u);
  assert.match(sopLoop, /wrapSidecarModules/u);
  assert.doesNotMatch(runtimePorts, /SopAgentLoop|StaffDeckSop/u);
});

async function collectTypeScriptFiles(paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    if (path.endsWith(".ts")) {
      files.push(path);
      continue;
    }
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) files.push(...await collectTypeScriptFiles([child]));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(child);
    }
  }
  return files;
}
