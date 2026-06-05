#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".runtime", "app");

const uiServerDependencies = [
  "@octokit/rest",
  "bcrypt",
  "better-sqlite3",
  "chokidar",
  "cors",
  "express",
  "gray-matter",
  "jsonwebtoken",
  "jszip",
  "mime-types",
  "multer",
  "node-fetch",
  "node-pty",
  "shell-quote",
  "undici",
  "web-push",
  "ws",
  "yaml",
];

const runtimeDevDependencies = [
  "tsx",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function run(command, args, cwd) {
  console.log(`[desktop] ${command} ${args.join(" ")} (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

const npmExecPath = process.env.npm_execpath ?? "";
const isPnpmExecPath = npmExecPath.replaceAll("\\", "/").includes("/pnpm/");
const packageManager = isPnpmExecPath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };

function runPnpm(args, cwd = repoRoot) {
  run(packageManager.command, [...packageManager.args, ...args], cwd);
}

function copyFiltered(from, to, filter) {
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = relative(from, source).replaceAll("\\", "/");
      return filter(rel, source);
    },
  });
}

function skipBuildArtifact(rel) {
  return !(
    rel.endsWith(".map") ||
    rel.endsWith(".d.ts") ||
    rel.endsWith(".tsbuildinfo")
  );
}

function skipRuntimeSource(rel) {
  if (!rel) return true;
  if (rel.includes("/__tests__/") || rel.includes("/tests/")) return false;
  if (rel.endsWith(".map") || rel.endsWith(".tsbuildinfo")) return false;
  return true;
}

function addDependency(target, sources, name) {
  for (const source of sources) {
    const version = source.dependencies?.[name] ?? source.devDependencies?.[name];
    if (version) {
      target[name] = version;
      return;
    }
  }
  throw new Error(`Missing runtime dependency version for ${name}`);
}

function createRuntimePackageJson(rootPackage, uiPackage) {
  const dependencies = {};
  for (const [name, version] of Object.entries(rootPackage.dependencies ?? {})) {
    if (!name.startsWith("@types/")) {
      dependencies[name] = version;
    }
  }
  for (const name of uiServerDependencies) {
    addDependency(dependencies, [uiPackage, rootPackage], name);
  }
  for (const name of runtimeDevDependencies) {
    addDependency(dependencies, [rootPackage, uiPackage], name);
  }

  return {
    name: "pilotdeck-desktop-runtime",
    version: rootPackage.version,
    private: true,
    type: "module",
    packageManager: rootPackage.packageManager,
    dependencies,
  };
}

function prepareRuntimeTree() {
  const rootPackage = readJson(resolve(repoRoot, "package.json"));
  const uiPackage = readJson(resolve(repoRoot, "ui", "package.json"));
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  writeFileSync(
    resolve(runtimeRoot, "package.json"),
    `${JSON.stringify(createRuntimePackageJson(rootPackage, uiPackage), null, 2)}\n`,
  );
  writeFileSync(
    resolve(runtimeRoot, "tsconfig.json"),
    readFileSync(resolve(repoRoot, "tsconfig.json")),
  );

  copyFiltered(resolve(repoRoot, "dist"), resolve(runtimeRoot, "dist"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "src"), resolve(runtimeRoot, "src"), skipRuntimeSource);
  copyFiltered(resolve(repoRoot, "ui", "server"), resolve(runtimeRoot, "ui", "server"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "shared"), resolve(runtimeRoot, "ui", "shared"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "public"), resolve(runtimeRoot, "ui", "public"), () => true);
  copyFiltered(resolve(repoRoot, "ui", "dist"), resolve(runtimeRoot, "ui", "dist"), () => true);
  writeFileSync(
    resolve(runtimeRoot, "ui", "package.json"),
    `${JSON.stringify({
      name: "pilotdeck-ui-runtime",
      version: uiPackage.version,
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );

  runPnpm([
    "install",
    "--prod",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
    "--no-frozen-lockfile",
    "--prefer-offline",
  ], runtimeRoot);
}

function pruneRuntimeTree() {
  const pruneExtensions = new Set([".map", ".d.ts", ".pdb", ".tsbuildinfo"]);
  const pruneDirs = new Set([
    ".cache",
    ".github",
    ".vite",
    "coverage",
    "docs",
    "example",
    "examples",
    "test",
    "tests",
  ]);

  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const name = path.split(/[\\/]/).pop();
      if (pruneDirs.has(name)) {
        rmSync(path, { recursive: true, force: true });
        return;
      }
      for (const entry of cpSafeReadDir(path)) {
        visit(resolve(path, entry));
      }
      return;
    }

    for (const ext of pruneExtensions) {
      if (path.endsWith(ext)) {
        rmSync(path, { force: true });
        return;
      }
    }
  }

  visit(resolve(runtimeRoot, "node_modules"));
  prunePackageSpecificFiles();
}

function cpSafeReadDir(path) {
  try {
    return statSync(path).isDirectory() ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function directorySize(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of cpSafeReadDir(path)) {
    total += directorySize(resolve(path, entry));
  }
  return total;
}

function removeIfExists(path) {
  rmSync(path, { recursive: true, force: true });
}

function keepOnlySubdir(parent, keepName) {
  if (!existsSync(resolve(parent, keepName))) return;
  for (const entry of cpSafeReadDir(parent)) {
    if (entry !== keepName) removeIfExists(resolve(parent, entry));
  }
}

function prunePackageSpecificFiles() {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const nodePtyRoot = resolve(nodeModules, "node-pty");
  const nodePtyPrebuild = `${process.platform}-${process.arch}`;

  removeIfExists(resolve(nodePtyRoot, "deps"));
  removeIfExists(resolve(nodePtyRoot, "node_modules"));
  removeIfExists(resolve(nodePtyRoot, "scripts"));
  removeIfExists(resolve(nodePtyRoot, "src"));
  removeIfExists(resolve(nodePtyRoot, "third_party"));
  removeIfExists(resolve(nodePtyRoot, "typings"));
  keepOnlySubdir(resolve(nodePtyRoot, "prebuilds"), nodePtyPrebuild);

  removeIfExists(resolve(nodeModules, "better-sqlite3", "deps"));
  removeIfExists(resolve(nodeModules, "better-sqlite3", "src"));
}

run(process.execPath, [resolve(desktopRoot, "scripts", "download-node.mjs")], desktopRoot);

if (process.env.PILOTDECK_DESKTOP_SKIP_RUNTIME_BUILD !== "1") {
  runPnpm(["--dir", repoRoot, "run", "build"]);
  runPnpm(["--dir", repoRoot, "--filter", "pilotdeck-ui", "run", "build"]);
}

const sourceRequired = [
  resolve(repoRoot, "dist", "src", "cli", "pilotdeck.js"),
  resolve(repoRoot, "ui", "dist", "index.html"),
  resolve(repoRoot, "ui", "server", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "lib", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "ui-source", "index.html"),
];

for (const file of sourceRequired) {
  if (!existsSync(file)) {
    throw new Error(`Desktop runtime source prerequisite missing: ${file}`);
  }
}

prepareRuntimeTree();
pruneRuntimeTree();

const runtimeRequired = [
  resolve(runtimeRoot, "dist", "src", "cli", "pilotdeck.js"),
  resolve(runtimeRoot, "ui", "dist", "index.html"),
  resolve(runtimeRoot, "ui", "server", "index.js"),
  resolve(runtimeRoot, "src", "context", "memory", "edgeclaw-memory-core", "lib", "index.js"),
  resolve(runtimeRoot, "src", "context", "memory", "edgeclaw-memory-core", "ui-source", "index.html"),
  resolve(runtimeRoot, "node_modules", "tsx"),
  resolve(runtimeRoot, "node_modules", "express"),
  resolve(runtimeRoot, "node_modules", "edgeclaw-memory-core"),
];

for (const file of runtimeRequired) {
  if (!existsSync(file)) {
    throw new Error(`Desktop runtime staged prerequisite missing: ${file}`);
  }
}

console.log(`[desktop] staged runtime ready: ${runtimeRoot}`);
console.log(`[desktop] staged runtime size: ${formatBytes(directorySize(runtimeRoot))}`);
