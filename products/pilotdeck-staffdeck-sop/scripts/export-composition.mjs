#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { renderGeneratedEntrypoint } from "../../../scripts/generate-frontend-modules.mjs";
import { resolveFrontendProfile } from "../../../scripts/frontend-profile.mjs";
import { independentBinding, independentModelCredentialEnvs, prepareIndependent, rewriteIndependent, configureIndependentCompose } from './independent-services.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pilotdeckRoot = resolve(scriptDir, "../../..");
const independentV4Readme = `# PilotDeck + SOP v4 + Independent KM

The current deployment guide is DEPLOYMENT.zh-CN.md beside this README.
It covers source deployment, Compose, external services, verification and backup.
SOP_V4_BACKEND.zh-CN.md describes execution APIs, not a separate deployment.
No StaffDeck checkout, backend or user database is required.

To export another release from the matching source checkout, copy
profiles/independent-v4-external.yaml, set model IDs and owner/space binding,
and set deployment.mode to build for each service managed by Compose.
Use agent.interactionProfile: interactive for browser permission prompts.

\`\`\`sh
export PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \\
  --profile /path/to/v4-profile.yaml \\
  --knowledge-root /path/to/knowledge_core \\
  --out /path/to/new-release
\`\`\`

KM image/external mode does not require --knowledge-root. Set compatible
endpoints and credentials separately for external services; this deployment
does not start, stop or back them up.

In this export directory, fill all placeholders in .env before startup:

\`\`\`sh
cp .env.example .env
chmod 600 .env
docker compose -p pilotdeck-km-sop --env-file .env config --quiet
docker compose -p pilotdeck-km-sop --env-file .env up -d --build
docker compose -p pilotdeck-km-sop --env-file .env ps
\`\`\`

Use distinct model/API, SOP_V4_HOST_TOKEN, KM service and capability credentials.
Register/login at http://127.0.0.1:3001 (or PILOTDECK_PORT). Only Web is exposed
on loopback. Build/runtime profiles and login mode must agree; changing modules
or model URL requires re-export and rebuild. Runtime keys stay in .env.

Verify authenticated /api/modules/runtime, SOP /healthz and authenticated
/v4/ready, KM /api/km/config and /health/ready. Import/query a real document
and resolve its citation. Publish sop.definition/v4 via /v4/definitions and
call run_sop, sop_wait and paginated sop_result through chat/Gateway/SDK.
There is no separate SOP v4 management page. Health is not business acceptance.

Stop writes and all managed services before backing up pilotdeck-home,
sop-v4-data (/data/runtime.sqlite), knowledge-core-data (/data/knowledge.sqlite),
project files, config and .env. Omit absent services; back up external data in
its owning deployment. Never use down -v on persistent deployments. Restore
matching host/profile/frontend, runtimes and compatible databases together.
`;
const independentReadme = `# Independent KM / SOP Deployment

To export a new release, run from the matching PilotDeck source checkout with
Node 22 and pnpm 10. Copy native-five-independent.yaml, set its model IDs and
owner/space binding, then export to an empty directory:

\`\`\`sh
export PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \\
  --profile /path/to/km-sop.yaml \\
  --knowledge-root /path/to/knowledge_core \\
  --out /path/to/new-release
\`\`\`

The Knowledge source must include its UI, package-lock.json and uv.lock.
Image/external KM modes do not require --knowledge-root. Move the complete
export directory to the deployment host; it has no source-checkout dependency.
Changing the model URL requires re-export so NO_PROXY includes the new host.

Copy .env.example to .env (chmod 600) and fill model and service credentials.
Generate distinct values for KM service, KM capability and SOP publication tokens.
Never use these tokens as owner login credentials. Register the single owner in
the Web UI on first start; the supplied profile binds Knowledge to owner ID 1.

\`\`\`sh
cp .env.example .env
chmod 600 .env
# Edit .env before starting. Keep the same project name across upgrades.
docker compose -p pilotdeck-km-sop --env-file .env config --quiet
docker compose -p pilotdeck-km-sop --env-file .env up -d --build
docker compose -p pilotdeck-km-sop --env-file .env ps
\`\`\`

Open http://127.0.0.1:3001 (or PILOTDECK_PORT). KM/SOP stay internal.
Build and runtime use the same module profile and normal login mode. Changing
module selection requires re-export and rebuild. Model credentials remain runtime-only.

Check PilotDeck /health and authenticated /api/modules/runtime. KM uses
/health/ready and /api/km/config; SOP uses /healthz (v3/runtime ownership).
Import a document, query it with a real model and resolve its citation. Publish
an SOP in /sop with a pilotdeck:owner handoff, then resume from the logged-in
owner chat and verify completion/retry. Health is not business acceptance.

Stop writes before backup. Back up knowledge-core-data, sop-runtime-data and
pilotdeck-home using consistent SQLite snapshots and preserve .env/config.
Never run down -v on persistent deployments. Roll back matching host/frontend,
KM and SOP releases and compatible databases together. Recreate containers
without deleting volumes, then verify query/citation and SOP state persistence.

\`\`\`sh
mkdir -p backups/pre-upgrade
docker compose -p pilotdeck-km-sop stop
docker compose -p pilotdeck-km-sop cp knowledge-runtime:/data backups/pre-upgrade/knowledge
docker compose -p pilotdeck-km-sop cp sop-runtime:/data backups/pre-upgrade/sop
docker compose -p pilotdeck-km-sop cp pilotdeck:/root/.pilotdeck backups/pre-upgrade/host
cp -R config backups/pre-upgrade/config
cp .env backups/pre-upgrade/runtime.env
chmod 600 backups/pre-upgrade/runtime.env
docker compose -p pilotdeck-km-sop start
\`\`\`

For KM-only or SOP-only exports, omit backup commands for the absent service.
For external services, back up their data in the owning deployment separately.
The KM database is /data/knowledge.sqlite; SOP is /data/sop-runtime.sqlite.
Do not restore an older runtime onto an incompatible upgraded database.

External endpoints and prebuilt images must implement the same API and entrypoint
contract as the independent images. They need separate release/network acceptance.
`;
const defaults = {
  staffdeckRoot: process.env.STAFFDECK_SOP_ROOT
    ?? process.env.STAFFDECK_ROOT
    ?? resolve(pilotdeckRoot, "../StaffDeck-portable-sop"),
  output: resolve(process.cwd(), "pilotdeck-staffdeck-export"),
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("Usage: node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs --profile /path/to/pilotdeck.yaml [--out /path/to/export] [--staffdeck-root /path/to/StaffDeck] [--knowledge-root /path/to/knowledge_core]");
  process.exit(options.help ? 0 : 2);
}

const profilePath = resolveFrontendProfile({
  frontendProfile: options.profile ? resolve(options.profile) : process.env.PILOTDECK_FRONTEND_PROFILE,
  configPath: options.profile ? resolve(options.profile) : process.env.PILOTDECK_CONFIG_PATH,
}).path;
const profileText = await readFile(profilePath, "utf8");
const profile = materializeRuntimeReferences(YAML.parse(profileText));
if (!isRecord(profile)) throw new Error(`Profile '${profilePath}' must be a YAML object.`);
const assembly = validateProfile(profile);
const output = resolve(options.out ?? defaults.output);
await assertEmptyDirectory(output);

await mkdir(output, { recursive: true });
await copyPilotDeck(output);
await writeGeneratedFrontend(output, profile);
await prepareIndependent({ output, profile, profilePath, root: pilotdeckRoot,
  knowledgeRoot: options.knowledgeRoot, copy: copyRequired });
await copyStaffDeck(
  resolve(options.staffdeckRoot ?? defaults.staffdeckRoot),
  output,
  assembly.sop?.kind === "legacy" || assembly.sop?.builtin === "staffdeck-sop",
  externalModulesNeedStaffDeck(assembly.externalModules),
);
await writeDeploymentFiles(output, profile, profilePath, assembly);

console.log(JSON.stringify({
  status: "exported",
  output,
  sopEnabled: Boolean(assembly.sop),
  sopBinding: assembly.sop?.kind ?? "disabled",
  externalModules: assembly.externalModules.map((module) => module.slot),
  command: "docker compose --env-file .env -f compose.yaml up --build",
}));

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (["--profile", "--out", "--staffdeck-root", "--knowledge-root"].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      result[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument '${argument}'.`);
  }
  return result;
}

function validateProfile(profile) {
  const modules = profile.modules;
  if (!isRecord(modules)) throw new Error("Profile must contain a modules object.");
  for (const name of ["agentLoop", "modelProvider", "tools"]) {
    if (!isRecord(modules[name]) || modules[name].enabled !== true) {
      throw new Error(`modules.${name} must be enabled in an exported profile.`);
    }
  }
  const externalModules = ["agentLoop", "skills", "tools", "context", "modelProvider", "knowledge"]
    .map((slot) => readExternalModule(slot, modules[slot]))
    .filter(Boolean);
  const sop = readSopBinding(modules.sop);
  return { sop, externalModules };
}

function externalModulesNeedStaffDeck(modules) {
  return modules.some((module) => module.builtin === "staffdeck-knowledge");
}

function materializeRuntimeReferences(profile) {
  const result = structuredClone(profile);
  const providers = result.model?.providers;
  if (!isRecord(providers)) return result;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || provider.url !== "${PILOTDECK_REAL_MODEL_BASE_URL}") continue;
    const baseUrl = process.env.PILOTDECK_REAL_MODEL_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error(`PILOTDECK_REAL_MODEL_BASE_URL is required to export provider '${providerId}'.`);
    }
    try {
      new URL(baseUrl);
    } catch {
      throw new Error(`PILOTDECK_REAL_MODEL_BASE_URL must be an absolute URL.`);
    }
    provider.url = baseUrl;
  }
  return result;
}

function readExternalModule(slot, value) {
  const independent = independentBinding(slot, value);
  if (independent) return independent;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || (value.enabled !== true && value.enabled !== false)) {
    throw new Error(`modules.${slot} must be a module binding with an explicit enabled flag.`);
  }
  if (value.enabled === false || value.provider === "pilotdeck") return undefined;
  if (value.provider !== undefined) {
    throw new Error(`modules.${slot}.provider is only valid for the native pilotdeck binding.`);
  }
  for (const field of ["implementationId", "contract", "transport"]) requiredText(value, field, slot);
  const contracts = {
    agentLoop: "pilotdeck.agent-loop/v1",
    skills: "pilotdeck.skills/v1",
    tools: "pilotdeck.tools/v1",
    context: "pilotdeck.context/v1",
    modelProvider: "pilotdeck.model/v1",
    knowledge: "staffdeck.knowledge/v1",
  };
  if (value.contract !== contracts[slot]) {
    throw new Error(`modules.${slot}.contract is not supported by this exporter.`);
  }
  if (slot === "knowledge" && value.implementationId === "staffdeck.knowledge") {
    return {
      slot,
      implementationId: value.implementationId.trim(),
      target: value.endpoint,
      builtin: "staffdeck-knowledge",
      deployment: {
        mode: "build",
        context: "__staffdeck__",
        dockerfile: "knowledge.Dockerfile",
        port: 8090,
        healthPath: "/module-manifest",
        serviceName: "knowledge-runtime",
        builtin: "staffdeck-knowledge",
      },
    };
  }
  if (slot === "agentLoop") {
    if (!["module-stdio-v2", "module-tcp-v2"].includes(value.transport)) {
      throw new Error("modules.agentLoop.transport must be module-stdio-v2 or module-tcp-v2.");
    }
    const target = value.transport === "module-stdio-v2"
      ? requiredText(value, "command", slot)
      : requiredText(value, "host", slot);
    if (value.transport === "module-tcp-v2") requiredPort(value, slot);
    return { slot, implementationId: value.implementationId.trim(), target, deployment: readDeployment(value.deployment, slot) };
  }
  if (value.transport !== "module-http-v2") {
    throw new Error(`modules.${slot}.transport must be module-http-v2.`);
  }
  const endpoint = requiredText(value, "endpoint", slot);
  if (!urlHost(endpoint)) throw new Error(`modules.${slot}.endpoint must be an absolute URL.`);
  return { slot, implementationId: value.implementationId.trim(), target: endpoint, deployment: readDeployment(value.deployment, slot) };
}

function readSopBinding(value) {
  const independent = independentBinding('sop', value);
  if (independent) return independent;
  if (value === undefined || value === null || (isRecord(value) && value.enabled === false)) return undefined;
  if (!isRecord(value) || value.enabled !== true) {
    throw new Error("modules.sop must be disabled or enabled.");
  }
  const definitionsPath = requiredText(value, "definitionsPath", "sop");
  const defaultSopId = requiredText(value, "defaultSopId", "sop");
  if (value.provider === "staffdeck") {
    const { provider: _provider, ...portable } = value;
    return readSopBinding({ ...portable, implementationId: "portable-sop",
      contract: "sop.lifecycle/v3", transport: "sop-http-v3", endpoint: value.endpoint ?? "http://sop-runtime:8091", definitionsPath, defaultSopId });
  }
  if (value.provider !== undefined) {
    throw new Error("modules.sop.provider must be staffdeck or omitted for a protocol binding.");
  }
  for (const field of ["implementationId", "contract", "transport", "endpoint"]) {
    requiredText(value, field, "sop");
  }
  if (!((value.contract === "sop.lifecycle/v2" && value.transport === "sop-http-v2")
    || (value.contract === "sop.lifecycle/v3" && value.transport === "sop-http-v3"))) {
    throw new Error("Unsupported SOP contract or transport for this exporter.");
  }
  const builtin = ["staffdeck.portable-sop", "portable-sop"].includes(value.implementationId);
  return {
    kind: "external",
    ...value,
    ...(builtin ? { implementationId: "portable-sop", contract: "sop.lifecycle/v3", transport: "sop-http-v3", manifestPath: "/healthz" } : {}),
    definitionsPath,
    defaultSopId,
    ...(builtin
      ? {
          builtin: "staffdeck-sop",
          deployment: {
            mode: "build",
            context: "__staffdeck__",
            dockerfile: "portable_sop/Dockerfile",
            port: 8091,
            healthPath: "/healthz",
            serviceName: "sop-runtime",
            builtin: "staffdeck-sop",
          },
        }
      : { deployment: readDeployment(value.deployment, "sop") }),
  };
}

function readDeployment(value, slot) {
  if (value === undefined || value === null) return { mode: "external" };
  if (!isRecord(value)) throw new Error(`modules.${slot}.deployment must be an object.`);
  const mode = value.mode ?? "external";
  if (!["build", "image", "external"].includes(mode)) {
    throw new Error(`modules.${slot}.deployment.mode must be build, image, or external.`);
  }
  if (mode === "external") return { mode };
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`modules.${slot}.deployment.port must be an integer between 1 and 65535.`);
  }
  const healthPath = value.healthPath === undefined ? undefined : requiredText(value, "healthPath", `${slot}.deployment`);
  if (healthPath !== undefined && !healthPath.startsWith("/")) {
    throw new Error(`modules.${slot}.deployment.healthPath must start with '/'.`);
  }
  if (mode === "image") {
    return { mode, image: requiredText(value, "image", `${slot}.deployment`), port, ...(healthPath ? { healthPath } : {}) };
  }
  return {
    mode,
    context: requiredText(value, "context", `${slot}.deployment`),
    dockerfile: value.dockerfile === undefined ? "Dockerfile" : requiredText(value, "dockerfile", `${slot}.deployment`),
    port,
    ...(healthPath ? { healthPath } : {}),
  };
}

function requiredText(value, field, slot = "sop") {
  if (typeof value[field] !== "string" || !value[field].trim()) {
    throw new Error(`modules.${slot}.${field} must be a non-empty string.`);
  }
  return value[field].trim();
}

function requiredPort(value, slot) {
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`modules.${slot}.port must be an integer between 1 and 65535.`);
  }
  return port;
}

async function assertEmptyDirectory(path) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) throw new Error(`Export destination '${path}' is not empty.`);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

async function copyPilotDeck(output) {
  const destination = join(output, "pilotdeck");
  const entries = [
    "Dockerfile", ".dockerignore", "docker-entrypoint.sh", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
    "src", "scripts", "ui", "skills", "packages/sdk",
    "apps/desktop/src/lightAppearance.ts", "apps/desktop/src/interfacePreferences.ts",
    "products/pilotdeck-staffdeck-sop/profiles/render-limited-20260928.mjs",
  ];
  for (const entry of entries) await copyRequired(join(pilotdeckRoot, entry), join(destination, entry));
}

async function writeGeneratedFrontend(output, profile) {
  const destination = join(output, "pilotdeck/ui/src/composition/generated/frontend-modules.ts");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, renderGeneratedEntrypoint(
    profile,
    destination,
    join(output, "pilotdeck/ui/src/composition"),
  ), "utf8");
}

async function copyStaffDeck(source, output, includeSop, includeKnowledge) {
  if (!includeSop && !includeKnowledge) return;
  const destination = join(output, "staffdeck");
  if (includeKnowledge) await copyRequired(join(source, "backend"), join(destination, "backend"));
  await copyRequired(join(source, "portable_sop"), join(destination, "portable_sop"));
  if (includeSop) {
    const dockerfile = join(destination, "portable_sop", "Dockerfile");
    const text = await readFile(dockerfile, "utf8");
    await writeFile(dockerfile, text.replace(/^FROM python:3\.11-slim/m, "ARG PYTHON_BASE_IMAGE=python:3.11-slim\nFROM ${PYTHON_BASE_IMAGE}"), "utf8");
  }
  if (includeKnowledge) {
    await writeFile(join(destination, "knowledge_runtime.py"), `"""Standalone Knowledge module entrypoint for the exported deployment."""

import staffdeck_harness.runtime as harness_runtime

# The exported Knowledge service owns the data facade only. The current
# StaffDeck checkout's app.main startup hook unconditionally boots the optional
# Harness v3 worker, whose Node engine is not part of this service image.
harness_runtime.start_harness_runtime = lambda _settings: {"disabled": True}

from app.main import app  # noqa: E402
`, "utf8");
    await writeFile(join(destination, "knowledge.Dockerfile"), `ARG PYTHON_BASE_IMAGE=python:3.11-slim
FROM \${PYTHON_BASE_IMAGE}

WORKDIR /app
COPY backend ./backend
COPY portable_sop/src ./portable_sop/src
COPY knowledge_runtime.py ./knowledge_runtime.py
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \\
    pip install --no-cache-dir --no-build-isolation ./backend
ENV PYTHONPATH=/app/backend:/app/backend/src:/app/portable_sop/src

EXPOSE 8090
CMD ["python", "-m", "uvicorn", "knowledge_runtime:app", "--host", "0.0.0.0", "--port", "8090"]
`, "utf8");
  }
}

async function copyRequired(source, destination) {
  try {
    await stat(source);
  } catch {
    throw new Error(`Required export source is missing: ${source}`);
  }
  await cp(source, destination, {
    recursive: true,
    filter: (candidate) => !shouldExclude(candidate),
  });
}

function shouldExclude(candidate) {
  const name = candidate.split("/").at(-1);
  return [".git", "node_modules", "dist", "__pycache__", ".pytest_cache", ".venv", ".env"].includes(name);
}

async function writeDeploymentFiles(output, profile, profilePath, assembly) {
  const { sop, externalModules } = assembly;
  const deployment = structuredClone(profile);
  deployment.modules = structuredClone(profile.modules);
  await materializeDeploymentSources(output, profilePath, externalModules, sop);
  if (sop && !sop.independent) {
    const source = isAbsolute(sop.definitionsPath)
      ? sop.definitionsPath
      : resolve(dirname(profilePath), sop.definitionsPath);
    await copyRequired(source, join(output, "sops", "definition.yaml"));
    if (sop.contract === "sop.lifecycle/v3") {
      const definitions = YAML.parse(await readFile(source, "utf8"));
      const bundle = Array.isArray(definitions) ? { sops: definitions }
        : Array.isArray(definitions?.sops) ? definitions : { sops: [definitions] };
      await writeFile(join(output, "sops", "definition.json"), JSON.stringify(bundle), "utf8");
    }
    deployment.modules.sop = {
      ...deployment.modules.sop,
      ...(sop.kind === "legacy" ? { endpoint: "http://sop-runtime:8091" } : {}),
      definitionsPath: "/root/.pilotdeck/sops/definition.yaml",
    };
  } else if (!sop) {
    delete deployment.modules.sop;
  }
  rewriteManagedBindings(deployment.modules, externalModules, sop);
  rewriteIndependent(deployment);
  if (sop?.independent) delete deployment.modules.sop.definitionsPath;
  await mkdir(join(output, "config"), { recursive: true });
  await mkdir(join(output, "sops"), { recursive: true });
  await writeFile(join(output, "config", "pilotdeck.yaml"), YAML.stringify(deployment), "utf8");
  const independent = [...externalModules, sop].filter(row => row?.independent);
  const buildProfile = { modules: deployment.modules, ...(deployment.frontend ? { frontend: deployment.frontend } : {}) };
  await writeFile(join(output, 'pilotdeck/products/pilotdeck-staffdeck-sop/profiles/exported.yaml'), YAML.stringify(buildProfile));
  const needsKnowledgeSecret = externalModules.some((module) => module.builtin === "staffdeck-knowledge");
  const extraModelCredentials = independent.length
    ? independentModelCredentialEnvs(profile).filter(key => !['PILOTDECK_API_KEY', 'PILOTDECK_REAL_MODEL_API_KEY', 'PILOTDECK_REAL_MODEL_BASE_URL', 'PILOTDECK_PORT'].includes(key))
      .map(key => `${key}=\n`).join('')
    : '';
  await writeFile(
    join(output, ".env.example"),
    `PILOTDECK_API_KEY=\nPILOTDECK_REAL_MODEL_API_KEY=\nPILOTDECK_REAL_MODEL_BASE_URL=\n${extraModelCredentials}${needsKnowledgeSecret ? "STAFFDECK_APP_SECRET=change-me\nSTAFFDECK_PYTHON_BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/python:3.11-slim\n" : ""}${independent.some(row => row.slot === 'knowledge') ? `${deployment.modules.knowledge.credentialEnv}=\n${deployment.modules.knowledge.capabilitiesCredentialEnv}=\n` : ''}${sop?.independent ? sop.contract === 'sop.lifecycle/v4' ? `${sop.credentialEnv}=\n` : 'SOP_RUNTIME_PUBLISH_TOKEN=\n' : ''}PILOTDECK_PORT=3001\n`,
    "utf8",
  );
  const services = compose(sop, providerNoProxyHosts(profile), externalModules);
  configureIndependentCompose(services, profile, independent);
  await writeFile(join(output, "compose.yaml"), YAML.stringify(services), "utf8");
  const currentIndependent = independent.length && (!sop || sop.contract === 'sop.lifecycle/v4');
  if (currentIndependent) {
    for (const name of ['DEPLOYMENT.zh-CN.md', 'SOP_V4_BACKEND.zh-CN.md',
      'SOP_V4_DECOUPLED_ACCEPTANCE.zh-CN.md', 'SOP_V4_SOURCE_ACCEPTANCE.zh-CN.md', 'SOP_V4_ACCEPTANCE.zh-CN.md']) {
      await copyRequired(join(pilotdeckRoot, 'products/pilotdeck-staffdeck-sop', name), join(output, name));
    }
  }
  await writeFile(join(output, "README.md"), currentIndependent ? independentV4Readme
    : independent.length ? independentReadme : readme(sop, externalModules), "utf8");
}

async function materializeDeploymentSources(output, profilePath, externalModules, sop) {
  const entries = [
    ...externalModules.map((module) => ({ slot: module.slot, deployment: module.deployment })),
    ...(sop?.deployment ? [{ slot: "sop", deployment: sop.deployment }] : []),
  ];
  for (const entry of entries) {
    if (entry.deployment.mode !== "build") continue;
    if (["__staffdeck__", "__independent__"].includes(entry.deployment.context)) continue;
    const source = resolve(dirname(profilePath), entry.deployment.context);
    await copyRequired(source, join(output, "modules", entry.slot));
  }
}

function rewriteManagedBindings(modules, externalModules, sop) {
  for (const module of externalModules) {
    rewriteManagedBinding(modules[module.slot], module.slot, module.deployment);
  }
  if (sop?.deployment) rewriteManagedBinding(modules.sop, "sop", sop.deployment);
}

function rewriteManagedBinding(binding, slot, deployment) {
  if (!binding || deployment.mode === "external") return;
  const service = deploymentServiceName(slot, deployment);
  const endpoint = `http://${service}:${deployment.port}`;
  binding.deployment = {
    ...deployment,
    ...(deployment.mode === "build" && deployment.context !== "__staffdeck__"
      ? { context: `./modules/${slot}` }
      : {}),
  };
  if (slot === "agentLoop") {
    binding.host = service;
    binding.port = deployment.port;
  } else {
    binding.endpoint = endpoint;
  }
}

function compose(sop, providerHosts, externalModules) {
  const sopHosts = sop?.kind === "legacy" ? ["sop-runtime"] : sop?.kind === "external" ? [urlHost(sop.endpoint)] : [];
  const managedModules = externalModules.filter((module) => module.deployment.mode !== "external");
  const externalHosts = externalModules
    .filter((module) => module.deployment.mode === "external")
    .map((module) => urlHost(module.target) ?? module.target);
  const managedSop = sop?.kind === "external" && sop.deployment?.mode !== "external" ? [{ slot: "sop", deployment: sop.deployment }] : [];
  const managed = [...managedModules, ...managedSop];
  const managedHosts = managed.map((module) => deploymentServiceName(module.slot, module.deployment));
  const noProxy = [...sopHosts, ...externalHosts, ...managedHosts, ...providerHosts, "localhost", "127.0.0.1"]
    .filter(Boolean).join(",");
  const pilotdeck = {
    build: { context: "./pilotdeck", args: { PILOTDECK_BUILD_PROFILE: 'products/pilotdeck-staffdeck-sop/profiles/exported.yaml' } }, image: "pilotdeck:exported",
    ports: ["${PILOTDECK_PORT:-3001}:3001"], restart: "unless-stopped",
    environment: {
      PILOT_HOME: "/root/.pilotdeck",
      SERVER_PORT: "3001",
      PILOTDECK_API_KEY: "${PILOTDECK_API_KEY:?set PILOTDECK_API_KEY in .env}",
      // Reserved for a deployment-time model credential reference in a
      // generated runtime config; empty for ordinary exports.
      PILOTDECK_REAL_MODEL_API_KEY: "${PILOTDECK_REAL_MODEL_API_KEY:-}",
      PILOTDECK_REAL_MODEL_BASE_URL: "${PILOTDECK_REAL_MODEL_BASE_URL:-}",
      // A host-level proxy must not intercept the in-network SOP sidecar.
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    },
    volumes: ["pilotdeck-home:/root/.pilotdeck", "./config/pilotdeck.yaml:/root/.pilotdeck/pilotdeck.yaml:ro", "./sops:/root/.pilotdeck/sops:ro"],
  };
  const services = { pilotdeck };
  const dependencies = {};
  if (sop?.kind === "legacy" && !sop.deployment) {
    services["sop-runtime"] = {
      build: { context: "./staffdeck", dockerfile: "portable_sop/Dockerfile" }, image: "staffdeck-sop-runtime:exported",
      healthcheck: { test: ["CMD", "python", "-c", "from urllib.request import urlopen; urlopen('http://localhost:8091/healthz')"], interval: "5s", timeout: "3s", retries: 12 },
    };
    dependencies["sop-runtime"] = { condition: "service_healthy" };
  }
  for (const module of managed) {
    const service = deploymentServiceName(module.slot, module.deployment);
    services[service] = deploymentService(module.slot, module.deployment);
    dependencies[service] = {
      condition: module.deployment.healthPath ? "service_healthy" : "service_started",
    };
  }
  if (Object.keys(dependencies).length > 0) pilotdeck.depends_on = dependencies;
  const volumes = { "pilotdeck-home": {} };
  if (managed.some(module => module.slot === "sop" && module.deployment.builtin === "staffdeck-sop")) {
    volumes["sop-runtime-data"] = {};
  }
  if (managed.some((module) => module.slot === "knowledge" && module.deployment.builtin === "staffdeck-knowledge")) {
    volumes["staffdeck-knowledge-data"] = {};
  }
  return { services, volumes };
}

function deploymentServiceName(slot, deployment) {
  return deployment?.serviceName ?? `module-${slot.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

function deploymentService(slot, deployment) {
  const service = {
    restart: "unless-stopped",
    expose: [String(deployment.port)],
  };
  if (deployment.mode === "image") {
    service.image = deployment.image;
  } else {
    service.build = {
      context: deployment.context === "__staffdeck__" ? "./staffdeck" : `./modules/${slot}`,
      ...(deployment.dockerfile ? { dockerfile: deployment.dockerfile } : {}),
      ...(deployment.context === "__staffdeck__" ? { args: { PYTHON_BASE_IMAGE: "${STAFFDECK_PYTHON_BASE_IMAGE:-python:3.11-slim}" } } : {}),
    };
  }
  service.environment = {
    MODULE_SLOT: slot,
    MODULE_IMPLEMENTATION_ID: `exported.${slot}`,
    MODULE_PORT: String(deployment.port),
  };
  if (deployment.builtin === "staffdeck-sop") {
    service.environment.SOP_RUNTIME_DB = "/data/sop-runtime.sqlite";
    service.environment.SOP_DEFINITIONS_DIR = "/definitions";
    service.volumes = ["sop-runtime-data:/data", "./sops:/definitions:ro"];
  }
  if (deployment.builtin === "staffdeck-knowledge") {
    service.environment = {
      ...service.environment,
      DATABASE_URL: "sqlite:////data/staffdeck-knowledge.db",
      APP_SECRET: "${STAFFDECK_APP_SECRET:?set STAFFDECK_APP_SECRET in .env}",
      DEMO_SEED_ENABLED: "true",
      // The Knowledge facade is a data service. The current portable StaffDeck
      // checkout does not ship the Harness v3 Node worker binary, so enabling
      // the engine here would make this otherwise self-contained service fail
      // during FastAPI startup.
      HARNESS_V3_ENABLED: "0",
      HARNESS_ADMIN_API_ENABLED: "0",
    };
    service.volumes = ["staffdeck-knowledge-data:/data"];
  }
  if (deployment.healthPath) {
    service.healthcheck = {
      test: deployment.builtin?.startsWith("staffdeck-") || deployment.builtin?.startsWith('independent-')
        ? ["CMD", "python", "-c", `from urllib.request import urlopen; urlopen('http://localhost:${deployment.port}${deployment.healthPath}')`]
        : ["CMD-SHELL", `node -e "fetch('http://localhost:${deployment.port}${deployment.healthPath}').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"`],
      interval: "5s",
      timeout: "3s",
      retries: 12,
    };
  }
  return service;
}

function urlHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function providerNoProxyHosts(profile) {
  const providers = profile.model?.providers;
  if (!isRecord(providers)) return [];
  const hosts = new Set();
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider) || typeof provider.url !== "string") continue;
    try {
      const host = new URL(provider.url).hostname;
      if (host) hosts.add(host);
    } catch {
      // Configuration validation owns provider URL diagnostics. An invalid URL
      // simply cannot contribute a deployment proxy exception.
    }
  }
  return [...hosts].sort();
}

function readme(sop, externalModules) {
  const mode = sop?.kind === "legacy" ? "managed StaffDeck runtime" : sop?.kind === "external" ? "external protocol endpoint" : "disabled";
  const dependencies = [
    ...externalModules.filter((module) => !module.builtin),
    ...(sop?.kind === "external" && sop.deployment?.mode === "external"
      ? [{ slot: "sop", implementationId: sop.implementationId, target: sop.endpoint, deployment: sop.deployment }]
      : []),
  ];
  const external = dependencies.length === 0
    ? "none"
    : dependencies.map((module) => `- ${module.slot}: ${module.implementationId} (${module.deployment.mode === "external" ? module.target : `${deploymentServiceName(module.slot)}:${module.deployment.port}`})`).join("\n");
  const hasManagedKnowledge = externalModules.some((module) => module.builtin === "staffdeck-knowledge");
  const bundled = hasManagedKnowledge
    ? "This export bundles the validated StaffDeck backend for SOP and Knowledge. Knowledge data is persisted in its own SQLite volume and is reachable only inside the Compose network. The current StaffDeck origin/main does not yet provide this module API. The generated .env.example uses Huawei Cloud's Docker Hub mirror for the Python base image; set STAFFDECK_PYTHON_BASE_IMAGE to another registry when needed."
    : "";
  return `# Exported PilotDeck Deployment\n\nCopy .env.example to .env and set PILOTDECK_API_KEY.${hasManagedKnowledge ? " Also set STAFFDECK_APP_SECRET for the bundled Knowledge runtime." : ""} Profiles using the real model template must set PILOTDECK_REAL_MODEL_BASE_URL when exporting and PILOTDECK_REAL_MODEL_API_KEY at runtime; credentials are never copied into this export. Then run:\n\n\`docker compose --env-file .env -f compose.yaml up --build\`\n\nSOP binding: ${mode}.\n${bundled ? `\n${bundled}\n` : ""}\nExternal module dependencies (not bundled by this export):\n${external}\n`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
