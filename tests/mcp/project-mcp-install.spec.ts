import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { resolveDefaultCommandShell } from "../../src/runtime/commandShell.js";

test("packaged FunASR installation command runs the bundled Node without npm", async () => {
  const alias = await mkdtemp(join(tmpdir(), "PilotDeck runtime $ "));
  const root = await realpath(alias);
  const previousRoot = process.env.PILOTDECK_RUNTIME_ROOT;
  try {
    const moduleDir = join(root, "dist", "src", "mcp", "runtime");
    await mkdir(moduleDir, {recursive: true});
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "scripts", "install-asr.mjs"), 'console.log("installer uses " + process.execPath);');
    const source = await readFile(join(process.cwd(), "src", "mcp", "runtime", "projectMcpSpec.ts"), "utf8");
    const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}});
    const moduleFile = join(moduleDir, "projectMcpSpec.mjs");
    await writeFile(moduleFile, compiled.outputText);
    const {getPilotDeckInstallCommand} = await import(pathToFileURL(moduleFile).href);
    delete process.env.PILOTDECK_RUNTIME_ROOT;
    assert.equal(getPilotDeckInstallCommand(), `npm --prefix "${root}" run install:asr`);
    // ESM URL resolution and Windows realpath may preserve different casing.
    // They still identify the same runtime directory on Windows.
    process.env.PILOTDECK_RUNTIME_ROOT = process.platform === "win32"
      ? alias.toLowerCase() : alias;
    const command = getPilotDeckInstallCommand();
    assert.equal(command, `'${process.execPath}' '${join(root, "scripts", "install-asr.mjs")}'`);
    const shell = resolveDefaultCommandShell();
    const installed = spawnSync(shell.shell, shell.args(command), {
      encoding: "utf8", windowsVerbatimArguments: shell.windowsVerbatimArguments,
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /installer uses/);
  } finally {
    if (previousRoot === undefined) delete process.env.PILOTDECK_RUNTIME_ROOT;
    else process.env.PILOTDECK_RUNTIME_ROOT = previousRoot;
    await rm(root, {recursive: true, force: true});
  }
});
