import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

test("output-style reload keeps existing plugin commands intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-output-style-reload-"));
  const pluginRoot = join(root, ".pilotdeck", "plugins", "style-plugin");
  const manifestPath = join(pluginRoot, "plugin.json");
  const stylePath = join(pluginRoot, "output-styles", "concise.md");
  try {
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await mkdir(join(pluginRoot, "output-styles"), { recursive: true });
    await Promise.all([
      writeFile(
        manifestPath,
        JSON.stringify({ name: "Style Plugin", commands: "commands", outputStyles: "output-styles" }),
        "utf8",
      ),
      writeFile(join(pluginRoot, "commands", "keep.md"), "Keep this command contribution.", "utf8"),
      writeFile(stylePath, "STYLE V1", "utf8"),
    ]);
    const runtime = new PluginRuntime({ projectRoot: root, pilotHome: join(root, "pilot-home") });
    await runtime.refresh();
    assert.deepEqual(runtime.snapshotContributions().commands.map((command) => command.name), ["style-plugin:keep"]);
    assert.deepEqual(runtime.listOutputStyles().map((style) => style.content), ["STYLE V1"]);

    // Removing the command declaration would affect a full plugin refresh,
    // but output-style reload is intentionally scoped to the style registry.
    await Promise.all([
      writeFile(manifestPath, JSON.stringify({ name: "Style Plugin", outputStyles: "output-styles" }), "utf8"),
      writeFile(stylePath, "STYLE V2", "utf8"),
    ]);
    assert.deepEqual(await runtime.reloadOutputStyles(), { changed: ["style-plugin:concise"] });
    assert.deepEqual(runtime.snapshotContributions().commands.map((command) => command.name), ["style-plugin:keep"]);
    assert.deepEqual(runtime.listOutputStyles().map((style) => style.content), ["STYLE V2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
