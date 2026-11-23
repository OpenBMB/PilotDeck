#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const isDebug = process.argv.includes("--debug");
const profile = isDebug ? "debug" : "release";

const cargoArgs = ["build"];
if (!isDebug) cargoArgs.push("--release");

const result = spawnSync("cargo", cargoArgs, {
  cwd: pkgRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const artifactName =
  process.platform === "win32"
    ? "pilotdeck_native_sandbox.dll"
    : process.platform === "darwin"
      ? "libpilotdeck_native_sandbox.dylib"
      : "libpilotdeck_native_sandbox.so";

const source = join(pkgRoot, "target", profile, artifactName);
if (!existsSync(source)) {
  throw new Error(`Expected Cargo output not found: ${source}`);
}

const destination = join(pkgRoot, `index.${process.platform}-${process.arch}.node`);
copyFileSync(source, destination);
console.log(`[native-sandbox] Built ${destination}`);

