import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const execute = promisify(execFile);
const directory = resolve(process.argv[2]);
const report = { directory, startedAt: new Date().toISOString(), checks: {} };
const project = process.env.COMPOSE_PROJECT_NAME ?? 'pd-v4-final';
const docker = async args => (await execute('docker', ['compose', '-p', project, '--env-file', '.env', ...args], { cwd: directory, maxBuffer: 2 * 1024 * 1024 })).stdout;
async function gatewayReady() {
  for (let i = 0; i < 120; i++) {
    try {
      await docker(['exec', '-T', 'pilotdeck', 'node', '--input-type=module', '-e', "const r=await fetch('http://127.0.0.1:18789/health');if(!r.ok)process.exit(1)"]);
      return;
    } catch { await new Promise(done => setTimeout(done, 500)); }
  }
  throw Error('Exported Gateway readiness timed out; inspect docker compose logs pilotdeck');
}
const program = `
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { createPilotDeckClient } from '@pilotdeck/sdk';
import { SopExecutionClient } from './dist/src/sop/execution/SopExecutionClient.js';
import { createKnowledgeModulePort } from './dist/src/composition/domainPorts.js';
const config = YAML.parse(await readFile(process.env.PILOTDECK_CONFIG_PATH, 'utf8'));
const token = (await readFile('/root/.pilotdeck/server-token', 'utf8')).trim();
const sdk = createPilotDeckClient({ gatewayUrl: 'ws://127.0.0.1:18789/ws', authToken: token, projectKey: '/workspace' });
const runtime = new SopExecutionClient(config.modules.sop.endpoint, process.env[config.modules.sop.credentialEnv]);
const km = createKnowledgeModulePort(config.modules.knowledge);
let result = {};
try {
  await sdk.connect();
  if (process.env.CHECK_PERSISTENCE === '1') {
    const saved = JSON.parse(await readFile('/root/.pilotdeck/v4-acceptance.json', 'utf8'));
    assert.equal((await sdk.sop.call('sop_status', {runId:saved.runId})).status, 'completed');
    assert.ok(await km.call('resolve_citation', {chunk_id:saved.chunkId}));
    console.log(JSON.stringify({status:'PASS', persistence:true, ...saved}));
  } else {
    const key = randomBytes(4).toString('hex');
    const base = await km.call('create_base', {name:'Compose receipts '+key});
    const job = await km.call('import_document', {knowledge_base_id:base.id, filename:'policy.md', content_base64:Buffer.from('# Expense policy\\n\\nOriginal receipts are required. Submit within 30 days. Acceptance code KM42.').toString('base64')});
    let ingested;
    for(let i=0;i<240;i++){const value=await km.call('get_job',{job_id:job.id});if(value.status==='succeeded'){ingested=value;break;}if(value.status==='failed')throw Error(JSON.stringify(value));await new Promise(done=>setTimeout(done,500));}
    assert.ok(ingested,'Ingest timed out');
    const query=await km.call('query',{query:'What is the deadline and acceptance code?',knowledge_base_ids:[base.id],use_model:true});
    assert.ok(query.chunks?.length,'No real KM evidence');
    const citation=await km.call('resolve_citation',{chunk_id:query.chunks[0].id});assert.ok(citation);
    const sopId='compose-km-'+key;
    await runtime.request('/v4/definitions',undefined,{schema:'sop.definition/v4',skill_id:sopId,version:'1',start_node_id:'lookup',terminal_node_ids:['lookup'],nodes:[{node_id:'lookup',tools:['knowledge_query','knowledge_resolve_citation'],instruction:'Call knowledge_query in knowledge_base_ids ["'+base.id+'"] for expense policy, then resolve an actual citation with knowledge_resolve_citation. Complete using structured_output with status completed and output {deadlineDays:30,code:"KM42",citationResolved:true}.'}],edges:[]});
    const run=await sdk.sop.call('run_sop',{requestId:key,sopId,version:'1',input:{originalQuery:'Find the expense policy'}});
    let state;for(let i=0;i<8;i++){state=await sdk.sop.call('sop_wait',{runId:run.runId,timeoutMs:60000});if(state.status!=='running')break;}
    assert.equal(state.status,'completed',JSON.stringify(state));
    const output=(await sdk.sop.call('sop_result',{runId:run.runId})).items[0].output;
    assert.equal(output.deadlineDays,30);assert.equal(output.code,'KM42');assert.equal(output.citationResolved,true);
    const nodeToolCalls=[];
    async function inspect(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
      const path=directory+'/'+entry.name;
      if(entry.isDirectory())await inspect(path);
      else if(entry.name.endsWith('.jsonl'))for(const line of (await readFile(path,'utf8')).split('\\n').filter(Boolean)){
        const record=JSON.parse(line);
        if(record.type==='tool_call'&&record.sessionId?.startsWith('sop-v4:'+run.runId+':'))nodeToolCalls.push(record.call.name);
      }
    }}
    await inspect('/root/.pilotdeck/projects');
    assert.ok(nodeToolCalls.includes('knowledge_query'));assert.ok(nodeToolCalls.includes('knowledge_resolve_citation'));
    result={status:'PASS',runId:run.runId,chunkId:query.chunks[0].id,baseId:base.id,output,nodeToolCalls};
    await writeFile('/root/.pilotdeck/v4-acceptance.json',JSON.stringify(result));
    console.log(JSON.stringify(result));
  }
}finally{await sdk.close();}
`;
try {
  await gatewayReady();
  // Both model callbacks and actual node tools run inside the exported services.
  const output = await docker(['exec', '-T', 'pilotdeck', 'node', '--input-type=module', '-e', program]);
  report.checks.business = JSON.parse(output.trim().split('\n').at(-1));
  await docker(['stop']); await docker(['up', '-d', '--wait']);
  await gatewayReady();
  const restored = await docker(['exec', '-T', '-e', 'CHECK_PERSISTENCE=1', 'pilotdeck', 'node', '--input-type=module', '-e', program]);
  report.checks.persistence = JSON.parse(restored.trim().split('\n').at(-1));
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stderr ?? error.stack ?? error); throw error; }
finally { await writeFile(join(directory, 'v4-compose-acceptance.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ status: report.status, report: join(directory, 'v4-compose-acceptance.json') }));
