#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { renderGeneratedEntrypoint } from "../../../scripts/generate-frontend-modules.mjs";
import { resolveFrontendProfile } from "../../../scripts/frontend-profile.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pilotdeckRoot = resolve(scriptDir, "../../..");
const defaults = {
  staffdeckRoot: process.env.STAFFDECK_SOP_ROOT
    ?? process.env.STAFFDECK_ROOT
    ?? resolve(pilotdeckRoot, "../StaffDeck-portable-sop"),
  output: resolve(process.cwd(), "pilotdeck-staffdeck-export"),
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("Usage: node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs --profile /path/to/pilotdeck.yaml [--out /path/to/export] [--staffdeck-root /path/to/StaffDeck]");
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
await copyStaffDeck(resolve(options.staffdeckRoot ?? defaults.staffdeckRoot), output, assembly.sop?.kind === "legacy");
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
    else if (["--profile", "--out", "--staffdeck-root"].includes(argument)) {
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
  if (value === undefined || value === null || (isRecord(value) && value.enabled === false)) return undefined;
  if (!isRecord(value) || value.enabled !== true) {
    throw new Error("modules.sop must be disabled or enabled.");
  }
  const definitionsPath = requiredText(value, "definitionsPath", "sop");
  const defaultSopId = requiredText(value, "defaultSopId", "sop");
  if (value.provider === "staffdeck") {
    return { kind: "legacy", ...value, definitionsPath, defaultSopId };
  }
  if (value.provider !== undefined) {
    throw new Error("modules.sop.provider must be staffdeck or omitted for a protocol binding.");
  }
  for (const field of ["implementationId", "contract", "transport", "endpoint"]) {
    requiredText(value, field, "sop");
  }
  if (value.contract !== "sop.lifecycle/v2" || value.transport !== "sop-http-v2") {
    throw new Error("Unsupported SOP contract or transport for this exporter.");
  }
  return { kind: "external", ...value, definitionsPath, defaultSopId, deployment: readDeployment(value.deployment, "sop") };
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
    "Dockerfile", "docker-entrypoint.sh", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
    "src", "scripts", "ui", "skills",
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

async function copyStaffDeck(source, output, includeSop) {
  if (!includeSop) return;
  const destination = join(output, "staffdeck");
  await copyRequired(join(source, "backend"), join(destination, "backend"));
  await copyRequired(join(source, "portable_sop"), join(destination, "portable_sop"));
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
  if (sop) {
    const source = isAbsolute(sop.definitionsPath)
      ? sop.definitionsPath
      : resolve(dirname(profilePath), sop.definitionsPath);
    await copyRequired(source, join(output, "sops", "definition.yaml"));
    deployment.modules.sop = {
      ...deployment.modules.sop,
      ...(sop.kind === "legacy" ? { endpoint: "http://sop-runtime:8091" } : {}),
      definitionsPath: "/root/.pilotdeck/sops/definition.yaml",
    };
  } else {
    delete deployment.modules.sop;
  }
  rewriteManagedBindings(deployment.modules, externalModules, sop);
  await mkdir(join(output, "config"), { recursive: true });
  await mkdir(join(output, "sops"), { recursive: true });
  await writeFile(join(output, "config", "pilotdeck.yaml"), YAML.stringify(deployment), "utf8");
  await writeFile(join(output, ".env.example"), "PILOTDECK_API_KEY=\nPILOTDECK_REAL_MODEL_API_KEY=\nPILOTDECK_REAL_MODEL_BASE_URL=\nPILOTDECK_PORT=3001\n", "utf8");
  await writeFile(join(output, "compose.yaml"), YAML.stringify(compose(sop, providerNoProxyHosts(profile), externalModules)), "utf8");
  await writeFile(join(output, "README.md"), readme(sop, externalModules), "utf8");
}

async function materializeDeploymentSources(output, profilePath, externalModules, sop) {
  const entries = [
    ...externalModules.map((module) => ({ slot: module.slot, deployment: module.deployment })),
    ...(sop?.deployment ? [{ slot: "sop", deployment: sop.deployment }] : []),
  ];
  for (const entry of entries) {
    if (entry.deployment.mode !== "build") continue;
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
  const service = deploymentServiceName(slot);
  const endpoint = `http://${service}:${deployment.port}`;
  binding.deployment = {
    ...deployment,
    ...(deployment.mode === "build" ? { context: `./modules/${slot}` } : {}),
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
  const managedHosts = managed.map((module) => deploymentServiceName(module.slot));
  const noProxy = [...sopHosts, ...externalHosts, ...managedHosts, ...providerHosts, "localhost", "127.0.0.1"]
    .filter(Boolean).join(",");
  const pilotdeck = {
    build: { context: "./pilotdeck" }, image: "pilotdeck:exported",
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
  if (sop?.kind === "legacy") {
    services["sop-runtime"] = {
      build: { context: "./staffdeck", dockerfile: "portable_sop/Dockerfile" }, image: "staffdeck-sop-runtime:exported",
      healthcheck: { test: ["CMD", "python", "-c", "from urllib.request import urlopen; urlopen('http://localhost:8091/healthz')"], interval: "5s", timeout: "3s", retries: 12 },
    };
    dependencies["sop-runtime"] = { condition: "service_healthy" };
  }
  for (const module of managed) {
    const service = deploymentServiceName(module.slot);
    services[service] = deploymentService(module.slot, module.deployment);
    dependencies[service] = {
      condition: module.deployment.healthPath ? "service_healthy" : "service_started",
    };
  }
  if (Object.keys(dependencies).length > 0) pilotdeck.depends_on = dependencies;
  return { services, volumes: { "pilotdeck-home": {} } };
}

function deploymentServiceName(slot) {
  return `module-${slot.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
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
      context: `./modules/${slot}`,
      ...(deployment.dockerfile ? { dockerfile: deployment.dockerfile } : {}),
    };
  }
  service.environment = {
    MODULE_SLOT: slot,
    MODULE_IMPLEMENTATION_ID: `exported.${slot}`,
    MODULE_PORT: String(deployment.port),
  };
  if (deployment.healthPath) {
    service.healthcheck = {
      test: ["CMD-SHELL", `node -e "fetch('http://localhost:${deployment.port}${deployment.healthPath}').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"`],
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
    ...externalModules,
    ...(sop?.kind === "external" && sop.deployment?.mode === "external"
      ? [{ slot: "sop", implementationId: sop.implementationId, target: sop.endpoint, deployment: sop.deployment }]
      : []),
  ];
  const external = dependencies.length === 0
    ? "none"
    : dependencies.map((module) => `- ${module.slot}: ${module.implementationId} (${module.deployment.mode === "external" ? module.target : `${deploymentServiceName(module.slot)}:${module.deployment.port}`})`).join("\n");
  return `# Exported PilotDeck Deployment\n\nCopy .env.example to .env and set PILOTDECK_API_KEY. Profiles using the real model template must set PILOTDECK_REAL_MODEL_BASE_URL when exporting and PILOTDECK_REAL_MODEL_API_KEY at runtime; credentials are never copied into this export. Then run:\n\n\`docker compose --env-file .env -f compose.yaml up --build\`\n\nSOP binding: ${mode}.\n\nExternal module dependencies (not bundled by this export):\n${external}\n`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
