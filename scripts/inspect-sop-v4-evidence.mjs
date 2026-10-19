import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.argv[2];
if (!root) throw new Error("Usage: node scripts/inspect-sop-v4-evidence.mjs /absolute/path/test-directory");
const db = new DatabaseSync(join(root, "runtime.sqlite"), { readOnly: true });
const runs = db.prepare("SELECT payload FROM sop_v4_runs").all().map(row => JSON.parse(row.payload));
const calls = db.prepare("SELECT payload FROM sop_v4_calls").all().map(row => JSON.parse(row.payload));
const executions = db.prepare("SELECT payload FROM sop_v4_executions").all().map(row => JSON.parse(row.payload));
const events = db.prepare("SELECT sequence,payload FROM sop_v4_events ORDER BY sequence").all().map(row => ({ sequence: row.sequence, ...JSON.parse(row.payload) }));
const requests = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.name.endsWith(".jsonl")) {
      for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
        const value = JSON.parse(line);
        if (value.type === "model_request") requests.push(value);
      }
    }
  }
}
await inspect(join(root, "projects"));
const nodeRequests = requests.filter(entry => entry.sessionId?.startsWith("sop-v4:"));
const invoiceRequests = nodeRequests.filter(entry => JSON.stringify(entry.request.messages).includes("single invoice"));
assert.equal(invoiceRequests.length, 12);
for (const entry of invoiceRequests) {
  const ids = JSON.stringify(entry.request.messages).match(/INV-\d+/g) ?? [];
  assert.equal(new Set(ids).size, 1);
  assert.equal(entry.request.messages.length, 1, "Independent node has only its own input");
}
const rootRequests = requests.filter(entry => entry.sessionId === "batch-agent");
assert.ok(rootRequests.length > 0);
assert.ok(rootRequests.every(entry => !/INV-\d+/.test(JSON.stringify(entry.request.messages))), "Root Agent sees references, not invoice text");
const models = [...new Set(nodeRequests.map(entry => `${entry.request.provider}/${entry.request.model}`))];
assert.ok(models.length >= 2);
const peaks = {};
for (const run of runs) {
  let active = 0, peak = 0;
  for (const event of events.filter(value => calls.some(call => call.runId === run.id && call.id === value.callId))) {
    if (event.type === "node_started") { active++; peak = Math.max(peak, active); }
    if (event.type === "node_result") active--;
  }
  assert.ok(peak <= run.concurrency);
  peaks[run.id] = peak;
}
console.log(JSON.stringify({ root, runs: runs.map(run => ({ runId: run.id, status: run.status, concurrency: run.concurrency, peak: peaks[run.id] })),
  models, requests: nodeRequests.length, invoiceRequests: invoiceRequests.length, filesIsolated: true, rootAttachmentsNotInline: true,
  shareholders: executions.filter(value => value.sopId === "holder").map(value => ({ itemKey: value.itemKey, status: value.status, output: value.output })),
  attempts: calls.filter(value => value.attempt > 1).map(value => ({ callId: value.id, attempt: value.attempt })) }, null, 2));
db.close();
