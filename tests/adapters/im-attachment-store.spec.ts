import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isPathWithinDirectory } from "../../src/adapters/channel/protocol/ImAttachmentStore.js";

test("Windows attachment paths accept only the target directory and its descendants", () => {
  const directory = "C:\\PilotDeck\\attachments\\chat-1";

  assert.equal(isPathWithinDirectory(directory, directory, path.win32), true);
  assert.equal(
    isPathWithinDirectory("C:\\PilotDeck\\attachments\\chat-1\\image.png", directory, path.win32),
    true,
  );
  assert.equal(
    isPathWithinDirectory("C:\\PilotDeck\\attachments\\chat-1\\nested\\file.pdf", directory, path.win32),
    true,
  );
});

test("Windows attachment paths reject prefix, traversal, absolute, and cross-drive escapes", () => {
  const directory = "C:\\PilotDeck\\attachments\\chat-1";
  const escaped = [
    "C:\\PilotDeck\\attachments\\chat-10\\image.png",
    "C:\\PilotDeck\\attachments\\outside.png",
    "C:\\PilotDeck\\attachments\\chat-1\\..\\outside.png",
    "D:\\PilotDeck\\attachments\\chat-1\\image.png",
  ];

  for (const candidate of escaped) {
    assert.equal(isPathWithinDirectory(candidate, directory, path.win32), false, candidate);
  }
});
