import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const eventsPath = resolve(process.argv[2] ?? "");
const candidateRoot = resolve(process.argv[3] ?? "");
const outputPath = resolve(process.argv[4] ?? "");

assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
  "usage: replay-preserved-case09.mjs <events-jsonl> <candidate-root> <output-json>");

const eventsBytes = await readFile(eventsPath);
assert.equal(
  sha256(eventsBytes),
  "ba77de58b432d2f226cb1e6567b3f91bedf03b0e909e12d2aaaa535d82e2ed36",
  "the preserved V24R11 event stream changed",
);

const moduleUrl = pathToFileURL(resolve(candidateRoot, "dist/src/agent/convergence/ProgressLease.js"));
const { ProgressLease } = await import(moduleUrl.href);
const original = eventsBytes.toString("utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((item) => item.event?.type === "agent_status"
    && item.event?.event === "progress_lease_evaluated")
  .map((item) => item.event.detail);

assert.equal(original.length, 21);
assert.deepEqual(original.slice(-3).map(pickOrdinals), [
  {
    progressOrdinal: 5,
    repairOrdinal: 1,
    repairPreparationOrdinal: 1,
    handoffOrdinal: 3,
    decision: "stagnant",
  },
  {
    progressOrdinal: 5,
    repairOrdinal: 2,
    repairPreparationOrdinal: 1,
    handoffOrdinal: 3,
    decision: "boundary_grace",
  },
  {
    progressOrdinal: 5,
    repairOrdinal: 2,
    repairPreparationOrdinal: 2,
    handoffOrdinal: 3,
    decision: "fail_closed",
  },
]);

const lease = new ProgressLease({
  enabled: true,
  mode: "evaluation",
  maxStagnantObservations: 2,
  maxInitialStagnantObservations: 8,
});
const replayed = original.map((item, index) => lease.observe({
  schemaVersion: 1,
  scope: item.scope,
  phase: item.phase,
  stateHash: `replay-state-${index}`,
  ...(item.blockingCode ? { blockingCode: item.blockingCode } : {}),
  remainingCount: item.remainingCount,
  progressOrdinal: item.progressOrdinal,
  repairOrdinal: item.repairOrdinal,
  repairPreparationOrdinal: item.repairPreparationOrdinal,
  handoffOrdinal: item.handoffOrdinal,
}, item.decision === "boundary_grace"
  ? { requested: true, attempted: true, applied: true }
  : { requested: false, attempted: false, applied: false }));

assert.deepEqual(
  replayed.slice(0, -1).map((item) => item?.decision),
  original.slice(0, -1).map((item) => item.decision),
  "V24R12 changed a decision before the isolated failure boundary",
);
assert.equal(replayed.at(-1)?.decision, "repair_preparation_grace");
assert.equal(replayed.at(-1)?.forceBoundaryNext, false);

const result = {
  passed: true,
  fixture: "preserved-v24r11-case09-progress-events",
  eventsSha256: sha256(eventsBytes),
  observationCount: original.length,
  unchangedDecisionPrefix: original.length - 1,
  originalTail: original.slice(-3).map(pickOrdinals),
  replayedTail: replayed.slice(-3).map(pickOrdinals),
  changedDecisionIndex: original.length - 1,
  changedDecision: {
    from: original.at(-1).decision,
    to: replayed.at(-1)?.decision,
  },
  lease: {
    maxInitialStagnantObservations: 8,
    maxStagnantObservations: 2,
  },
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function pickOrdinals(item) {
  return {
    progressOrdinal: item?.progressOrdinal,
    repairOrdinal: item?.repairOrdinal,
    repairPreparationOrdinal: item?.repairPreparationOrdinal,
    handoffOrdinal: item?.handoffOrdinal,
    decision: item?.decision,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
