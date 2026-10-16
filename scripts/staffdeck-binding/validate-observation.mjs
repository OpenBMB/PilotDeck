import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyProjectBinding } from '../../dist/src/pilot/staffdeck/projectBinding.js';

const qa = process.env.BINDING_QA_ROOT;
const label = process.env.BINDING_QA_RUN_LABEL;
assert.ok(qa && /binding-acceptance-/.test(qa));
assert.match(label ?? '', /^[a-zA-Z0-9_-]+$/);
const read = name => JSON.parse(readFileSync(join(qa, name), 'utf8'));
const observation = read(`observe-result-${label}.json`);
const chat = read(`chat-result-${label}.json`);
const special = read(`special-runtime-result-${label}.json`);
const projects = read('projects.json');
const config = parse(readFileSync(join(qa, 'home/pilotdeck.yaml'), 'utf8'));
const sop = applyProjectBinding(config, projects.a.fullPath, read('env.json'), true).modules.sop;
assert.equal(sop.discoveryTimeoutMs, 90000);
assert.equal(sop.timeoutMs, 30000);
for (const [rows, names, field] of [
  [chat, ['general', 'sop-private', 'other-project'], 'name'],
  [special, ['L3-SOP-PRIVATE', 'L3-APPROVAL-approved', 'L3-APPROVAL-rejected'], 'name'],
]) {
  assert.equal(rows.length, 9);
  for (const name of names) {
    const repeats = rows.filter(row => row[field] === name);
    assert.deepEqual(repeats.map(row => row.repetition).sort(), [0, 1, 2]);
    assert.ok(repeats.every(row => row.status === 'PASS'), `${name} failed`);
  }
}
assert.ok(special.every(row => row.evidence.finalStatus === 'completed'));
const bindings = read('home/staffdeck/project-bindings.json');
const binding = bindings.projects.find(row => row.projectRoot === projects.a.fullPath);
assert.ok(binding, 'Project A binding must remain registered');
for (const row of special) {
  const session = row.evidence.sessionKey;
  const persisted = read(join('home/staffdeck', binding.bindingId, 'state/sessions', Buffer.from(session).toString('base64url') + '.json'));
  assert.equal(persisted.sessionId, session);
  assert.equal(persisted.state.status, 'completed');
  if (row.evidence.decision) {
    const receipt = persisted.resumeRequests[row.evidence.receipt.requestId];
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.message, row.evidence.receipt.message);
    assert.equal(receipt.sessionId, session);
    const decision = persisted.state.slots_json.decision ?? persisted.state.slots_json.binding_approval_decision;
    if (decision !== undefined) assert.equal(decision, row.evidence.decision);
  }
}
const routes = observation.stages.filter(row => row.kind === 'route');
const models = observation.stages.filter(row => row.operation === 'model_stream');
assert.ok(routes.length >= 9);
assert.ok(routes.every(row => !row.errorType && row.elapsedMs < sop.discoveryTimeoutMs));
assert.ok(models.every(row => !row.errorType && row.status === 200));
const wires = models.map(model => {
  const matches = observation.records.filter(row => row.kind === 'model' && row.routeId === model.routeId && row.requestId === model.requestId);
  assert.equal(matches.length, 1, 'Model callback must have exactly one correlated wire request');
  assert.equal(matches[0].status, 200);
  assert.ok(Number.isFinite(matches[0].elapsedMs));
  return matches[0];
});
const timings = rows => ({ count: rows.length, totalMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
  maxMs: Math.max(0, ...rows.map(row => row.elapsedMs)) });
const result = { status: 'PASS', label, budget: { discoveryTimeoutMs: sop.discoveryTimeoutMs, timeoutMs: sop.timeoutMs },
  persistence: { completedSessions: special.length, approvalReceipts: special.filter(row => row.evidence.decision).length,
    bindingId: binding.bindingId, agentId: binding.agentId },
  scenarios: [...chat, ...special], routes: timings(routes),
  catalog: timings(observation.stages.filter(row => row.operation === 'list_model_catalog')),
  modelStages: Object.fromEntries(['initial', 'json_repair', 'plan_repair'].map(stage => [stage, timings(models.filter(row => row.stage === stage))])),
  wire: { count: wires.length, maxHeadersMs: Math.max(...wires.map(row => row.headersMs)),
    maxFirstByteMs: Math.max(...wires.map(row => row.firstByteMs)), maxStreamMs: Math.max(...wires.map(row => row.elapsedMs)) },
  transportErrors: observation.records.filter(row => row.errorCode).map(row => ({ kind: row.kind, errorCode: row.errorCode,
    elapsedMs: row.elapsedMs, routeId: row.routeId, requestId: row.requestId })),
  note: 'Validates existing observations without issuing model requests; historical failures remain in their original exports.' };
writeFileSync(join(qa, `observation-validation-result-${label}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, scenarios: result.scenarios.length, routes: result.routes,
  catalog: result.catalog, modelStages: result.modelStages, wire: result.wire, transportErrors: result.transportErrors }));
