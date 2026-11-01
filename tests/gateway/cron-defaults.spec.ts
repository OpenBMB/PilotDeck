import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createCronManager } from "../../src/cron/index.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";

const BASE = `
schemaVersion: 1
agent:
  model: test/model
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        model: {}
extension:
  builtinPluginsEnabled:
    windows-skills: false
    browser-use: false
    funasr: false
telemetry:
  enabled: false
`;

for (const [name, yaml, enabled] of [
  ["missing Cron section", "", true],
  ["bare Cron section", "cron:\n", true],
  ["explicitly disabled Cron", "cron: { enabled: false }\n", false],
] as const) {
  test(`${name}: Gateway creation and agent Cron tools agree`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "pilotdeck-cron-defaults-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const configPath = join(home, "pilotdeck.yaml");
    await writeFile(configPath, BASE + yaml);
    await mkdir(join(home, "skills"));
    const env = { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath };
    const config = loadPilotConfig({ env }).config.cron;
    assert.ok(config);
    const cron = createCronManager({ config, pilotHome: home });
    const requests: CanonicalModelRequest[] = [];
    const schedule = { type: "once" as const, runAt: new Date(Date.now() + 86_400_000).toISOString() };
    const local = createLocalGateway({
      pilotHome: home,
      projectRoot: home,
      builtinSkillsRoot: join(home, "skills"),
      env,
      cron,
      extraTools: cron.getTools(),
      __testModelFactory(snapshot) {
        return {
          ...createModelRuntime(snapshot.config.model),
          async *stream(request): AsyncIterable<CanonicalModelEvent> {
            requests.push(request);
            yield { type: "message_start", role: "assistant" };
            if (enabled && requests.length === 1) {
              yield { type: "tool_call_start", id: "create-reminder", name: "cron_create" };
              yield {
                type: "tool_call_end",
                toolCall: { id: "create-reminder", name: "cron_create", input: { message: "Agent reminder", schedule } },
              };
              yield { type: "message_end", finishReason: "tool_call" };
            } else {
              yield { type: "text_delta", text: "Done" };
              yield { type: "message_end", finishReason: "stop" };
            }
          },
          async complete() {
            return { role: "assistant" as const, content: [{ type: "text" as const, text: "Reminder" }], finishReason: "stop" as const };
          },
        };
      },
    });
    try {
      cron.bindGateway(local.gateway);
      await cron.start();
      const input = { projectKey: home, message: "Manual reminder", channelKey: "web" as const, schedule };
      if (enabled) {
        const { task } = await local.gateway.cronCreate(input);
        assert.equal(task.message, input.message);
        assert.equal(task.status, "scheduled");
      } else {
        await assert.rejects(local.gateway.cronCreate(input), /Cron is disabled/);
      }

      const events = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: home,
        sessionKey: "web:cron-defaults",
        channelKey: "web",
        message: "Create a reminder for tomorrow",
        mode: "bypassPermissions",
        canPrompt: false,
      })) events.push(event);
      assert.deepEqual(events.filter(event => event.type === "error"), []);
      assert.ok(events.some(event => event.type === "turn_completed" && event.finishReason === "completed"));
      for (const name of ["cron_create", "cron_list", "cron_delete", "cron_stop"]) {
        assert.equal(requests[0]?.tools?.some(tool => tool.name === name), enabled, name);
      }
      const { tasks } = await local.gateway.cronList({ projectKey: home });
      assert.deepEqual(tasks.map(task => task.message).sort(), enabled ? ["Agent reminder", "Manual reminder"] : []);
      if (enabled) {
        assert.equal(tasks.find(task => task.message === "Agent reminder")?.originSessionKey, "web:cron-defaults");
      }
    } finally {
      await cron.stop();
      local.dispose();
    }
  });
}
