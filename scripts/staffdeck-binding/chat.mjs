import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const transport = new GatewayTransport({ url: env.PILOTDECK_GATEWAY_URL,
  token: readFileSync(join(qa, 'home/server-token'), 'utf8').trim(), clientName: 'test', requestTimeoutMs: 180000 });
const cases = [
  ['a', 'general', 'Use knowledge_query to find the amber project verification code. Reply with the code and cite the returned source.', 'AMBER_BINDING_7391', true],
  ['a', 'sop-private', 'Use knowledge_query to look for the cobalt approval verification code. Do not guess if there is no evidence.', 'COBALT_SOP_8624', false],
  ['b', 'other-project', 'Use knowledge_query to look for the amber project verification code. Do not guess if there is no evidence.', 'AMBER_BINDING_7391', false],
];
const results = [];
const label = process.env.BINDING_QA_RUN_LABEL ? '-' + process.env.BINDING_QA_RUN_LABEL : '';
try {
  await transport.connect();
  for (let repetition = 0; repetition < Number(process.env.BINDING_QA_REPETITIONS || 3); repetition++) {
    for (const [key, name, prompt, marker, expected] of cases) {
      const project = projects[key], events = [], sessionKey = `binding-chat-${name}-${Date.now()}`;
      const started = Date.now();
      for await (const event of transport.stream('submit_turn', { projectKey: project.fullPath,
        workspaceCwd: project.fullPath, sessionKey, channelKey: 'binding-test', message: prompt,
        mode: 'bypassPermissions' })) events.push(event);
      const output = JSON.stringify(events);
      writeFileSync(join(qa, `chat-${name}-${repetition}${label}.json`), JSON.stringify(events, null, 2));
      const errors = events.filter(event => event.type === 'error');
      const ordinary = name !== 'sop-private' || !output.includes('submit_step_result');
      const status = errors.length || !ordinary || output.includes(marker) !== expected || !output.includes('knowledge_query') ? 'FAIL' : 'PASS';
      results.push({ id: 'L3-CHAT', name, repetition, sessionKey, status, markerPresent: output.includes(marker), errors, elapsedMs: Date.now() - started });
      console.log(status, name, repetition);
    }
  }
} catch (error) { results.push({ id: 'L3-CHAT', status: 'FAIL', error: error.message }); }
finally { transport.close(); writeFileSync(join(qa, `chat-result${label}.json`), JSON.stringify(results, null, 2)); }
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
