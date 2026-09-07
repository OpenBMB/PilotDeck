import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { resolveBrowserUseOutputDir } from "../../src/cli/createLocalGateway.js";
import { resolveProjectStorageId } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

test("resolveBrowserUseOutputDir stores browser-use output under pilot home", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-browser-use-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "Program Files", "PilotDeck", "resources", "runtime");
    const sessionKey = "feishu-chat=oc_fe6d8e3b3960b8575b683b84c2a416d4/general";

    const outputDir = resolveBrowserUseOutputDir({ pilotHome, projectRoot, sessionKey });

    assert.equal(
      outputDir,
      join(
        pilotHome,
        "browser_screenshots",
        resolveProjectStorageId(projectRoot, pilotHome),
        sanitizeSessionIdForPath(sessionKey),
      ),
    );
    assert.ok(!relative(pilotHome, outputDir).startsWith(".."));
    assert.ok(!outputDir.includes(join(projectRoot, ".pilotdeck")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
