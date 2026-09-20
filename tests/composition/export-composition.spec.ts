import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

const execFile = promisify(execFileCallback);
const projectRoot = process.cwd();
const exporter = join(projectRoot, "products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs");
const managedProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-seven-managed.yaml");
const externalProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-seven-external.yaml");
const knowledgeOnlyProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-knowledge-external.yaml");
const sopOnlyProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-sop-external.yaml");
const plainProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/pilotdeck-only.yaml");

async function runExport(profile: string, output: string): Promise<void> {
  await execFile(process.execPath, [exporter, "--profile", profile, "--out", output], {
    cwd: projectRoot,
    env: { ...process.env },
    maxBuffer: 2 * 1024 * 1024,
  });
}

test("export-composition emits one generic service for all seven managed slots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-"));
  try {
    const output = join(root, "managed");
    await runExport(managedProfile, output);

    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const managedNames = [
      "module-agent-loop",
      "module-skills",
      "module-tools",
      "module-context",
      "module-model-provider",
      "module-knowledge",
      "module-sop",
    ];
    assert.deepEqual(
      managedNames.filter((name) => compose.services[name] !== undefined),
      managedNames,
    );
    for (const name of managedNames) {
      const service = compose.services[name];
      assert.equal(typeof service.image, "string", `${name} should use its declared image`);
      assert.deepEqual(service.expose, [String({
        "module-agent-loop": 9020,
        "module-skills": 9021,
        "module-tools": 9022,
        "module-context": 9023,
        "module-model-provider": 9024,
        "module-sop": 9025,
        "module-knowledge": 9026,
      }[name])]);
    }
    const dependencies = compose.services.pilotdeck.depends_on as Record<string, { condition: string }>;
    assert.equal(dependencies["module-sop"].condition, "service_healthy");
    assert.equal(dependencies["module-agent-loop"].condition, "service_started");

    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown>>;
      model: { providers: { external: { apiKey: string } } };
    };
    assert.equal(config.modules.agentLoop.host, "module-agent-loop");
    assert.equal(config.modules.agentLoop.port, 9020);
    for (const [slot, service] of [
      ["skills", "module-skills"],
      ["tools", "module-tools"],
      ["context", "module-context"],
      ["modelProvider", "module-model-provider"],
      ["knowledge", "module-knowledge"],
      ["sop", "module-sop"],
    ] as const) {
      assert.equal(config.modules[slot].endpoint, `http://${service}:${Number(config.modules[slot].deployment && (config.modules[slot].deployment as Record<string, unknown>).port)}`);
    }
    assert.equal(config.model.providers.external.apiKey, "${PILOTDECK_API_KEY}");
    assert.equal(readFileSync(join(output, ".env.example"), "utf8").includes("test-only"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition handles mixed image/build/external sources without vendor branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-mixed-"));
  try {
    const source = join(root, "module-source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "Dockerfile"), "FROM scratch\n");
    const profile = YAML.parse(readFileSync(managedProfile, "utf8")) as {
      modules: Record<string, Record<string, unknown>>;
    };
    profile.modules.skills.deployment = {
      mode: "build",
      context: "./module-source",
      dockerfile: "Dockerfile",
      port: 19321,
    };
    profile.modules.tools.deployment = { mode: "external" };
    profile.modules.tools.endpoint = "https://tools.vendor.example/v2";
    profile.modules.sop = { enabled: false };
    const profilePath = join(root, "mixed.yaml");
    writeFileSync(profilePath, YAML.stringify(profile), "utf8");

    const output = join(root, "mixed");
    await runExport(profilePath, output);
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(compose.services["module-skills"].build, {
      context: "./modules/skills",
      dockerfile: "Dockerfile",
    });
    assert.equal(compose.services["module-skills"].image, undefined);
    assert.equal(compose.services["module-tools"], undefined);
    assert.equal(compose.services["module-sop"], undefined);
    const pilotdeckEnvironment = compose.services.pilotdeck.environment as Record<string, string>;
    assert.equal(pilotdeckEnvironment.NO_PROXY.includes("tools.vendor.example"), true);

    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown>>;
    };
    assert.equal(config.modules.skills.endpoint, "http://module-skills:19321");
    assert.equal(config.modules.tools.endpoint, "https://tools.vendor.example/v2");
    assert.equal(config.modules.sop, undefined);
    assert.equal(readFileSync(join(output, "modules/skills/Dockerfile"), "utf8"), "FROM scratch\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition lists an external SOP as an undeclared deployment dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-sop-"));
  try {
    const output = join(root, "external");
    await runExport(externalProfile, output);
    const readme = readFileSync(join(output, "README.md"), "utf8");
    assert.match(readme, /- sop: example\.sop \(http:\/\/sop\.example\.invalid:9025\)/u);
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    assert.equal(compose.services["module-sop"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition keeps Knowledge-only dependencies separate from disabled SOP", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-knowledge-only-"));
  try {
    const output = join(root, "knowledge-only");
    await runExport(knowledgeOnlyProfile, output);
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown> | undefined>;
    };
    assert.equal(compose.services["module-knowledge"], undefined);
    assert.equal(compose.services["module-sop"], undefined);
    assert.equal(config.modules.knowledge?.endpoint, "http://example-knowledge:9026");
    assert.equal(config.modules.sop, undefined);
    assert.equal(existsSync(join(output, "staffdeck")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition keeps SOP-only dependencies separate from disabled Knowledge", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-sop-only-"));
  try {
    const output = join(root, "sop-only");
    await runExport(sopOnlyProfile, output);
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown> | undefined>;
    };
    assert.equal(compose.services["module-knowledge"], undefined);
    assert.equal(compose.services["module-sop"], undefined);
    assert.equal(config.modules.sop?.endpoint, "http://example-sop:8091");
    assert.deepEqual(config.modules.knowledge, { enabled: false });
    assert.equal(existsSync(join(output, "staffdeck")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition emits a plain profile with no module deployment dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-plain-"));
  try {
    const output = join(root, "plain");
    await runExport(plainProfile, output);
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown> | undefined>;
    };
    assert.deepEqual(Object.keys(compose.services), ["pilotdeck"]);
    assert.deepEqual(config.modules.skills, { enabled: false });
    assert.deepEqual(config.modules.knowledge, { enabled: false });
    assert.equal(config.modules.sop, undefined);
    assert.equal(existsSync(join(output, "staffdeck")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
