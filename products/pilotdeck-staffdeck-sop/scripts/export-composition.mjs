#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pilotdeckRoot = resolve(scriptDir, "../../..");
const defaults = {
  staffdeckRoot: resolve(pilotdeckRoot, "../StaffDeck-portable-sop"),
  output: resolve(process.cwd(), "pilotdeck-staffdeck-export"),
};

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.profile) {
  console.log("Usage: node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs --profile /path/to/pilotdeck.yaml [--out /path/to/export] [--staffdeck-root /path/to/StaffDeck]");
  process.exit(options.help ? 0 : 2);
}

const profilePath = resolve(options.profile);
const profileText = await readFile(profilePath, "utf8");
const profile = YAML.parse(profileText);
if (!isRecord(profile)) throw new Error(`Profile '${profilePath}' must be a YAML object.`);
const sop = validateProfile(profile);
const output = resolve(options.out ?? defaults.output);
await assertEmptyDirectory(output);

await mkdir(output, { recursive: true });
await copyPilotDeck(output);
await copyStaffDeck(resolve(options.staffdeckRoot ?? defaults.staffdeckRoot), output, Boolean(sop));
await writeDeploymentFiles(output, profile, profilePath, sop);

console.log(JSON.stringify({
  status: "exported",
  output,
  sopEnabled: Boolean(sop),
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
    const module = modules[name];
    if (!isRecord(module) || module.enabled !== true || module.provider !== "pilotdeck") {
      throw new Error(`modules.${name} must be { enabled: true, provider: pilotdeck } in the current export profile.`);
    }
  }
  if (modules.sop === undefined || modules.sop === null || (isRecord(modules.sop) && modules.sop.enabled === false)) return undefined;
  if (!isRecord(modules.sop) || modules.sop.enabled !== true || modules.sop.provider !== "staffdeck") {
    throw new Error("modules.sop must be disabled or use provider: staffdeck.");
  }
  for (const field of ["definitionsPath", "defaultSopId"]) {
    if (typeof modules.sop[field] !== "string" || !modules.sop[field].trim()) {
      throw new Error(`modules.sop.${field} must be a non-empty string.`);
    }
  }
  return modules.sop;
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

async function writeDeploymentFiles(output, profile, profilePath, sop) {
  const deployment = structuredClone(profile);
  deployment.modules = structuredClone(profile.modules);
  if (sop) {
    const source = isAbsolute(sop.definitionsPath)
      ? sop.definitionsPath
      : resolve(dirname(profilePath), sop.definitionsPath);
    await copyRequired(source, join(output, "sops", "definition.yaml"));
    deployment.modules.sop = {
      ...deployment.modules.sop,
      endpoint: "http://sop-runtime:8091",
      definitionsPath: "/root/.pilotdeck/sops/definition.yaml",
    };
  } else {
    delete deployment.modules.sop;
  }
  await mkdir(join(output, "config"), { recursive: true });
  await mkdir(join(output, "sops"), { recursive: true });
  await writeFile(join(output, "config", "pilotdeck.yaml"), YAML.stringify(deployment), "utf8");
  await writeFile(join(output, ".env.example"), "PILOTDECK_API_KEY=\nPILOTDECK_PORT=3001\n", "utf8");
  await writeFile(join(output, "compose.yaml"), YAML.stringify(compose(Boolean(sop), providerNoProxyHosts(profile))), "utf8");
  await writeFile(join(output, "README.md"), readme(Boolean(sop)), "utf8");
}

function compose(sopEnabled, providerHosts) {
  const noProxy = ["sop-runtime", ...providerHosts, "localhost", "127.0.0.1"].join(",");
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
      // A host-level proxy must not intercept the in-network SOP sidecar.
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    },
    volumes: ["pilotdeck-home:/root/.pilotdeck", "./config/pilotdeck.yaml:/root/.pilotdeck/pilotdeck.yaml:ro", "./sops:/root/.pilotdeck/sops:ro"],
  };
  const services = { pilotdeck };
  if (sopEnabled) {
    services["sop-runtime"] = {
      build: { context: "./staffdeck", dockerfile: "portable_sop/Dockerfile" }, image: "staffdeck-sop-runtime:exported",
      healthcheck: { test: ["CMD", "python", "-c", "from urllib.request import urlopen; urlopen('http://localhost:8091/healthz')"], interval: "5s", timeout: "3s", retries: 12 },
    };
    pilotdeck.depends_on = { "sop-runtime": { condition: "service_healthy" } };
  }
  return { services, volumes: { "pilotdeck-home": {} } };
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

function readme(sopEnabled) {
  return `# Exported PilotDeck Deployment\n\nCopy .env.example to .env and set PILOTDECK_API_KEY, then run:\n\n\`docker compose --env-file .env -f compose.yaml up --build\`\n\nSOP runtime included: ${sopEnabled ? "yes" : "no"}.\n`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
