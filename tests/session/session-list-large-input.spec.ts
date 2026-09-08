import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getPilotProjectChatDir } from "../../src/pilot/paths.js";
import { searchChatHistory } from "../../src/session/search/searchChatHistory.js";
import { listProjectSessions, searchSessionsByTitle } from "../../src/session/storage/SessionList.js";

const NOW = "2026-08-16T09:00:00.000Z";

function entry(type: string, sessionId: string, sequence: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, sessionId, turnId: "turn-1", sequence, createdAt: NOW, ...extra };
}

test("lists historical sessions whose large inline image hides metadata from the lite preview", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const largeSessionId = "web:s_large-image";
    const largeTitle = "Recovered PilotDeck session title";
    const largeInput = entry("accepted_input", largeSessionId, 1, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Build the briefing" },
          { type: "image", source: "base64", data: "x".repeat(2 * 1024 * 1024) },
        ],
      }],
    });
    const largeMetadata = entry("session_metadata", largeSessionId, 2, {
      metadata: { aiTitle: largeTitle, firstPrompt: "p".repeat(130 * 1024) },
    });
    const largeTail = entry("assistant_message", largeSessionId, 3, {
      message: { role: "assistant", content: [{ type: "text", text: `findable ${"y".repeat(160 * 1024)}` }] },
    });
    const latestInput = entry("accepted_input", largeSessionId, 4, {
      messages: [{ role: "user", content: [{ type: "text", text: "Latest prompt" }] }],
    });
    const modelSelectionPatch = entry("session_metadata", largeSessionId, 5, {
      metadata: { modelSelection: { mode: "auto" } },
    });
    await writeFile(
      join(chatDir, `${largeSessionId}.jsonl`),
      `${JSON.stringify(largeInput)}\n${JSON.stringify(largeMetadata)}\n${JSON.stringify(largeTail)}\n${JSON.stringify(latestInput)}\n${JSON.stringify(modelSelectionPatch)}\n`,
    );

    const smallSessionId = "web:s_small";
    await writeFile(
      join(chatDir, `${smallSessionId}.jsonl`),
      `${JSON.stringify(entry("session_metadata", smallSessionId, 1, { metadata: { aiTitle: "Small session" } }))}\n`,
    );

    const invalidSessionId = "web:s_invalid";
    const invalidTail = entry("assistant_message", invalidSessionId, 3, {
      message: { role: "assistant", content: [{ type: "text", text: "z".repeat(160 * 1024) }] },
    });
    await writeFile(
      join(chatDir, `${invalidSessionId}.jsonl`),
      `${JSON.stringify(largeInput).replace(largeSessionId, invalidSessionId)}\n`
        + '{"type":"session_metadata","metadata":{"aiTitle":\n'
        + `${JSON.stringify(invalidTail)}\n`,
    );

    const sessions = await listProjectSessions({ projectRoot, pilotHome });
    assert.deepEqual(
      sessions.map((session) => [session.sessionId, session.summary]).sort((a, b) => a[0].localeCompare(b[0])),
      [
        [largeSessionId, largeTitle],
        [smallSessionId, "Small session"],
      ],
    );

    const search = await searchChatHistory({ projectRoot, pilotHome, query: "findable" });
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].sessionId, largeSessionId);
    assert.equal(search.matches[0].sessionTitle, largeTitle);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("prefers a newer oversized metadata title over an older title in the lite head", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const sessionId = "web:s_new-fork-title";
    const oldMetadata = entry("session_metadata", sessionId, 1, {
      metadata: { title: "Old parent title" },
    });
    const filler = entry("assistant_message", sessionId, 2, {
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(160 * 1024) }] },
    });
    const newMetadata = entry("session_metadata", sessionId, 3, {
      metadata: { title: "New fork title", firstPrompt: "p".repeat(130 * 1024) },
    });
    await writeFile(
      join(chatDir, `${sessionId}.jsonl`),
      `${JSON.stringify(oldMetadata)}\n${JSON.stringify(filler)}\n${JSON.stringify(newMetadata)}\n`,
    );

    const sessions = await listProjectSessions({ projectRoot, pilotHome });
    assert.deepEqual(sessions.map((session) => [session.sessionId, session.summary]), [[sessionId, "New fork title"]]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("preserves createdAt when metadata recovery has no lite summary", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const sessionId = "web:s_recovered-created-at";
    const largeInput = entry("accepted_input", sessionId, 1, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Create a presentation" },
          { type: "image", source: "base64", data: "x".repeat(2 * 1024 * 1024) },
        ],
      }],
    });
    const largeMetadata = entry("session_metadata", sessionId, 2, {
      metadata: { aiTitle: "Recovered title", firstPrompt: "p".repeat(130 * 1024) },
    });
    const largeTail = entry("assistant_message", sessionId, 3, {
      message: { role: "assistant", content: [{ type: "text", text: "y".repeat(160 * 1024) }] },
    });
    await writeFile(
      join(chatDir, `${sessionId}.jsonl`),
      `${JSON.stringify(largeInput)}\n${JSON.stringify(largeMetadata)}\n${JSON.stringify(largeTail)}\n`,
    );

    const [session] = await listProjectSessions({ projectRoot, pilotHome });
    assert.equal(session?.summary, "Recovered title");
    assert.equal(session?.createdAt, Date.parse(NOW));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("does not trust a trailing metadata patch as a full title snapshot", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const sessionId = "web:s_tail-patch";
    const oldMetadata = entry("session_metadata", sessionId, 1, {
      metadata: { title: "Old title" },
    });
    const filler = entry("assistant_message", sessionId, 2, {
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(160 * 1024) }] },
    });
    const newMetadata = entry("session_metadata", sessionId, 3, {
      metadata: { title: "Recovered title", firstPrompt: "p".repeat(130 * 1024) },
    });
    const trailingPatch = entry("session_metadata", sessionId, 4, {
      metadata: { aiTitle: "Later title patch" },
    });
    await writeFile(
      join(chatDir, `${sessionId}.jsonl`),
      `${JSON.stringify(oldMetadata)}\n${JSON.stringify(filler)}\n${JSON.stringify(newMetadata)}\n${JSON.stringify(trailingPatch)}\n`,
    );

    const [session] = await listProjectSessions({ projectRoot, pilotHome });
    assert.equal(session?.summary, "Recovered title");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("uses firstPrompt from a titled tail snapshot for title search", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const sessionId = "web:s_tail-snapshot-prompt";
    const originalPrompt = "Original presentation prompt";
    const largeInput = entry("accepted_input", sessionId, 1, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: originalPrompt },
          { type: "image", source: "base64", data: "x".repeat(256 * 1024) },
        ],
      }],
    });
    const snapshot = entry("session_metadata", sessionId, 2, {
      metadata: {
        isSnapshot: true,
        aiTitle: "Titled snapshot",
        firstPrompt: originalPrompt,
        lastPrompt: originalPrompt,
      },
    });
    await writeFile(join(chatDir, `${sessionId}.jsonl`), `${JSON.stringify(largeInput)}\n${JSON.stringify(snapshot)}\n`);

    const sessions = await searchSessionsByTitle({ projectRoot, pilotHome, query: "original presentation" });
    assert.deepEqual(sessions.map((session) => session.sessionId), [sessionId]);
    assert.equal(sessions[0]?.firstPrompt, originalPrompt);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("uses a prompt-only tail snapshot without requiring a generated title", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-session-list-home-"));
  try {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    await mkdir(chatDir, { recursive: true });

    const sessionId = "web:s_prompt-snapshot";
    const largeInput = entry("accepted_input", sessionId, 1, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "First prompt" },
          { type: "image", source: "base64", data: "x".repeat(256 * 1024) },
        ],
      }],
    });
    const snapshot = entry("session_metadata", sessionId, 2, {
      metadata: {
        isSnapshot: true,
        firstPrompt: "First prompt",
        lastPrompt: "Latest prompt",
      },
    });
    await writeFile(join(chatDir, `${sessionId}.jsonl`), `${JSON.stringify(largeInput)}\n${JSON.stringify(snapshot)}\n`);

    const [session] = await listProjectSessions({ projectRoot, pilotHome });
    assert.equal(session?.summary, "Latest prompt");
    assert.equal(session?.firstPrompt, "First prompt");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
