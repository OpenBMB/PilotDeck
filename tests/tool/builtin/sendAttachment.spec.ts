import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { createSendAttachmentTool } from "../../../src/tool/builtin/sendAttachment.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function context(cwd: string, workDir = join(cwd, ".pilotdeck", "work", "session", "turn")): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    env: { PILOTDECK_WORK_DIR: workDir },
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  };
}

test("send_attachment rejects workspace .pilotdeck/work candidates with deliver guidance", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-send-attachment-internal-"));
  try {
    const workDir = join(projectRoot, ".pilotdeck", "work", "session", "turn");
    const candidate = join(workDir, "candidate.docx");
    await mkdir(workDir, { recursive: true });
    await writeFile(candidate, "candidate");

    const tool = createSendAttachmentTool();
    const relativeCandidate = relative(projectRoot, candidate);
    const validation = await tool.validateInput?.({ file_path: relativeCandidate }, context(projectRoot, workDir));

    assert.equal(validation?.ok, false);
    if (validation?.ok === false) {
      assert.equal(validation.issues[0]?.path, "file_path");
      assert.match(validation.issues[0]?.message ?? "", /internal work directory/);
      assert.match(validation.issues[0]?.message ?? "", /delivery workflow/);
    }
    await assert.rejects(
      () => tool.execute({ file_path: relativeCandidate }, context(projectRoot, workDir)),
      /Publish the reviewed final artifact outside PILOTDECK_WORK_DIR/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("send_attachment also rejects a configured work directory outside workspace .pilotdeck/work", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-send-attachment-workspace-"));
  const configuredWorkDir = await mkdtemp(join(tmpdir(), "pilotdeck-send-attachment-custom-work-"));
  try {
    const candidate = join(configuredWorkDir, "candidate.pdf");
    await writeFile(candidate, "candidate");

    const validation = await createSendAttachmentTool().validateInput?.(
      { file_path: candidate },
      context(projectRoot, configuredWorkDir),
    );

    assert.equal(validation?.ok, false);
    if (validation?.ok === false) {
      assert.match(validation.issues[0]?.message ?? "", /PILOTDECK_WORK_DIR/);
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(configuredWorkDir, { recursive: true, force: true });
  }
});

test("send_attachment rejects symlinks that resolve into an internal work directory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-send-attachment-symlink-"));
  try {
    const workDir = join(projectRoot, ".pilotdeck", "work", "session", "turn");
    const candidate = join(workDir, "candidate.docx");
    const publishedAlias = join(projectRoot, "final.docx");
    await mkdir(workDir, { recursive: true });
    await writeFile(candidate, "unreviewed candidate");
    await symlink(candidate, publishedAlias);

    const tool = createSendAttachmentTool();
    const validation = await tool.validateInput?.(
      { file_path: publishedAlias },
      context(projectRoot, workDir),
    );

    assert.equal(validation?.ok, false);
    await assert.rejects(
      () => tool.execute({ file_path: publishedAlias }, context(projectRoot, workDir)),
      /inside PilotDeck's internal work directory/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("send_attachment still sends reviewed files published to the workspace", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-send-attachment-delivered-"));
  try {
    const delivered = join(projectRoot, "final.docx");
    await writeFile(delivered, "reviewed final");

    const tool = createSendAttachmentTool();
    const validation = await tool.validateInput?.({ file_path: delivered }, context(projectRoot));
    assert.deepEqual(validation, { ok: true, input: { file_path: delivered } });

    const result = await tool.execute({ file_path: delivered }, context(projectRoot));
    assert.equal(result.data?.filePath, delivered);
    assert.equal(result.data?.name, "final.docx");
    assert.equal(result.metadata?.attachmentDelivery, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
