import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createCronManager } from "../../src/cron/index.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import { createProjectId } from "../../src/pilot/paths.js";
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
    const project = join(home, "workspace");
    await mkdir(project);
    const projectRecord = join(home, "projects", createProjectId(project));
    await mkdir(projectRecord, { recursive: true });
    await writeFile(join(projectRecord, ".cwd"), project);
    const configPath = join(home, "pilotdeck.yaml");
    await writeFile(configPath, BASE + yaml);
    await mkdir(join(home, "skills"));
    const env = { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath };
    const config = loadPilotConfig({ env }).config.cron;
    assert.ok(config);
    const cron = createCronManager({ config, pilotHome: home });
    const requests: CanonicalModelRequest[] = [];
    const schedule = { type: "once" as const, runAt: new Date(Date.now() + 86_400_000).toISOString() };
    const weekly = { type: "calendar", times: ["10:00", "15:30"], weekdays: [1, 3], timezone: "Asia/Shanghai" };
    const creationAttempts = [
      { id: "absolute", message: "Agent reminder", schedule },
      { id: "monthly-weekday", message: "Monthly weekday task", schedule: {
        type: "monthly", ordinal: 1, weekday: 1, hour: 9, minute: 0, timezone: "UTC",
      } },
      { id: "partial-minute", message: "Partial-minute interval", schedule: { type: "interval", everySeconds: 90 } },
      { id: "whole-minute", message: "Whole-minute interval", schedule: { type: "interval", everySeconds: 120 } },
      { id: "delay", message: "Ten-minute delay", schedule: { type: "delay", amount: 10, unit: "minute" } },
      { id: "calendar", message: "Weekly walks", schedule: weekly },
    ];
    const local = createLocalGateway({
      pilotHome: home,
      projectRoot: project,
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
              for (const { id, ...input } of creationAttempts) {
                yield { type: "tool_call_start", id, name: "cron_create" };
                yield { type: "tool_call_end", toolCall: { id, name: "cron_create", input } };
              }
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
      const input = { projectKey: project, message: "Manual reminder", channelKey: "web" as const, schedule };
      if (enabled) {
        const { task } = await local.gateway.cronCreate(input);
        assert.equal(task.message, input.message);
        assert.equal(task.status, "scheduled");
      } else {
        await assert.rejects(local.gateway.cronCreate(input), /Cron is disabled/);
      }

      const events = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: project,
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
      const { tasks } = await local.gateway.cronList({ projectKey: project });
      assert.deepEqual(tasks.map(task => task.message).sort(), enabled
        ? ["Agent reminder", "Manual reminder", "Ten-minute delay", "Weekly walks", "Whole-minute interval"] : []);
      if (enabled) {
        assert.equal(tasks.find(task => task.message === "Agent reminder")?.originSessionKey, "web:cron-defaults");
        const createTool = requests[0]?.tools?.find(tool => tool.name === "cron_create");
        const properties = createTool?.inputSchema.properties as {
          schedule: { anyOf: Array<{ properties: { type: { const: string }; everySeconds?: { multipleOf: number } } }> };
        };
        const options = properties.schedule.anyOf;
        assert.deepEqual(options.map(option => option.properties.type.const).sort(), ["calendar", "cron", "delay", "interval", "once"]);
        assert.equal(options.find(option => option.properties.type.const === "interval")?.properties.everySeconds?.multipleOf, 60);
        const rejected = events.flatMap(event => event.type === "tool_call_finished" && !event.ok ? [event.resultPreview ?? ""] : []);
        assert.equal(rejected.length, 2);
        assert.ok(rejected.some(message => /monthly weekday rules/.test(message)));
        assert.ok(rejected.some(message => /whole minutes/.test(message)));
        const delayed = tasks.find(task => task.message === "Ten-minute delay");
        assert.ok(delayed?.schedule.type === "once");
        assert.equal(Date.parse(delayed.schedule.runAt) - Date.parse(delayed.createdAt), 600_000);
        assert.deepEqual(tasks.find(task => task.message === "Weekly walks")?.schedule, weekly);
      }
    } finally {
      await cron.stop();
      local.dispose();
    }
  });
}
