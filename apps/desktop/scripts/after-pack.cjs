const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} = require("node:fs");
const { execFileSync } = require("node:child_process");
const { dirname, join, resolve } = require("node:path");

function getResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }

  return join(context.appOutDir, "resources");
}

function materializeSymlinks(root) {
  let count = 0;

  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try {
        const realPath = realpathSync(path);
        rmSync(path, { recursive: true, force: true });
        cpSync(realPath, path, {
          recursive: true,
          force: true,
          dereference: true,
        });
        count += 1;
      } catch {
        rmSync(path, { recursive: true, force: true });
        count += 1;
      }
      return;
    }

    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) {
      visit(join(path, entry));
    }
  }

  if (existsSync(root)) visit(root);
  return count;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasPackagedSigningConfig() {
  return Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
}

function hasDiscoverableMacSigningIdentity() {
  if (process.platform !== "darwin") return false;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return false;

  try {
    const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /(Developer ID Application|Mac Developer):/.test(output);
  } catch {
    return false;
  }
}

function ensureMacSigningFallback(context) {
  if (context.electronPlatformName !== "darwin") return;

  const packager = context.packager;
  const configs = [
    packager.platformSpecificBuildOptions,
    packager._activePackConfig,
  ].filter(Boolean);
  if (configs.some((config) => hasOwn(config, "identity"))) return;
  if (hasPackagedSigningConfig() || hasDiscoverableMacSigningIdentity()) return;

  if (process.env.PILOTDECK_DESKTOP_REQUIRE_SIGNING === "1") {
    throw new Error("A macOS signing identity is required for a desktop release build.");
  }

  for (const config of configs) {
    config.identity = "-";
  }
  console.log("[desktop] no macOS signing identity found; using ad-hoc signing for a non-release build");
}

function getClawHubShimName(context) {
  return context.electronPlatformName === "win32" ? "clawhub.cmd" : "clawhub";
}

function copyRuntimeNodeModules(source, runtimeRoot, label) {
  const target = join(runtimeRoot, "node_modules");
  if (!existsSync(source)) {
    throw new Error(`Desktop ${label} dependencies missing: ${source}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  });
  return target;
}

function verifyPackagedRuntime(target, context, label) {
  for (const dependency of [
    "express",
    "edgeclaw-memory-core",
    "clawhub",
    "exceljs",
    "react",
    "ink",
    "ink-text-input",
  ]) {
    const dependencyPath = join(target, dependency);
    if (!existsSync(dependencyPath)) {
      throw new Error(`Desktop ${label} dependency was not packaged: ${dependencyPath}`);
    }
  }
  for (const requiredFile of [
    join(target, "edgeclaw-memory-core", "lib", "index.js"),
    join(target, "edgeclaw-memory-core", "ui-source", "index.html"),
    join(target, "clawhub", "bin", "clawdhub.js"),
    join(target, ".bin", getClawHubShimName(context)),
  ]) {
    if (!existsSync(requiredFile)) {
      throw new Error(`Desktop ${label} dependency file was not packaged: ${requiredFile}`);
    }
  }
  if (existsSync(join(target, "tsx"))) {
    throw new Error(`Desktop ${label} should not package tsx: ${join(target, "tsx")}`);
  }
}

module.exports = async function afterPack(context) {
  const desktopRoot = resolve(__dirname, "..");
  const resourcesDir = getResourcesDir(context);
  const source = resolve(desktopRoot, ".runtime", "app", "node_modules");
  const runtimeRoot = join(resourcesDir, "runtime");
  const nodeRoot = join(resourcesDir, "node");
  const target = copyRuntimeNodeModules(source, runtimeRoot, "runtime");
  const runtimeSymlinks = materializeSymlinks(runtimeRoot);
  const nodeSymlinks = materializeSymlinks(nodeRoot);
  console.log(
    `[desktop] afterPack materialized ${runtimeSymlinks} runtime symlinks and ${nodeSymlinks} node symlinks`,
  );

  verifyPackagedRuntime(target, context, "runtime");
  ensureMacSigningFallback(context);
};
