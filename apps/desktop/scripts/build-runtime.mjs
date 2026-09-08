#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolvePlaywrightBrowserSet,
  resolvePlaywrightInstallMode,
  resolvePlaywrightMirrorMode,
} from "./download-playwright-browsers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimePackageRoot = resolve(desktopRoot, "runtime");
const defaultRuntimeRoot = resolve(desktopRoot, ".runtime", "app");
const desktopPackage = readJson(resolve(desktopRoot, "package.json"));
const bundledNodeBinary = resolve(
  desktopRoot,
  "resources",
  "node",
  process.platform === "win32" ? "node.exe" : "bin/node",
);
let runtimeRoot = defaultRuntimeRoot;
const targetRuntimeArch = (process.env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch).trim().toLowerCase();
if (!new Set(["arm64", "x64"]).has(targetRuntimeArch)) {
  throw new Error(`Unsupported desktop runtime architecture: ${targetRuntimeArch}`);
}
let currentRuntimeArch = targetRuntimeArch;
const DESKTOP_BUILD = desktopPackage.version;
const DESKTOP_PLAYWRIGHT_BROWSER = "chrome-for-testing";
const uiServerDependencies = [
  "@octokit/rest",
  "bcrypt",
  "better-sqlite3",
  "chokidar",
  "clawhub",
  "cors",
  "exceljs",
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

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function run(command, args, cwd, env = process.env) {
  console.log(`[desktop] ${command} ${args.join(" ")} (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env,
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

function resolvePnpmCliPath() {
  if (isPnpmExecPath) return npmExecPath;
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["pnpm"], {
    encoding: "utf8",
  });
  if (lookup.status !== 0) return undefined;
  const commandPath = lookup.stdout.split(/\r?\n/u).find(Boolean);
  if (!commandPath) return undefined;
  if (process.platform === "win32" && /\.(?:cmd|ps1)$/iu.test(commandPath)) {
    const candidate = resolve(dirname(commandPath), "node_modules", "pnpm", "bin", "pnpm.cjs");
    return existsSync(candidate) ? candidate : undefined;
  }
  return commandPath;
}

const pnpmCliPath = resolvePnpmCliPath();
const packageManager = pnpmCliPath
  ? { command: bundledNodeBinary, args: [pnpmCliPath] }
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };

function getPathEnvKey(env) {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function withBundledNodeEnv(env = process.env) {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey] || "";
  return {
    ...env,
    [pathKey]: [dirname(bundledNodeBinary), currentPath].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
    npm_node_execpath: bundledNodeBinary,
    npm_config_node: bundledNodeBinary,
  };
}

function assertBundledNodeRuntime() {
  if (!existsSync(bundledNodeBinary)) {
    throw new Error(`Desktop bundled Node runtime missing: ${bundledNodeBinary}`);
  }
  const result = spawnSync(
    bundledNodeBinary,
    [
      "-e",
      "const major=Number(process.versions.node.split('.')[0]); if (major !== 22) process.exit(2); import('node:sqlite').then(() => {}, () => process.exit(3));",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Desktop bundled Node must be Node.js 22 with node:sqlite. Current check failed for ${bundledNodeBinary}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`,
    );
  }
}

function runPnpm(args, cwd = repoRoot, env = process.env) {
  const commandArgs = [...packageManager.args, ...args];
  if (process.platform === "darwin" && currentRuntimeArch === "x64") {
    run("arch", ["-x86_64", packageManager.command, ...commandArgs], cwd, withBundledNodeEnv(env));
    return;
  }
  run(packageManager.command, commandArgs, cwd, withBundledNodeEnv(env));
}

function runRuntimeNode(args, cwd, env) {
  if (process.platform === "darwin" && currentRuntimeArch === "x64") {
    run("arch", ["-x86_64", bundledNodeBinary, ...args], cwd, env);
    return;
  }
  run(bundledNodeBinary, args, cwd, env);
}

function withBundledPlaywrightEnv(env = process.env) {
  return {
    ...env,
    PLAYWRIGHT_BROWSERS_PATH: "0",
  };
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

function createRuntimeDependencies(rootPackage, uiPackage) {
  const dependencies = {};
  for (const [name, version] of Object.entries(rootPackage.dependencies ?? {})) {
    if (!name.startsWith("@types/")) {
      dependencies[name] = name === "edgeclaw-memory-core"
        ? "file:../../../src/context/memory/edgeclaw-memory-core"
        : version;
    }
  }
  for (const name of uiServerDependencies) {
    addDependency(dependencies, [uiPackage, rootPackage], name);
  }
  return dependencies;
}

function verifyRuntimePackageManifest(rootPackage, uiPackage, runtimePackage) {
  const expected = createRuntimeDependencies(rootPackage, uiPackage);
  const actual = runtimePackage.dependencies ?? {};
  const dependencyNames = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches = [...dependencyNames]
    .sort()
    .filter((name) => expected[name] !== actual[name])
    .map((name) => `${name}: expected ${expected[name] ?? "<absent>"}, found ${actual[name] ?? "<absent>"}`);

  if (mismatches.length > 0) {
    throw new Error(
      `Desktop runtime dependencies are out of sync with package.json files:\n${mismatches.join("\n")}`,
    );
  }
}

function prepareRuntimeTree(installEnv = process.env) {
  const rootPackage = readJson(resolve(repoRoot, "package.json"));
  const uiPackage = readJson(resolve(repoRoot, "ui", "package.json"));
  const runtimePackage = readJson(resolve(runtimePackageRoot, "package.json"));
  verifyRuntimePackageManifest(rootPackage, uiPackage, runtimePackage);
  const installRoot = resolve(desktopRoot, ".runtime-install");
  rmSync(installRoot, { recursive: true, force: true });
  mkdirSync(installRoot, { recursive: true });
  cpSync(resolve(runtimePackageRoot, "package.json"), resolve(installRoot, "package.json"));
  cpSync(resolve(runtimePackageRoot, "pnpm-lock.yaml"), resolve(installRoot, "pnpm-lock.yaml"));
  runPnpm([
    "install",
    "--prod",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
    "--frozen-lockfile",
    "--prefer-offline",
  ], installRoot, withBundledPlaywrightEnv(installEnv));
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  renameSync(installRoot, runtimeRoot);
  rmSync(resolve(runtimeRoot, "pnpm-lock.yaml"), { force: true });
  copyFiltered(resolve(repoRoot, "dist"), resolve(runtimeRoot, "dist"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "skills"), resolve(runtimeRoot, "skills"), skipBuildArtifact);
  copyFiltered(
    resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core"),
    resolve(runtimeRoot, "src", "context", "memory", "edgeclaw-memory-core"),
    skipBuildArtifact,
  );
  copyFiltered(resolve(repoRoot, "ui", "server"), resolve(runtimeRoot, "ui", "server"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "shared"), resolve(runtimeRoot, "ui", "shared"), skipBuildArtifact);
  copyFiltered(resolve(repoRoot, "ui", "public"), resolve(runtimeRoot, "ui", "public"), () => true);
  copyFiltered(resolve(repoRoot, "ui", "dist"), resolve(runtimeRoot, "ui", "dist"), () => true);
  mkdirSync(resolve(runtimeRoot, "scripts"), { recursive: true });
  cpSync(
    resolve(repoRoot, "scripts", "check-node-runtime.mjs"),
    resolve(runtimeRoot, "scripts", "check-node-runtime.mjs"),
  );
  rewriteUiServerSourceImports(resolve(runtimeRoot, "ui", "server"));
  writeFileSync(
    resolve(runtimeRoot, "ui", "package.json"),
    `${JSON.stringify({
      name: "pilotdeck-ui-runtime",
      version: uiPackage.version,
      private: true,
      type: "module",
    }, null, 2)}\n`,
  );

  installRuntimePlaywrightBrowser();

  removeIfExists(resolve(runtimeRoot, "src"));
}

function installRuntimePlaywrightBrowser() {
  const cli = resolve(runtimeRoot, "node_modules", "@playwright", "mcp", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`Desktop runtime Playwright MCP CLI missing: ${cli}`);
  }
  const installMode = resolvePlaywrightInstallMode(process.env);
  if (installMode === "lazy") {
    removeRuntimePlaywrightBrowsers();
    console.log("[desktop] skipping Playwright browser preinstall (lazy mode)");
    return;
  }
  if (installMode !== "preinstall") {
    throw new Error(`Unsupported desktop Playwright install mode: ${installMode}`);
  }
  const browserSet = resolvePlaywrightBrowserSet(process.env);
  const mirrorMode = resolvePlaywrightMirrorMode(process.env);
  if (mirrorMode === "npmmirror") {
    runRuntimeNode(
      [resolve(desktopRoot, "scripts", "download-playwright-browsers.mjs"), runtimeRoot],
      runtimeRoot,
      withBundledNodeEnv(withBundledPlaywrightEnv()),
    );
    return;
  }
  if (mirrorMode !== "official") {
    throw new Error(`Unsupported desktop Playwright browser mirror: ${mirrorMode}`);
  }
  const args = [cli, "install-browser", DESKTOP_PLAYWRIGHT_BROWSER];
  if (browserSet === "browser-only") {
    args.push("--no-shell");
  }
  runRuntimeNode(
    args,
    runtimeRoot,
    withBundledNodeEnv(withBundledPlaywrightEnv()),
  );
  pruneRuntimePlaywrightBrowsers(browserSet);
}

function removeRuntimePlaywrightBrowsers() {
  rmSync(resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers"), {
    recursive: true,
    force: true,
  });
}

function hasRuntimePlaywrightBrowser() {
  const browsersRoot = resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers");
  return cpSafeReadDir(browsersRoot).some((entry) =>
    /^chromium(?:-|_)/u.test(entry) &&
    existsSync(resolve(browsersRoot, entry, "INSTALLATION_COMPLETE")),
  );
}

function pruneRuntimePlaywrightBrowsers(browserSet) {
  if (browserSet === "full") return;
  if (browserSet !== "browser-only") {
    throw new Error(`Unsupported desktop Playwright browser set: ${browserSet}`);
  }

  const browsersRoot = resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers");
  let removed = 0;
  for (const entry of cpSafeReadDir(browsersRoot)) {
    if (entry === ".links" || entry.startsWith("chromium-")) continue;
    rmSync(resolve(browsersRoot, entry), { recursive: true, force: true });
    removed += 1;
  }
  if (removed) {
    console.log(`[desktop] pruned ${removed} unused Playwright browser entries`);
  }
}

function pruneRuntimeTree() {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const playwrightBrowsersRoot = resolve(nodeModules, "playwright-core", ".local-browsers");
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
    if (path === playwrightBrowsersRoot) return;

    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
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

  visit(nodeModules);
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

function keepOnlySubdirs(parent, keepNames) {
  const keep = new Set(keepNames);
  if (![...keep].some((name) => existsSync(resolve(parent, name)))) return;
  for (const entry of cpSafeReadDir(parent)) {
    if (!keep.has(entry)) removeIfExists(resolve(parent, entry));
  }
}

function getNodePtyPrebuildsToKeep() {
  return [`${process.platform}-${currentRuntimeArch}`];
}

function prunePackageSpecificFiles() {
  const nodeModules = resolve(runtimeRoot, "node_modules");
  const nodePtyRoot = resolve(nodeModules, "node-pty");
  const nodePtyPrebuilds = getNodePtyPrebuildsToKeep();

  removeIfExists(resolve(nodePtyRoot, "deps"));
  removeIfExists(resolve(nodePtyRoot, "node_modules"));
  removeIfExists(resolve(nodePtyRoot, "scripts"));
  removeIfExists(resolve(nodePtyRoot, "src"));
  removeIfExists(resolve(nodePtyRoot, "third_party"));
  removeIfExists(resolve(nodePtyRoot, "typings"));
  keepOnlySubdirs(resolve(nodePtyRoot, "prebuilds"), nodePtyPrebuilds);

  removeIfExists(resolve(nodeModules, "better-sqlite3", "deps"));
  removeIfExists(resolve(nodeModules, "better-sqlite3", "src"));

  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "src"));
  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "tsconfig.json"));
  removeIfExists(resolve(nodeModules, "edgeclaw-memory-core", "tsconfig.base.json"));
}

function rewriteUiServerSourceImports(serverRoot) {
  const extensions = new Set([".js"]);

  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of cpSafeReadDir(path)) {
        visit(resolve(path, entry));
      }
      return;
    }
    if (!extensions.has(path.slice(path.lastIndexOf(".")))) return;

    const original = readFileSync(path, "utf8");
    const rewritten = original
      .replaceAll("../../src/", "../../dist/src/")
      .replaceAll("../../../src/", "../../../dist/src/");
    if (rewritten !== original) {
      writeFileSync(path, rewritten, "utf8");
    }
  }

  visit(serverRoot);
}

run(process.execPath, [resolve(desktopRoot, "scripts", "download-node.mjs")], desktopRoot);
assertBundledNodeRuntime();
if (process.platform === "win32") {
  run(process.execPath, [resolve(desktopRoot, "scripts", "download-git-bash.mjs")], desktopRoot);
}

if (process.env.PILOTDECK_DESKTOP_SKIP_RUNTIME_BUILD !== "1") {
  runPnpm(["--dir", repoRoot, "run", "build"]);
  runPnpm(
    ["--dir", repoRoot, "--filter", "pilotdeck-ui", "run", "build"],
    repoRoot,
    { ...process.env, VITE_PILOTDECK_DESKTOP_BUILD: DESKTOP_BUILD },
  );
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

function stageRuntime(root, env = process.env, options = {}) {
  runtimeRoot = root;
  currentRuntimeArch = options.runtimeArch || targetRuntimeArch;
  try {
    prepareRuntimeTree(env);
    pruneRuntimeTree();
  } finally {
    currentRuntimeArch = targetRuntimeArch;
  }
}

function verifyRuntime(root, label = "runtime", runtimeArch = targetRuntimeArch) {
  const previousRuntimeRoot = runtimeRoot;
  runtimeRoot = root;

  const runtimeRequired = [
    resolve(runtimeRoot, "dist", "src", "cli", "pilotdeck.js"),
    resolve(runtimeRoot, "ui", "dist", "index.html"),
    resolve(runtimeRoot, "ui", "server", "index.js"),
    resolve(runtimeRoot, "scripts", "check-node-runtime.mjs"),
    resolve(runtimeRoot, "node_modules", "express"),
    resolve(runtimeRoot, "node_modules", "exceljs"),
    resolve(runtimeRoot, "node_modules", "react"),
    resolve(runtimeRoot, "node_modules", "ink"),
    resolve(runtimeRoot, "node_modules", "ink-text-input"),
    resolve(runtimeRoot, "node_modules", "@playwright", "mcp", "cli.js"),
    resolve(runtimeRoot, "node_modules", "edgeclaw-memory-core", "lib", "index.js"),
    resolve(runtimeRoot, "node_modules", "edgeclaw-memory-core", "ui-source", "index.html"),
  ];

  for (const file of runtimeRequired) {
    if (!existsSync(file)) {
      throw new Error(`Desktop ${label} staged prerequisite missing: ${file}`);
    }
  }

  if (resolvePlaywrightInstallMode(process.env) === "preinstall" && !hasRuntimePlaywrightBrowser()) {
    throw new Error(`Desktop ${label} preinstall mode did not stage a Playwright Chromium browser.`);
  }

  if (existsSync(resolve(runtimeRoot, "src"))) {
    throw new Error(`Desktop ${label} should not include source tree: ${resolve(runtimeRoot, "src")}`);
  }

  if (existsSync(resolve(runtimeRoot, "node_modules", "tsx"))) {
    throw new Error(`Desktop ${label} should not include tsx: ${resolve(runtimeRoot, "node_modules", "tsx")}`);
  }

  verifyRuntimeNativeModule("better-sqlite3", label, runtimeArch);
  verifyRuntimeModuleImport(resolve(runtimeRoot, "dist", "src", "cli", "pilotdeck.js"), label, runtimeArch);
  verifyRuntimeModuleImport(resolve(runtimeRoot, "ui", "server", "services", "spreadsheetPreview.js"), label, runtimeArch);

  console.log(`[desktop] staged ${label} ready: ${runtimeRoot}`);
  console.log(`[desktop] staged ${label} size: ${formatBytes(directorySize(runtimeRoot))}`);
  runtimeRoot = previousRuntimeRoot;
}

function spawnRuntimeNodeSync(args, options, runtimeArch) {
  if (process.platform === "darwin" && runtimeArch === "x64") {
    return spawnSync("arch", ["-x86_64", bundledNodeBinary, ...args], options);
  }
  return spawnSync(bundledNodeBinary, args, options);
}

function verifyRuntimeModuleImport(modulePath, label, runtimeArch) {
  const importScript = `await import(${JSON.stringify(`file://${modulePath}`)}); process.exit(0);`;
  const result = spawnRuntimeNodeSync(
    ["--input-type=module", "-e", importScript],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: withBundledNodeEnv({
        ...process.env,
        NODE_PATH: resolve(runtimeRoot, "node_modules"),
        PILOTDECK_SKIP_CLI_MAIN: "1",
      }),
    },
    runtimeArch,
  );
  if (result.status !== 0) {
    const failure = result.error?.message || result.stderr || result.stdout || "unknown error";
    throw new Error(
      `Desktop ${label} cannot import runtime entry ${modulePath}: ${failure.trim()}`,
    );
  }
}

function verifyRuntimeNativeModule(moduleName, label, runtimeArch) {
  const nativeProbe = moduleName === "better-sqlite3"
    ? `const Database=require(${JSON.stringify(moduleName)}); const db=new Database(":memory:"); db.close();`
    : `require(${JSON.stringify(moduleName)})`;
  const result = spawnRuntimeNodeSync(
    ["-e", nativeProbe],
    {
      cwd: runtimeRoot,
      encoding: "utf8",
      env: withBundledNodeEnv({
        ...process.env,
        NODE_PATH: resolve(runtimeRoot, "node_modules"),
      }),
    },
    runtimeArch,
  );
  if (result.status !== 0) {
    throw new Error(
      `Desktop ${label} cannot load native module ${moduleName}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
}

stageRuntime(defaultRuntimeRoot, process.env, { runtimeArch: targetRuntimeArch });
verifyRuntime(defaultRuntimeRoot, "runtime", targetRuntimeArch);
