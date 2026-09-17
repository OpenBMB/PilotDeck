import assert from "node:assert/strict";
import test from "node:test";

import { parseAdaptersConfig } from "../../../src/pilot/config/parseGatewayConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("message channels stay off until explicitly enabled, even with credentials", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  assert.equal(parseAdaptersConfig(undefined, diagnostics), undefined);
  const adapters = parseAdaptersConfig({
    feishu: { appId: "test", appSecret: "test" },
    weixin: {},
    wecom: { token: "test", extra: { secret: "test" } },
  }, diagnostics);
  assert.equal(adapters?.feishu?.enabled, false);
  assert.equal(adapters?.weixin?.enabled, false);
  assert.equal(adapters?.wecom?.enabled, false);
  assert.deepEqual(diagnostics, []);
});

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
