import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { loadPilotConfig } from '../../src/pilot/config/loadPilotConfig.js';

const execFile = promisify(execFileCallback);
const projectRoot = process.cwd();
const exporter = join(projectRoot, "products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs");
const managedProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-seven-managed.yaml");
const externalProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-seven-external.yaml");
const knowledgeOnlyProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-knowledge-external.yaml");
const sopOnlyProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/example-sop-external.yaml");
const plainProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/pilotdeck-only.yaml");
const nativeFiveStaffDeckProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml");
const portableProfile = join(projectRoot, "products/pilotdeck-staffdeck-sop/profiles/portable-sop-v3.yaml");

test("SOP v3 export contains only the portable package and durable definition/state mounts", async () => {
  const root = mkdtempSync(join(tmpdir(), "portable-sop-export-"));
  try {
    await runExport(portableProfile, join(root, "output"));
    const output = join(root, "output");
    assert.equal(existsSync(join(output, "staffdeck/backend")), false);
    assert.equal(existsSync(join(output, "staffdeck/portable_sop/pyproject.toml")), true);
    const definitions = JSON.parse(readFileSync(join(output, "sops/definition.json"), "utf8"));
    assert.equal(definitions.sops[0].id, "approval");
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8"));
    assert.deepEqual(compose.services["sop-runtime"].volumes, ["sop-runtime-data:/data", "./sops:/definitions:ro"]);
    assert.equal(compose.services["sop-runtime"].environment.SOP_RUNTIME_DB, "/data/sop-runtime.sqlite");
    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8"));
    assert.equal(config.modules.sop.contract, "sop.lifecycle/v3");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function runExport(profile: string, output: string, extraEnv: Record<string, string> = {}): Promise<void> {
  await execFile(process.execPath, [exporter, "--profile", profile, "--out", output], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 2 * 1024 * 1024,
  });
}

test('independent services export with isolated data, credentials, frontend and no StaffDeck backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'independent-export-'));
  try {
    const source = join(root, 'km');
    for (const file of ['pyproject.toml', 'setup.py', 'uv.lock', 'ui/package-lock.json', 'src/knowledge_core/cli.py']) {
      mkdirSync(join(source, file, '..'), { recursive: true });
      writeFileSync(join(source, file), 'fixture');
    }
    const profile = YAML.parse(readFileSync(join(projectRoot, 'products/pilotdeck-staffdeck-sop/profiles/native-five-independent.yaml'), 'utf8'));
    const profilePath = join(root, 'profile.yaml');
    const exportProfile = async (name: string, knowledge = true) => {
      writeFileSync(profilePath, YAML.stringify(profile));
      const output = join(root, name);
      await execFile(process.execPath, [exporter, '--profile', profilePath, '--out', output,
        ...(knowledge ? ['--knowledge-root', source] : [])], {cwd:projectRoot,
        env:{...process.env,PILOTDECK_REAL_MODEL_BASE_URL:'https://model.example.test/v1'}});
      return {output, compose:YAML.parse(readFileSync(join(output,'compose.yaml'),'utf8')),
        config:YAML.parse(readFileSync(join(output,'config/pilotdeck.yaml'),'utf8'))};
    };
    const full = await exportProfile('full');
    assert.deepEqual(Object.keys(full.compose.services).sort(), ['knowledge-runtime','pilotdeck','sop-runtime']);
    assert.equal(existsSync(join(full.output,'staffdeck')),false);
    assert.equal(existsSync(join(full.output,'modules/sop/src/staffdeck_sop_runtime/api.py')),true);
    assert.equal(existsSync(join(full.output,'pilotdeck/apps/desktop/src/lightAppearance.ts')),true);
    assert.equal(existsSync(join(full.output,'pilotdeck/apps/desktop/src/interfacePreferences.ts')),true);
    assert.equal(full.config.modules.knowledge.endpoint,'http://knowledge-runtime:8787');
    assert.equal(full.config.modules.sop.endpoint,'http://sop-runtime:8091');
    assert.equal(full.compose.services.pilotdeck.environment.PILOTDECK_DISABLE_LOCAL_AUTH,'0');
    assert.match(readFileSync(join(full.output,'README.md'),'utf8'),/--knowledge-root \/path\/to\/knowledge_core/);
    assert.equal(full.config.modules.sop.localRuntime,undefined);
    const snapshot=loadPilotConfig({configPath:join(full.output,'config/pilotdeck.yaml'),env:{
      ...process.env,PILOT_HOME:join(root,'runtime-home'),PILOTDECK_REAL_MODEL_API_KEY:'test-key',
      PILOTDECK_KM_SERVICE_TOKEN:'test-km',PILOTDECK_KM_CAPABILITY_TOKEN:'test-capability'}});
    assert.equal(snapshot.config.modules?.sop?.defaultSopId,'compose_approval');
    assert.equal(full.compose.services.pilotdeck.build.args.PILOTDECK_BUILD_PROFILE,
      'products/pilotdeck-staffdeck-sop/profiles/exported.yaml');
    assert.match(readFileSync(join(full.output,'modules/knowledge/Dockerfile'),'utf8'),/npm ci/);
    assert.doesNotMatch(readFileSync(join(full.output,'pilotdeck/products/pilotdeck-staffdeck-sop/profiles/exported.yaml'),'utf8'),/apiKey|REAL_MODEL/);
    assert.deepEqual(Object.keys(full.compose.volumes).sort(),['knowledge-core-data','pilotdeck-home','sop-runtime-data']);
    assert.match(readFileSync(join(full.output,'pilotdeck/products/pilotdeck-staffdeck-sop/profiles/exported.yaml'),'utf8'),/pilotdeck.sop/);
    profile.modules.sop.enabled=false;
    assert.equal((await exportProfile('km-only')).compose.services['sop-runtime'],undefined);
    profile.modules.sop.enabled=true;
    profile.modules.knowledge.enabled=false;
    assert.equal((await exportProfile('sop-only',false)).compose.services['knowledge-runtime'],undefined);
    profile.modules.knowledge.enabled=true;
    profile.modules.knowledge.deployment={mode:'external'};
    profile.modules.sop.deployment={mode:'external'};
    const external=await exportProfile('external',false);
    assert.deepEqual(Object.keys(external.compose.services),['pilotdeck']);
    profile.modules.knowledge.deployment={mode:'image',image:'knowledge:test'};
    assert.equal((await exportProfile('image',false)).compose.services['knowledge-runtime'].image,'knowledge:test');
    profile.modules.knowledge.deployment={mode:'build'};
    await assert.rejects(exportProfile('missing',false),/knowledge-root/);
    profile.modules.knowledge.localRuntime={python:'/host/python',modelConfig:'/host/secret.json'};
    await assert.rejects(exportProfile('unsupported-path'),/modelConfig/);
    delete profile.modules.knowledge.localRuntime.modelConfig;
    profile.modules.knowledge.localRuntime.dataDirectory='/host/data';
    const translated=await exportProfile('translated');
    assert.equal(translated.config.modules.knowledge.localRuntime,undefined);
    assert.doesNotMatch(readFileSync(join(translated.output,'config/pilotdeck.yaml'),'utf8'),/\/host\//);
    const configFile=join(root,'km-config.json');
    writeFileSync(configFile,JSON.stringify({preset:'full',modules:{publication:false}}));
    profile.modules.knowledge.localRuntime.configFile=configFile;
    const configured=await exportProfile('configured');
    assert.equal(JSON.parse(readFileSync(join(configured.output,'config/knowledge.json'),'utf8')).modules.authentication,true);
    assert.doesNotMatch(readFileSync(join(configured.output,'config/pilotdeck.yaml'),'utf8'),new RegExp(root));
    writeFileSync(configFile,JSON.stringify({preset:'minimal'}));
    await assert.rejects(exportProfile('disabled-spaces'),/requires the spaces module/);
    writeFileSync(configFile,JSON.stringify({preset:'full',modules:{publication:false}}));
    profile.modules.knowledge.bearer='inline-secret';
    await assert.rejects(exportProfile('inline-secret'),/environment credentials/);
    delete profile.modules.knowledge.bearer;
    profile.modules.sop.deployment={mode:'build'};
    profile.modules.sop.localRuntime={enabled:true,python:'/host/python',knowledgeEnabled:false};
    const sopLocal=await exportProfile('sop-local');
    assert.equal(sopLocal.compose.services['sop-runtime'].environment.SOP_KNOWLEDGE_ENABLED,'false');
    assert.equal(sopLocal.config.modules.sop.localRuntime,undefined);
    profile.modules.sop.localRuntime.dataDirectory='/host/sop';
    await assert.rejects(exportProfile('sop-path'),/sop.localRuntime.dataDirectory/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("export-composition bundles StaffDeck SOP and Knowledge runtimes for native-five profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-native-five-"));
  try {
    const output = join(root, "native-five");
    await runExport(nativeFiveStaffDeckProfile, output, {
      PILOTDECK_REAL_MODEL_BASE_URL: "http://model.example.test/v1",
    });
    const compose = YAML.parse(readFileSync(join(output, "compose.yaml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(compose.services).sort(), ["knowledge-runtime", "pilotdeck", "sop-runtime"]);
    assert.deepEqual(compose.services["knowledge-runtime"].build, {
      context: "./staffdeck",
      dockerfile: "knowledge.Dockerfile",
      args: { PYTHON_BASE_IMAGE: "${STAFFDECK_PYTHON_BASE_IMAGE:-python:3.11-slim}" },
    });
    assert.deepEqual(compose.services["sop-runtime"].build, {
      context: "./staffdeck",
      dockerfile: "portable_sop/Dockerfile",
      args: { PYTHON_BASE_IMAGE: "${STAFFDECK_PYTHON_BASE_IMAGE:-python:3.11-slim}" },
    });
    const dependencies = compose.services.pilotdeck.depends_on as Record<string, { condition: string }>;
    assert.equal(dependencies["knowledge-runtime"].condition, "service_healthy");
    assert.equal(dependencies["sop-runtime"].condition, "service_healthy");
    assert.equal(compose.volumes["staffdeck-knowledge-data"] !== undefined, true);
    assert.match(readFileSync(join(output, ".env.example"), "utf8"), /STAFFDECK_APP_SECRET=change-me/u);
    assert.equal(existsSync(join(output, "staffdeck/knowledge.Dockerfile")), true);
    assert.doesNotMatch(readFileSync(join(output, "README.md"), "utf8"), /- knowledge: staffdeck\.knowledge/u);
    const config = YAML.parse(readFileSync(join(output, "config/pilotdeck.yaml"), "utf8")) as {
      modules: Record<string, Record<string, unknown>>;
    };
    assert.equal(config.modules.knowledge.endpoint, "http://knowledge-runtime:8090");
    assert.equal(config.modules.sop.endpoint, "http://sop-runtime:8091");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export-composition emits one generic service for all seven managed slots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-composition-export-"));
  try {
    const output = join(root, "managed");
    await runExport(managedProfile, output);
    assert.equal(existsSync(join(output, 'pilotdeck/packages/sdk/package.json')), true);
    assert.equal(existsSync(join(output, 'pilotdeck/packages/sdk/src/index.ts')), true);
    await import(pathToFileURL(join(output, 'pilotdeck/scripts/run-minimum-staffdeck-startup.mjs')).href);

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
