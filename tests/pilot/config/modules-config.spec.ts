import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { classifyConfigChanges } from "../../../src/pilot/config/classifyChanges.js";
import { createLocalGateway } from "../../../src/cli/createLocalGateway.js";

function configWithModules(modules: string): string {
  return `
schemaVersion: 1
agent:
  model: custom/model-a
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
${modules}
`;
}

test("loadPilotConfig resolves the StaffDeck SOP module profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: http://sop-runtime:8091
    definitionsPath: sops/definitions.yaml
    defaultSopId: onboarding
    timeoutMs: 5000
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.deepEqual(snapshot.config.modules?.agentLoop, { enabled: true, provider: "pilotdeck" });
    assert.deepEqual(snapshot.config.modules?.sop, {
      provider: "staffdeck",
      endpoint: "http://sop-runtime:8091",
      definitionsPath: join(root, "sops", "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: join(root, "sop"),
      timeoutMs: 5000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects unsupported module ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-invalid-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: false, provider: pilotdeck }
  sop:
    enabled: true
    provider: pilotdeck
    endpoint: http://sop-runtime:8091
    definitionsPath: definitions.yaml
    defaultSopId: onboarding
`));

    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
        (diagnostic) => diagnostic.code === "MODULE_PROVIDER_UNSUPPORTED" || diagnostic.code === "SOP_MODULE_PROVIDER_INVALID",
      ) === true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig disables StaffDeck SOP without loading a runtime profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-disabled-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop: { enabled: false, provider: staffdeck }
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.equal(snapshot.config.modules?.sop, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled Skill binding removes native Skill management fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-skill-module-disabled-"));
  const configPath = join(root, "pilotdeck.yaml");
  let local: ReturnType<typeof createLocalGateway> | undefined;
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  skills: { enabled: false }
`));
    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.deepEqual(snapshot.config.modules?.skills, { enabled: false });

    local = createLocalGateway({ projectRoot: root, pilotHome: root, fallbackProjectRoot: root });
    await assert.rejects(
      () => local!.gateway.skillsList!({ projectKey: root }),
      (error: unknown) => (error as { code?: string }).code === "SKILL_MODULE_DISABLED",
    );
  } finally {
    await local?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig accepts a disabled Knowledge binding without selecting a fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-knowledge-module-disabled-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  knowledge: { enabled: false }
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.deepEqual(snapshot.config.modules?.knowledge, { enabled: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig accepts an unregistered SOP implementation through the published contract", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-protocol-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    implementationId: example.approval
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: http://example-sop:8091
    manifestPath: /module-manifest
    definitionsPath: sops/definitions.yaml
    defaultSopId: onboarding
`));

    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.deepEqual(snapshot.config.modules?.sop, {
      implementationId: "example.approval",
      contract: "sop.lifecycle/v2",
      transport: "sop-http-v2",
      manifestPath: "/module-manifest",
      endpoint: "http://example-sop:8091",
      definitionsPath: join(root, "sops", "definitions.yaml"),
      defaultSopId: "onboarding",
      stateRoot: join(root, "sop"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig accepts unknown implementations for the published core contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-config-protocol-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  skills:
    enabled: true
    implementationId: example.skills
    contract: pilotdeck.skills/v1
    transport: module-http-v2
    endpoint: http://skills:9010
    methods: [list, read]
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: http://model:9011
    methods: [prepare, stream]
  tools:
    enabled: true
    implementationId: example.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: http://tools:9012
    methods: [execute]
    catalog:
      - name: example_lookup
        description: Lookup an example value.
        kind: custom
        inputSchema: { type: object }
        readOnly: true
        concurrencySafe: true
  context:
    enabled: true
    implementationId: example.context
    contract: pilotdeck.context/v1
    transport: module-http-v2
    endpoint: http://context:9013
    methods: [prepare_for_model, try_auto_compact]
  knowledge:
    enabled: true
    implementationId: example.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: http://knowledge:9014
    methods: [query]
`));
    const modules = loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules!;
    assert.equal("implementationId" in modules.modelProvider!, true);
    assert.equal("implementationId" in modules.tools!, true);
    assert.equal("implementationId" in modules.context!, true);
    assert.equal("implementationId" in modules.skills!, true);
    assert.equal("implementationId" in modules.knowledge!, true);
    assert.equal((modules.tools as { tools?: unknown[] }).tools?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects an incomplete external core profile instead of silently selecting native fallbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-core-required-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: loop
    port: 9010
    methods: [execute, cancel, resume, ack]
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: http://model:9011
    methods: [prepare, stream]
`));

    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => {
        const diagnostics = (error as { diagnostics?: Array<{ code: string; path?: string }> }).diagnostics ?? [];
        return ["modules.skills", "modules.tools", "modules.context", "modules.knowledge"].every((path) => diagnostics.some(
          (diagnostic) => diagnostic.code === "MODULE_CORE_BINDING_REQUIRED" && diagnostic.path === path,
        ));
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig allows an external AgentLoop profile with explicit native host slots", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-explicit-native-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: loop
    port: 9010
    methods: [execute, cancel, resume, ack]
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: http://model:9011
    methods: [prepare, stream]
  skills: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
  knowledge: { enabled: false }
`));

    const modules = loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules!;
    assert.equal("implementationId" in modules.agentLoop!, true);
    assert.equal("implementationId" in modules.modelProvider!, true);
    assert.deepEqual(modules.skills, { enabled: true, provider: "pilotdeck" });
    assert.deepEqual(modules.tools, { enabled: true, provider: "pilotdeck" });
    assert.deepEqual(modules.context, { enabled: true, provider: "pilotdeck" });
    assert.deepEqual(modules.knowledge, { enabled: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects an undeclared module state mode before runtime construction", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-state-mode-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: http://model:9011
    methods: [prepare, stream]
    stateMode: stateful
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    implementationId: example.sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: http://sop:9012
    definitionsPath: definitions.yaml
    defaultSopId: approval
    stateMode: stateful
`));

    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => {
        const diagnostics = (error as { diagnostics?: Array<{ code: string; path?: string }> }).diagnostics ?? [];
        return ["modules.modelProvider.stateMode", "modules.sop.stateMode"].every((path) => diagnostics.some(
          (diagnostic) => diagnostic.code === "MODULE_STATE_MODE_UNSUPPORTED" && diagnostic.path === path,
        ));
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig preserves generic deployment metadata for every external slot", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-deployment-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: loop.example
    port: 9010
    methods: [execute, cancel, status, resume, ack]
    deployment: { mode: image, image: example/loop:1, port: 19010, healthPath: /healthz }
  skills:
    enabled: true
    implementationId: example.skills
    contract: pilotdeck.skills/v1
    transport: module-http-v2
    endpoint: http://skills.example:9011
    methods: [list, read]
    deployment: { mode: build, context: ../skills, dockerfile: Dockerfile.skills, port: 19011 }
  tools:
    enabled: true
    implementationId: example.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: http://tools.example:9012
    methods: [execute]
    catalog:
      - name: lookup
        description: Lookup an example value.
        inputSchema: { type: object }
    deployment: { mode: external }
  context:
    enabled: true
    implementationId: example.context
    contract: pilotdeck.context/v1
    transport: module-http-v2
    endpoint: http://context.example:9013
    methods: [prepare_for_model, apply_tool_results, recover_from_model_error, capture_turn, try_auto_compact]
    deployment: { mode: external }
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: http://model.example:9014
    methods: [prepare, stream]
    deployment: { mode: image, image: example/model:1, port: 19014 }
  knowledge:
    enabled: true
    implementationId: example.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: http://knowledge.example:9015
    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]
    deployment: { mode: external }
`));

    const modules = loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules!;
    assert.deepEqual(modules.agentLoop && "deployment" in modules.agentLoop ? modules.agentLoop.deployment : undefined, {
      mode: "image",
      image: "example/loop:1",
      port: 19010,
      healthPath: "/healthz",
    });
    assert.deepEqual(modules.skills && "deployment" in modules.skills ? modules.skills.deployment : undefined, {
      mode: "build",
      context: "../skills",
      dockerfile: "Dockerfile.skills",
      port: 19011,
    });
    assert.deepEqual(modules.tools && "deployment" in modules.tools ? modules.tools.deployment : undefined, { mode: "external" });
    assert.deepEqual(modules.modelProvider && "deployment" in modules.modelProvider ? modules.modelProvider.deployment : undefined, {
      mode: "image",
      image: "example/model:1",
      port: 19014,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig preserves deployment metadata for an external SOP binding", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-deployment-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    implementationId: example.sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: http://sop.example:9025
    definitionsPath: definitions.yaml
    defaultSopId: approval
    deployment: { mode: image, image: example/sop:1, port: 19025, healthPath: /healthz }
`));
    const sop = loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules?.sop;
    assert.deepEqual(sop && "deployment" in sop ? sop.deployment : undefined, {
      mode: "image",
      image: "example/sop:1",
      port: 19025,
      healthPath: "/healthz",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects malformed deployment modes and sources", () => {
  const cases = [
    {
      name: "mode",
      deployment: "{ mode: vendor }",
      code: "MODULE_DEPLOYMENT_MODE_INVALID",
    },
    {
      name: "image",
      deployment: "{ mode: image, port: 9010 }",
      code: "MODULE_DEPLOYMENT_IMAGE_INVALID",
    },
    {
      name: "build context",
      deployment: "{ mode: build, port: 9010 }",
      code: "MODULE_DEPLOYMENT_CONTEXT_INVALID",
    },
    {
      name: "port",
      deployment: "{ mode: image, image: example/loop:1, port: 0 }",
      code: "MODULE_DEPLOYMENT_PORT_INVALID",
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-deployment-invalid-"));
    const configPath = join(root, "pilotdeck.yaml");
    try {
      writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: loop.example
    port: 9010
    methods: [execute, cancel, status, resume, ack]
    deployment: ${item.deployment}
`));
      assert.throws(
        () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
        (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
          (diagnostic) => diagnostic.code === item.code,
        ) === true,
        item.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("loadPilotConfig rejects unsupported contracts and external tools without a catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-module-config-invalid-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  modelProvider:
    enabled: true
    implementationId: example.model
    contract: vendor.model/v9
    transport: module-http-v2
    endpoint: http://model:9011
    methods: [prepare, stream]
  tools:
    enabled: true
    implementationId: example.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: http://tools:9012
    methods: [execute]
`));
    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => {
        const codes = (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.map((item) => item.code) ?? [];
        return codes.includes("MODULE_CONTRACT_UNSUPPORTED") && codes.includes("MODULE_TOOL_CATALOG_REQUIRED");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig maps an unknown AgentLoop to the existing bidirectional transports", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-loop-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: 127.0.0.1
    port: 9015
    connectTimeoutMs: 500
    methods: [execute, cancel, status, resume, ack]
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
`));
    assert.deepEqual(loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules?.agentLoop, {
      enabled: true,
      implementationId: "example.loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-tcp-v2",
      host: "127.0.0.1",
      port: 9015,
      connectTimeoutMs: 500,
      methods: ["execute", "cancel", "status", "resume", "ack"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects malformed AgentLoop methods instead of using defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-loop-methods-invalid-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: 127.0.0.1
    port: 9015
    methods: execute
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
`));
    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
        (diagnostic) => diagnostic.code === "MODULE_METHODS_INVALID",
      ) === true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig maps an unknown stdio AgentLoop and validates args and env", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-loop-stdio-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  agentLoop:
    enabled: true
    implementationId: example.loop
    contract: pilotdeck.agent-loop/v1
    transport: module-stdio-v2
    command: node
    args: [loop.mjs, --stdio]
    env: { LOOP_MODE: portable }
    methods: [execute, cancel, status, resume, ack]
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
`));
    assert.deepEqual(loadPilotConfig({ configPath, env: { PILOT_HOME: root } }).config.modules?.agentLoop, {
      enabled: true,
      implementationId: "example.loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-stdio-v2",
      command: "node",
      args: ["loop.mjs", "--stdio"],
      env: { LOOP_MODE: "portable" },
      methods: ["execute", "cancel", "status", "resume", "ack"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects an incomplete or conflicting SOP protocol binding", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-protocol-invalid-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(`
modules:
  sop:
    enabled: true
    provider: staffdeck
    implementationId: example.approval
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: http://example-sop:8091
    definitionsPath: sops/definitions.yaml
    defaultSopId: onboarding
`));
    assert.throws(
      () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
      (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
        (diagnostic) => diagnostic.code === "SOP_MODULE_BINDING_CONFLICT",
      ) === true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig keeps the native profile when modules is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-native-config-"));
  const configPath = join(root, "pilotdeck.yaml");
  try {
    writeFileSync(configPath, configWithModules(""));
    const snapshot = loadPilotConfig({ configPath, env: { PILOT_HOME: root } });
    assert.equal(snapshot.config.modules, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPilotConfig rejects incomplete StaffDeck SOP runtime settings before startup", () => {
  const cases = [
    { name: "endpoint", endpoint: "relative/path", definitionsPath: "definitions.yaml", defaultSopId: "onboarding", code: "SOP_MODULE_ENDPOINT_INVALID" },
    { name: "definitions", endpoint: "http://sop-runtime:8091", definitionsPath: "   ", defaultSopId: "onboarding", code: "SOP_MODULE_DEFINITIONS_PATH_INVALID" },
    { name: "default id", endpoint: "http://sop-runtime:8091", definitionsPath: "definitions.yaml", defaultSopId: "", code: "SOP_MODULE_DEFAULT_ID_INVALID" },
    { name: "timeout", endpoint: "http://sop-runtime:8091", definitionsPath: "definitions.yaml", defaultSopId: "onboarding", timeoutMs: 0, code: "SOP_MODULE_TIMEOUT_INVALID" },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-config-required-"));
    const configPath = join(root, "pilotdeck.yaml");
    try {
      writeFileSync(configPath, configWithModules(`
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: ${item.endpoint}
    definitionsPath: ${JSON.stringify(item.definitionsPath)}
    defaultSopId: ${JSON.stringify(item.defaultSopId)}
    ${item.timeoutMs === undefined ? "" : `timeoutMs: ${item.timeoutMs}`}
`));
      assert.throws(
        () => loadPilotConfig({ configPath, env: { PILOT_HOME: root } }),
        (error: unknown) => (error as { diagnostics?: Array<{ code: string }> }).diagnostics?.some(
          (diagnostic) => diagnostic.code === item.code,
        ) === true,
        item.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("module profile changes require a new runtime generation", () => {
  assert.deepEqual(classifyConfigChanges(["modules", "modules.sop.endpoint"]), ["restart-required"]);
});
