import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAttachmentMaxFileSizeBytes,
  DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB,
  parseWebUiConfig,
} from "../../../src/pilot/config/parseWebUiConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("Web attachment size defaults to 20 MiB for the core runtime", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseWebUiConfig(undefined, diagnostics);

  assert.equal(config.attachments.maxFileSizeMB, DEFAULT_CHAT_ATTACHMENT_MAX_FILE_SIZE_MB);
  assert.equal(chatAttachmentMaxFileSizeBytes(config), 20 * 1024 * 1024);
  assert.deepEqual(diagnostics, []);
});

test("Web attachment size is converted for Trans-Speech without a second tool setting", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseWebUiConfig({ attachments: { maxFileSizeMB: 101 } }, diagnostics);

  assert.equal(config.attachments.maxFileSizeMB, 101);
  assert.equal(chatAttachmentMaxFileSizeBytes(config), 101 * 1024 * 1024);
  assert.deepEqual(diagnostics, []);
});

test("invalid Web attachment limits are fatal in the core runtime", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  parseWebUiConfig({ attachments: { maxFileSizeMB: 0 } }, diagnostics);

  assert.equal(diagnostics[0]?.code, "WEBUI_ATTACHMENTS_MAX_FILE_SIZE_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});
