import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa, 'Set BINDING_QA_ROOT');
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const token = readFileSync(join(qa, 'home/server-token'), 'utf8').trim();
const transport = new GatewayTransport({ url: env.PILOTDECK_GATEWAY_URL, token, clientName: 'test', requestTimeoutMs: 180000 });
const results = [];
const repetitions = Number(process.env.BINDING_QA_REPETITIONS || 1);
try {
  await transport.connect();
  for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const [key, prompt] of [['a', 'BINDING_A_SOP'], ['b', 'Hello, reply with a short greeting']]) {
    const project = projects[key], sessionKey = `binding-${key}-${Date.now()}`;
    const events = [];
    for await (const event of transport.stream('submit_turn', { projectKey: project.fullPath,
      workspaceCwd: project.fullPath, sessionKey, channelKey: 'binding-test', message: prompt,
      mode: 'bypassPermissions' })) events.push(event);
    writeFileSync(join(qa, `runtime-${key}-${repetition}.json`), JSON.stringify(events, null, 2));
    assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
    if (key === 'a') {
      const state = JSON.parse(readFileSync(join(qa, 'home/staffdeck', project.staffdeckBinding.bindingId,
        'state/sessions', `${Buffer.from(sessionKey).toString('base64url')}.json`), 'utf8'));
      assert.equal(state.state.status, 'completed');
      results.push({ id: 'I02', project: key, status: 'PASS', sessionKey, state: state.state.status });
    } else {
      assert.ok(!JSON.stringify(events).includes('submit_step_result'));
      assert.ok(events.some(event => JSON.stringify(event).includes('assistant')));
      results.push({ id: 'I02', project: key, status: 'PASS', sessionKey, ordinaryChat: true });
    }
  }
  }
} catch (error) { results.push({ id: 'I02-RUNTIME', status: 'FAIL', error: error.message }); process.exitCode = 1; }
finally { transport.close(); writeFileSync(join(qa, 'runtime-result.json'), JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
