const { cpSync, existsSync, mkdirSync, rmSync } = require("node:fs");
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

module.exports = async function afterPack(context) {
  const desktopRoot = resolve(__dirname, "..");
  const source = resolve(desktopRoot, ".runtime", "app", "node_modules");
  const target = join(getResourcesDir(context), "runtime", "node_modules");

  if (!existsSync(source)) {
    throw new Error(`Desktop runtime dependencies missing: ${source}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  });
  rmSync(join(target, ".bin"), { recursive: true, force: true });

  for (const dependency of ["tsx", "express", "edgeclaw-memory-core"]) {
    const dependencyPath = join(target, dependency);
    if (!existsSync(dependencyPath)) {
      throw new Error(`Desktop runtime dependency was not packaged: ${dependencyPath}`);
    }
  }
};
