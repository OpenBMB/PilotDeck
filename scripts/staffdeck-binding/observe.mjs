import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { applyProjectBinding } from '../../dist/src/pilot/staffdeck/projectBinding.js';

const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const qa = process.env.BINDING_QA_ROOT;
assert.ok(qa && /binding-acceptance-/.test(qa), 'Use an isolated binding-acceptance fixture');
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const configPath = join(qa, 'home/pilotdeck.yaml');
const original = readFileSync(configPath, 'utf8');
const config = parse(original);
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const effectiveSop = applyProjectBinding(config, projects.a.fullPath, env, true).modules.sop;
assert.equal(effectiveSop.discoveryTimeoutMs, 90000, 'Acceptance must use the release discovery budget');
const budget = { discoveryTimeoutMs: effectiveSop.discoveryTimeoutMs, timeoutMs: effectiveSop.timeoutMs };
const selection = config.agent.model.split('/');
const provider = config.model.providers[selection[0]];
assert.ok(provider?.url);
const sdOrigin = new URL(env.STAFFDECK_FORMAL_API_ORIGIN);
const basePort = Number(process.env.BINDING_QA_OBSERVE_PORT || 26710);
const label = process.env.BINDING_QA_RUN_LABEL || 'observed-fix';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const sdTrace = join(qa, `observe-sd-${label}.jsonl`);
assert.ok(!existsSync(sdTrace), 'Use a new observation label');
const records = [], results = [], servers = [];
const processEnv = { ...process.env, NODE_OPTIONS: '', BINDING_QA_SD_UPSTREAM_PORT: String(basePort), BINDING_QA_OBSERVE_SD_PATH: sdTrace };
const persist = () => {
  const stages = existsSync(sdTrace) ? readFileSync(sdTrace, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
  for (const row of records.filter(row => row.kind === 'model' && !row.toolChoice)) {
    const at = Date.parse(row.startedAt);
    const matches = stages.filter(stage => stage.operation === 'model_stream' && at >= stage.startedMs && at <= stage.endedMs);
    if (matches.length === 1) Object.assign(row, { routeId: matches[0].routeId, sessionId: matches[0].sessionId,
      requestId: matches[0].requestId, plannerStage: matches[0].stage });
  }
  const routes = stages.filter(stage => stage.kind === 'route');
  const summary = { routeCount: routes.length, maxRouteMs: Math.max(0, ...routes.map(route => route.elapsedMs)),
    catalogCalls: stages.filter(stage => stage.operation === 'list_model_catalog').length,
    initialCalls: stages.filter(stage => stage.stage === 'initial').length,
    jsonRepairCalls: stages.filter(stage => stage.stage === 'json_repair').length,
    planRepairCalls: stages.filter(stage => stage.stage === 'plan_repair').length };
  writeFileSync(join(qa, `observe-result-${label}.json`), JSON.stringify({ budget, summary, records, stages, results }, null, 2));
};
async function run(script, args = [], values = processEnv) {
  const started = Date.now();
  const child = spawn(process.execPath, [join(pd, 'scripts/staffdeck-binding', script), ...args], {
    cwd: pd, env: values, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  results.push({ script, args, exitCode: code, elapsedMs: Date.now() - started }); persist();
  return code;
}
async function ready(url) {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Observed service did not become ready');
}
async function proxy(port, upstream, kind) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let input; try { input = JSON.parse(body.toString()); } catch {}
    let plannerStage;
    for (const message of input?.messages ?? []) {
      if (typeof message.content !== 'string') continue;
      try {
        const payload = JSON.parse(message.content);
        if (payload?._json_repair) plannerStage = 'json_repair';
        else if (payload?._schema_repair) plannerStage = 'plan_repair';
        else if (payload?.phase === 'TurnPlanner' || payload?.stage_data?.available_sops) plannerStage = 'initial';
      } catch {}
    }
    const started = Date.now();
    const row = { kind, startedAt: new Date(started).toISOString(), path: req.url?.split('?')[0],
      ...(kind === 'sd' ? { sessionId: input?.session_id, modelSource: input?.model_source }
        : { model: input?.model, toolChoice: input?.tool_choice, plannerStage,
          tools: input?.tools?.map(tool => tool.function?.name ?? tool.name),
          sopPrompt: input?.messages?.filter(message => message.role === 'system').map(message => message.content)
            .filter(text => typeof text === 'string').flatMap(text => text.split('\n'))
            .filter(line => /Being final|SOP_STEP_RESULT_REQUIRED|declares a human handoff/.test(line)) }) };
    if (kind === 'model' || input?.model_source === 'pilotdeck_host') records.push(row);
    const target = new URL(upstream);
    const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: target.pathname.replace(/\/$/, '') + (req.url ?? '/'), method: req.method,
      headers: { ...req.headers, host: target.host },
    }, response => {
      row.status = response.statusCode; row.headersMs = Date.now() - started;
      res.writeHead(response.statusCode, response.headers);
      let pending = '';
      const toolNames = new Set(), finishes = new Set();
      response.on('data', chunk => {
        row.firstByteMs ??= Date.now() - started;
        if (kind === 'model') {
          pending += chunk.toString();
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5));
              for (const choice of event.choices ?? []) {
                if (choice.finish_reason) finishes.add(choice.finish_reason);
                for (const call of choice.delta?.tool_calls ?? []) if (call.function?.name) toolNames.add(call.function.name);
                if (choice.delta?.content) row.textChunks = (row.textChunks ?? 0) + 1;
              }
            } catch {}
          }
        }
      });
      response.on('end', () => {
        row.elapsedMs = Date.now() - started;
        if (kind === 'model') { row.returnedTools = [...toolNames]; row.finishReasons = [...finishes]; }
        persist();
      });
      response.pipe(res);
    });
    outgoing.on('error', error => {
      row.errorCode = error.code; row.elapsedMs = Date.now() - started; persist();
      if (!res.headersSent) res.writeHead(502); res.end();
    });
    res.on('close', () => { if (!res.writableFinished) { row.clientClosedMs = Date.now() - started; outgoing.destroy(); } });
    outgoing.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  servers.push(server);
}
try {
  assert.equal(await run('restart.mjs', ['sd']), 0);
  await ready(`http://127.0.0.1:${basePort}/api/health`);
  await proxy(Number(sdOrigin.port), `http://127.0.0.1:${basePort}`, 'sd');
  const modelOrigin = new URL(provider.url);
  await proxy(basePort + 1, modelOrigin.origin, 'model');
  provider.url = `http://127.0.0.1:${basePort + 1}${modelOrigin.pathname}`;
  writeFileSync(configPath, stringify(config), { mode: 0o600 });
  assert.equal(await run('restart.mjs', ['gateway', 'web']), 0);
  await ready(`http://127.0.0.1:${env.SERVER_PORT}/api/projects`);
  const common = { ...processEnv, BINDING_QA_RUN_LABEL: label, BINDING_QA_REPETITIONS: '3', BINDING_QA_REQUIRED_KNOWLEDGE: 'true' };
  if (process.env.BINDING_QA_ONLY !== 'approvals') await run('chat.mjs', [], common);
  await run('special-runtime.mjs', [], common);
  persist();
  const observation = JSON.parse(readFileSync(join(qa, `observe-result-${label}.json`), 'utf8'));
  const routes = observation.stages.filter(stage => stage.kind === 'route');
  assert.ok(routes.length >= 9, 'Expected ordinary and authorized routing observations');
  assert.ok(routes.every(route => !route.errorType && route.elapsedMs < budget.discoveryTimeoutMs), 'Discovery exceeded its budget or failed');
} finally {
  writeFileSync(configPath, original, { mode: 0o600 });
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  const restored = { ...process.env, NODE_OPTIONS: '' };
  delete restored.BINDING_QA_SD_UPSTREAM_PORT; delete restored.BINDING_QA_OBSERVE_SD_PATH;
  await run('restart.mjs', ['sd', 'gateway', 'web'], restored);
  persist();
}
if (results.some(row => row.exitCode !== 0)) process.exitCode = 1;
