import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalMessage } from "../../../src/model/index.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { readCompactSnapshot } from "../../../src/session/transcript/CompactSnapshot.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";

const workerPath = new URL("./native-compaction-process-recovery-worker.js", import.meta.url);

test("native summary failure, cancellation, and child-process termination recover the durable compaction surface", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-native-compaction-process-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const before = await runAndKill(root, "before");
  assert.equal(before.signalCode, "SIGKILL");
  const beforeTranscript = await readTranscript(transcriptPath(root, "before"));
  assert.deepEqual(beforeTranscript.diagnostics, []);
  assert.equal(compactBoundaryCount(beforeTranscript.entries), 0);
  assert.equal(beforeTranscript.entries.filter((entry) => entry.type === "compaction_started").length, 1);
  const beforeRecovery = await recover(root, "before");
  assert.deepEqual(beforeRecovery.diagnostics, []);
  assert.equal(beforeRecovery.compactBoundaries, 0);
  assert.equal(beforeRecovery.requests.length, 1);
  assertCompleteOriginalRecoveryRequest(beforeRecovery.requests[0]);

  const failure = await runNativeFailure(root, "failure", "summary-failure");
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.compactBoundaries, 0);
  assert.equal(failure.compactionFailures, 1);
  const failureRecovery = await recover(root, "failure");
  assert.deepEqual(failureRecovery.diagnostics, []);
  assert.equal(failureRecovery.compactBoundaries, 0);
  assertCompleteOriginalRecoveryRequest(failureRecovery.requests[0]);

  const cancelled = await runNativeFailure(root, "cancel", "summary-cancel");
  assert.equal(cancelled.outcome, "aborted");
  assert.equal(cancelled.compactBoundaries, 0);
  assert.equal(cancelled.compactionFailures, 1);
  const cancellationRecovery = await recover(root, "cancel");
  assert.deepEqual(cancellationRecovery.diagnostics, []);
  assert.equal(cancellationRecovery.compactBoundaries, 0);
  assertCompleteOriginalRecoveryRequest(cancellationRecovery.requests[0]);

  const after = await runAndKill(root, "after");
  assert.equal(after.signalCode, "SIGKILL");
  const afterTranscript = await readTranscript(transcriptPath(root, "after"));
  assert.deepEqual(afterTranscript.diagnostics, []);
  assert.equal(compactBoundaryCount(afterTranscript.entries), 1);
  const afterRecovery = await recover(root, "after");
  assert.deepEqual(afterRecovery.diagnostics, []);
  assert.equal(afterRecovery.compactBoundaries, 1);
  assert.equal(afterRecovery.requests.length, 1);
  const boundary = afterTranscript.entries.find((entry) => entry.type === "control_boundary"
    && entry.boundary.kind === "compact"
    && entry.boundary.subtype === "compact_boundary");
  assert.ok(boundary && boundary.type === "control_boundary");
  if (boundary?.type === "control_boundary"
    && boundary.boundary.kind === "compact"
    && boundary.boundary.subtype === "compact_boundary") {
    assert.deepEqual(afterRecovery.requests[0], [
      ...(readCompactSnapshot(boundary) ?? boundary.boundary.replacementMessages ?? []),
      continuationMessage(),
    ]);
  }
});

async function runAndKill(root: string, scenario: "before" | "after") {
  const phase = scenario === "before" ? "before-commit" : "after-commit";
  const child = spawn(process.execPath, [workerPath.pathname, phase, root], {
    env: { ...process.env, PILOTDECK_COMPACTION_RECOVERY_SCENARIO: scenario },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    await waitForFile(join(root, `${scenario}.${phase}.ready.json`));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [exitCode, signalCode] = await exited as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, null, stderr.join(""));
    return { signalCode };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    throw error;
  }
}

async function recover(root: string, scenario: "before" | "after" | "failure" | "cancel"): Promise<RecoveryReport> {
  const child = spawn(process.execPath, [workerPath.pathname, "recover", root], {
    env: { ...process.env, PILOTDECK_COMPACTION_RECOVERY_SCENARIO: scenario },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(exitCode, 0, stderr.join(""));
  return JSON.parse(await readFile(join(root, `${scenario}.recover.report.json`), "utf8")) as RecoveryReport;
}

async function runNativeFailure(
  root: string,
  scenario: "failure" | "cancel",
  phase: "summary-failure" | "summary-cancel",
): Promise<NativeFailureReport> {
  const child = spawn(process.execPath, [workerPath.pathname, phase, root], {
    env: { ...process.env, PILOTDECK_COMPACTION_RECOVERY_SCENARIO: scenario },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const [exitCode] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(exitCode, 0, stderr.join(""));
  return JSON.parse(await readFile(join(root, `${scenario}.${phase}.report.json`), "utf8")) as NativeFailureReport;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for native compaction worker signal: ${path}`);
}

function transcriptPath(root: string, scenario: string): string {
  return createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: `native-compaction-process-${scenario}`,
  }).transcriptPath;
}

function compactBoundaryCount(entries: Awaited<ReturnType<typeof readTranscript>>["entries"]): number {
  return entries.filter((entry) => entry.type === "control_boundary"
    && entry.boundary.kind === "compact"
    && entry.boundary.subtype === "compact_boundary").length;
}

function assertCompleteOriginalRecoveryRequest(request: CanonicalMessage[] | undefined): void {
  const expected = [...seedHistory(), continuationMessage()];
  assert.deepEqual(request, expected);
  assert.notDeepEqual(request, [...expected.slice(0, 2), continuationMessage()]);
  assert.notDeepEqual(request, [...expected, continuationMessage()]);
  assert.notDeepEqual(request, [{ ...expected[0]!, role: "assistant" }, ...expected.slice(1)]);
}

function seedHistory(): CanonicalMessage[] {
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "Original request must survive an uncommitted compaction." }] },
    { role: "assistant", content: [{ type: "text", text: "Original response must survive an uncommitted compaction." }] },
    { role: "user", content: [{ type: "text", text: "Earlier durable planning detail for native summary generation." }] },
    { role: "assistant", content: [{ type: "text", text: "Earlier durable planning response for native summary generation." }] },
  ];
  for (let index = 0; index < 6; index += 1) {
    history.push(
      { role: "user", content: [{ type: "text", text: `Durable history user turn ${index}.` }] },
      { role: "assistant", content: [{ type: "text", text: `Durable history assistant turn ${index}.` }] },
    );
  }
  return history;
}

function continuationMessage(): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text: "Continue after the child process restart." }] };
}

type RecoveryReport = {
  diagnostics: unknown[];
  compactBoundaries: number;
  compactionStarts: number;
  requests: CanonicalMessage[][];
};

type NativeFailureReport = {
  phase: "summary-failure" | "summary-cancel";
  outcome: "failed" | "aborted";
  compactBoundaries: number;
  compactionFailures: number;
};
