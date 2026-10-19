import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

const sop = { enabled: true, implementationId: "portable-sop", contract: "sop.lifecycle/v4", transport: "sop-http-v4",
  endpoint: "http://127.0.0.1:18991", credentialEnv: "TEST_SOP_TOKEN" };
test("v4 YAML rejects legacy fields and mismatched protocols; v3 remains independently parsed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-v4-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    const config = { schemaVersion: 1, agent: { model: "custom/test" }, model: { providers: { custom: {
      protocol: "openai", url: "https://example.com/v1", apiKey: "test", models: { test: {} } } } }, modules: { sop } };
    await writeFile(configPath, YAML.stringify(config));
    const loaded = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.equal(loaded.config.modules?.sop?.approval?.provider, "disabled");
    for (const invalid of [{ contextMode: "inherit" }, { transport: "sop-http-v3" }, { credentialEnv: "" }, { approval: { provider: "unknown" } },
      { localRuntime: { enabled: true, python: "/python", maxConcurrency: 0 } }]) {
      await writeFile(configPath, YAML.stringify({ ...config, modules: { sop: { ...sop, ...invalid } } }));
      assert.throws(() => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }));
    }
    await writeFile(configPath, YAML.stringify(config));
    assert.throws(() => createLocalGateway({ projectRoot: root, pilotHome: root,
      env: { PILOT_HOME: root, PILOTDECK_CONFIG_PATH: configPath } }), /credential/);
    assert.throws(() => createLocalGateway({ projectRoot: root, pilotHome: root,
      env: { PILOT_HOME: root, PILOTDECK_CONFIG_PATH: configPath, TEST_SOP_TOKEN: "test", PILOTDECK_SOP_V4_ENDPOINT: "http://127.0.0.1:1" } }), /conflict/);
    await writeFile(configPath, YAML.stringify({ ...config, modules: { sop: { enabled: false } } }));
    assert.equal(loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules?.sop, undefined);
    assert.throws(() => loadPilotConfig({ configPath, env: { PILOT_HOME: root,
      PILOTDECK_SOP_V4_ENDPOINT: sop.endpoint } }), /conflict/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed v4 host starts prepared runtime, probes storage and stops only its child", {
  skip: !process.env.SOP_RUNTIME_PYTHON,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-v4-managed-"));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const configPath = join(root, "pilotdeck.yaml");
  await writeFile(configPath, YAML.stringify({ schemaVersion: 1, agent: { model: "custom/test" },
    model: { providers: { custom: { protocol: "openai", url: "https://example.com/v1", apiKey: "test", models: { test: {} } } } },
    modules: { sop: { ...sop, endpoint, localRuntime: { enabled: true, python: process.env.SOP_RUNTIME_PYTHON,
      dataDirectory: join(root, "runtime"), maxConcurrency: 7 } } } }));
  const options = { projectRoot: root, pilotHome: root,
    env: { PILOT_HOME: root, PILOTDECK_CONFIG_PATH: configPath, TEST_SOP_TOKEN: "managed-test" } };
  const local = createLocalGateway(options);
  try {
    await local.ready;
    assert.equal((await (await fetch(endpoint + "/healthz")).json()).maxConcurrency, 7);
    assert.equal((await fetch(endpoint + "/v4/ready", { headers: { authorization: "Bearer managed-test" } })).status, 200);
    await assert.rejects(access(join(root, "auth.db")));
    const competing = createLocalGateway(options);
    try { await assert.rejects(competing.ready, /EADDRINUSE/); } finally { await competing.dispose(); }
    assert.equal((await fetch(endpoint + "/healthz")).status, 200);
  } finally { await local.dispose(); }
  try { await assert.rejects(fetch(endpoint + "/healthz")); }
  finally { await rm(root, { recursive: true, force: true }); }
});
