import assert from "node:assert/strict";
import test from "node:test";

import { parseAdaptersConfig } from "../../../src/pilot/config/parseGatewayConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("Feishu permission mode accepts only default and bypassPermissions", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  assert.deepEqual(parseAdaptersConfig({
    feishu: { enabled: true, permissionMode: "bypassPermissions" },
  }, diagnostics)?.feishu?.permissionMode, "bypassPermissions");
  assert.equal(parseAdaptersConfig({
    feishu: { enabled: true, permissionMode: "plan" },
  }, diagnostics)?.feishu?.permissionMode, undefined);
  assert.deepEqual(diagnostics, []);
});
