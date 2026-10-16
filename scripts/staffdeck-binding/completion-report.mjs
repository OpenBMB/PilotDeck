import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2];
assert.ok(base, 'completion-report.mjs EXPORTED_EVIDENCE_DIRECTORY');
const sources = [
  ['l2-completion', 'faults-complete-result-completion.json', 'faults-complete.mjs', 'Timeout/old key fails; recovery keeps binding, agent and existing session.'],
  ['l2-completion', 'identity-complete-result-completion.json', 'identity-complete.mjs', 'Registered project controls identity; missing/unknown/conflicting fields cannot select another project.'],
  ['l2-completion', 'resources-complete-result-strict-owner.json', 'resources-complete.mjs', 'Owner succeeds; foreign private resource/job ID is denied; lists exclude private rows.'],
  ['l2-completion', 'browser-editor-result-final-editor.json', 'browser-editor.mjs', 'Blank UI project, generated valid SOP, graph edit, save, publish and archive succeed without script errors or horizontal overflow.'],
  ['l2-completion', 'discovery-faults-result.json', 'discovery-faults.mjs', 'Timeout/cancellation/503 rejected; delayed formal route recovers without binding or database changes.'],
  ['l3-completion', 'chat-result-completion.json', 'chat.mjs', 'Real knowledge tool and source marker only in authorized general chat; no SOP-private or cross-project leakage.'],
  ['l3-completion', 'runtime-result.json', 'runtime.mjs', 'A published SOP completes; B stays ordinary chat without SOP tools.'],
  ['l3-completion', 'special-runtime-result-completion.json', 'special-runtime.mjs', 'Three real repetitions complete authorized private knowledge and both human decisions in A.'],
  ['l3-completion', 'special-runtime-result-browser-final.json', 'special-runtime.mjs', 'Desktop/mobile login and approval reply buttons produce accepted receipt and completed A state.'],
  ['l3-completion', 'special-runtime-result-legacy-counts.json', 'special-runtime.mjs', 'Fixed mode wait/restart/reply/resume works; project mode restores bound original agent with unchanged counts.'],
];
const cases = sources.flatMap(([directory, file, script, expected]) => {
  const document = JSON.parse(readFileSync(join(base, directory, file), 'utf8'));
  return (document.results || document).map(result => ({
    id: result.id || result.name,
    ...(result.name ? { scenario: result.name } : {}),
    ...(result.repetition !== undefined ? { repetition: result.repetition } : {}),
    status: result.status,
    command: `env -u NODE_OPTIONS node scripts/staffdeck-binding/${script}`,
    options: directory === 'l3-completion' ? {
      BINDING_QA_RUN_LABEL: file.replace(/^.*-result-/, '').replace(/\.json$/, ''),
      ...(file.includes('browser-final') ? { BINDING_QA_BROWSER_APPROVAL: 'true', BINDING_QA_REPETITIONS: '2', BINDING_QA_ONLY: 'approvals' } : {}),
      ...(file.includes('legacy-counts') ? { BINDING_QA_LEGACY: 'true', BINDING_QA_REPETITIONS: '1', BINDING_QA_ONLY: 'approvals' } : {}),
    } : {},
    environment: directory === 'l2-completion' ? 'CRfI8G SQLite; ports 25910-25914' : 'XU5lt0 SQLite; ports 26010-26013; qwen3.6-flash-distill',
    elapsedMs: result.elapsedMs ?? null,
    expected,
    actual: result.evidence || result.error || result,
    evidence: `${directory}/${file}`,
  }));
});
writeFileSync(join(base, 'completion-cases.json'), JSON.stringify({
  recordedAt: new Date().toISOString(),
  release: 'NOT APPROVED',
  blockingCase: 'L3-DISCOVERY-01: general chat repetitions 1 and 2 timed out before knowledge_query',
  firstFailuresRetained: true,
  cases,
}, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, pass: cases.filter(c => c.status === 'PASS').length,
  fail: cases.filter(c => c.status === 'FAIL').length }));
