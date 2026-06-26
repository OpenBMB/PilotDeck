import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readPermissionSettings,
  writePermissionSettings,
} from "../../src/permission/index.js";

test("permission settings persist sudo policy", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-permissions-"));
  const env = { PILOT_HOME: pilotHome };
  try {
    const defaults = readPermissionSettings(env);
    assert.deepEqual(defaults.sudoPolicy, {
      local: "deny",
      remote: "deny",
      remoteHosts: [],
    });

    writePermissionSettings({
      skipPermissions: false,
      sudoPolicy: {
        local: "deny",
        remote: "allow",
        remoteHosts: [
          { host: "prod-*", action: "deny" },
          { host: "10.0.0.*", action: "ask" },
        ],
      },
    }, env);

    const saved = readPermissionSettings(env);
    assert.deepEqual(saved.sudoPolicy, {
      local: "deny",
      remote: "allow",
      remoteHosts: [
        { host: "prod-*", action: "deny" },
        { host: "10.0.0.*", action: "ask" },
      ],
    });
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
