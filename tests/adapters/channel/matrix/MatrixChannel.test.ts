import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MatrixChannel } from "../../../../src/adapters/channel/matrix/MatrixChannel.js";

test("MatrixChannel defaults storage under pilotHome", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-matrix-storage-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const channel = new MatrixChannel({ pilotHome }) as unknown as { storagePath: string };

    assert.equal(channel.storagePath, join(pilotHome, "matrix-bot-storage.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
