import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadStaffDeckSopDefinitions } from "../../src/sop/staffdeck/StaffDeckSopDefinitions.js";

test("SOP definition loader rejects malformed and duplicate definitions", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-sop-definitions-"));
  try {
    const malformed = join(root, "malformed.yaml");
    writeFileSync(malformed, "sops: [\n");
    assert.throws(() => loadStaffDeckSopDefinitions(malformed), /Invalid StaffDeck SOP YAML/);

    const duplicates = join(root, "duplicates.yaml");
    writeFileSync(duplicates, "sops:\n  - id: duplicate\n  - id: duplicate\n");
    assert.throws(() => loadStaffDeckSopDefinitions(duplicates), /duplicate id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
