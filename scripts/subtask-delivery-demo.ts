/** Isolated, explicitly seeded demonstration through the real local gateway. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { createLocalGateway } from '../src/cli/createLocalGateway.js';
import { createCollisionResistantProjectId } from '../src/pilot/paths.js';
import { EdgeClawMemoryService } from 'edgeclaw-memory-core';
import { DEFAULT_DELIVERY_PROMPT } from '../src/agent/sub/delivery/prompt.js';
import { readDeliveryMemory } from '../src/context/memory/DeliveryMemory.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'live';
const parent = resolve(process.env.DELIVERY_DEMO_ROOT ?? join(repo,'artifacts/subtask-delivery-demo'));
await mkdir(parent,{recursive:true});
let key=process.env.DELIVERY_DEMO_API_KEY;
let endpoint=process.env.DELIVERY_DEMO_ENDPOINT;
if(process.argv.includes('--opencode-auth')){
 const options=JSON.parse(await readFile(join(homedir(),'.config/opencode/opencode.json'),'utf8')).provider['zhipuai-coding-plan'].options;
 endpoint??=options.baseURL;
 if(typeof options.apiKey==='string'&&!options.apiKey.startsWith('{env:'))key??=options.apiKey;
 else key??=JSON.parse(await readFile(join(homedir(),'.local/share/opencode/auth.json'),'utf8'))['zhipuai-coding-plan'].key;
}
if(!key||!endpoint)throw new Error('Set DELIVERY_DEMO_API_KEY and DELIVERY_DEMO_ENDPOINT, or explicitly use --opencode-auth.');
const env={...process.env,DELIVERY_DEMO_API_KEY:key};
const runRoot=process.env.DELIVERY_DEMO_RUN ? resolve(process.env.DELIVERY_DEMO_RUN) : await mkdtemp(join(parent,'run-'));
const workspace=join(runRoot,'workspace'),pilotHome=join(runRoot,'pilot-home');
let fixture:any;
if(process.env.DELIVERY_DEMO_RUN){fixture=JSON.parse(await readFile(join(runRoot,'fixture.json'),'utf8'));}
else {
 await mkdir(workspace);await mkdir(pilotHome);
 const project=join(pilotHome,'projects',createCollisionResistantProjectId(workspace));await mkdir(project,{recursive:true});await writeFile(join(project,'.cwd'),workspace);
 const main=process.env.DELIVERY_DEMO_MAIN??'glm-5.3',child=process.env.DELIVERY_DEMO_CHILD??'glm-5.3-flash';
 const config={schemaVersion:1,agent:{model:`demo/${main}`,subagents:{default:`demo/${child}`},maxContextTokens:65536,maxOutputTokens:4096,thinking:{enabled:false},delivery:{mode:'auto',maxRepairs:2,prompt:DEFAULT_DELIVERY_PROMPT+'\nDEMO FIXTURE, child execution only: For the greeting.md task, first submit result.file=greeting.md before creating it. On repair feedback, create it. For the runbook.md task, first read and submit the existing unmodified file as result.file, explicitly a draft; on repair feedback revise it to satisfy the final task. These are deliberately seeded first-delivery faults for the demo, not completed work. Do not claim the initial drafts meet the final requirements. Other tasks behave normally.'}},
  model:{providers:{demo:{protocol:'openai',url:endpoint,apiKey:'${DELIVERY_DEMO_API_KEY}',timeoutMs:120000,retry:{requestMaxRetries:0,streamMaxRetries:0},extraBody:{thinking:{type:'disabled'},metadata:null},models:Object.fromEntries([main,child].map(m=>[m,{capabilities:{supportsToolUse:true,maxContextTokens:65536,maxOutputTokens:4096}}]))}}},
  router:{enabled:false,tokenSaver:{enabled:false},autoOrchestrate:{enabled:false},zeroUsageRetry:{enabled:false},transientRetry:{enabled:false}},
  extension:{builtinPluginsEnabled:{'windows-skills':false,'browser-use':false,funasr:false}},
  memory:{enabled:true,provider:'edgeclaw',rootDir:join(pilotHome,'memory'),captureStrategy:'last_turn',includeAssistant:false,schedule:{autoIndexIntervalMinutes:0,autoDreamIntervalMinutes:0}},tools:{webSearch:{enabled:false}},telemetry:{enabled:false}};
 await writeFile(join(pilotHome,'pilotdeck.yaml'),stringify(config),{mode:0o600});
 await writeFile(join(workspace,'runbook.md'),'1. 检查受影响用户。\n2. 发现故障立即回滚，不需要负责人批准。\n3. 怀疑数据丢失时继续自动恢复。\n4. 错误率下降后关闭告警。\n');
 const fileSchema={"type": "object", "properties": {"result": {"type": "object", "properties": {"file": {"type": "string"}}}}};
 const tasks=[
  {description:'交付文件检查与局部修复',prompt:'最终任务：将一句“演示交付已完成。”写入 greeting.md 并交付。不要创建子任务。',delivery:{schema:fileSchema}},
  {description:'模型发现内容问题并修复',prompt:'最终任务：修订 runbook.md 为四步中文故障处理说明。必须先核实用户影响；回滚必须关联最近部署并获得事故负责人批准；怀疑数据丢失时停止自动恢复、保留证据并升级给存储值班；恢复必须错误率低于0.5%持续10分钟。不要创建子任务。',delivery:{review:true,schema:fileSchema}},
  {description:'普通文字结果无需模型评审',prompt:'请用一句中文说明本项目把子任务结果保存在独立交付文件中的用途。只返回文字结果，不需要业务文件，也不创建子任务。'},
 ];
 const prompt='演示子任务交付验收。这是明确预置故障的工程演示，不是自然成功率实验。预置故障通过子代理的演示提示词产生，任务本身只陈述最终验收目标。请只调用一次每个下列 agent 任务，可并行。完整保留任务及 delivery 字段；不要替子任务改文件，不重复派发。框架负责原子任务内修复。最后读取各自 delivery_file 并用中文总结真实状态、修复次数、评审模型及记录位置。\n'+tasks.map(t=>JSON.stringify({...t,subagent_type:'general-purpose'})).join('\n');
 await writeFile(join(runRoot,'现场任务.txt'),prompt);
 fixture={runRoot,workspace,pilotHome,prompt,kind:'explicit-controlled-faults',main,child};await writeFile(join(runRoot,'fixture.json'),JSON.stringify(fixture,null,2));
}
console.log(JSON.stringify({runRoot,workspace,taskFile:join(runRoot,'现场任务.txt')}));
if(mode==='live'){
 const sessionKey=`web:delivery-demo-${Date.now()}`;const events:any[]=[];
 const local=createLocalGateway({pilotHome,projectRoot:workspace,env:{...env,PILOT_HOME:pilotHome,PILOTDECK_CONFIG_PATH:join(pilotHome,'pilotdeck.yaml')},permissionMode:'default'});
 try{
  for(const entry of ['agent','read_file','write_file','edit_file'])await local.gateway.grantSessionPermission({sessionKey,entry});
  for await(const event of local.gateway.submitTurn({sessionKey,projectKey:workspace,channelKey:'web',message:fixture.prompt,mode:'default',canPrompt:false,maxTurns:10,timeoutMs:480000})){
   events.push(event);if(event.type==='error')console.error(JSON.stringify(event));
  }
  const deliveries=events.filter(e=>e.type==='tool_call_finished'&&e.data?.delivery).map(e=>e.data);
  await writeFile(join(runRoot,'native-results.json'),JSON.stringify({sessionKey,kind:fixture.kind,simulatedModel:false,deliveries,events},null,2));
  const memory=new EdgeClawMemoryService({workspaceDir:workspace,rootDir:join(pilotHome,'memory')});
  try{await writeFile(join(runRoot,'delivery-memory.json'),JSON.stringify(readDeliveryMemory(memory),null,2));}finally{memory.close();}
  await writeFile(join(runRoot,'fixture.json'),JSON.stringify({...fixture,sessionKey},null,2));
  console.log(JSON.stringify({sessionKey,deliveries:deliveries.map(d=>({status:d.delivery.status,repairs:d.delivery.repairs,file:d.delivery_file}))}));
  const greeting = await readFile(join(workspace,'greeting.md'),'utf8').catch(()=>'');
  const runbook = await readFile(join(workspace,'runbook.md'),'utf8').catch(()=>'');
  const validation = {
   threeDeliveries:deliveries.length===3,
   greetingWritten:greeting.includes('演示交付已完成'),
   fileRepair:deliveries.some(d=>d.delivery.attempts[0]?.checks.issues.some((i:any)=>i.code==='file_missing')&&d.delivery.status==='passed'&&d.delivery.repairs>0),
   semanticRepair:deliveries.some(d=>d.delivery.attempts[0]?.review?.status==='rejected'&&d.delivery.attempts.at(-1)?.review?.status==='accepted'&&d.delivery.repairs>0),
   runbookOutcome:/批准/.test(runbook)&&/部署/.test(runbook)&&/停止/.test(runbook)&&/证据/.test(runbook)&&/存储/.test(runbook)&&/0[.．]5\s*%/.test(runbook)&&/10\s*分钟/.test(runbook)&&!/不需要.*批准/.test(runbook),
  };
  await writeFile(join(runRoot,'validation.json'),JSON.stringify(validation,null,2));console.log(JSON.stringify({validation}));
  if(Object.values(validation).some(value=>!value))process.exitCode=1;
 }finally{await writeFile(join(runRoot,'gateway-events.json'),JSON.stringify(events,null,2));local.dispose();}
}else if(mode==='ui'){
 const processEnv={...env,PILOT_HOME:pilotHome,PILOTDECK_CONFIG_PATH:join(pilotHome,'pilotdeck.yaml'),DATABASE_PATH:join(pilotHome,'ui-auth.db'),HOST:'127.0.0.1',PILOTDECK_SKIP_BROWSER_OPEN:'1',SERVER_PORT_BASE:'3301',VITE_PORT_BASE:'5273',PILOTDECK_GATEWAY_PORT_BASE:'18889'};
 // Do not inherit an unrelated running checkout's pinned ports.
 for (const name of ['SERVER_PORT','VITE_PORT','PILOTDECK_GATEWAY_PORT','PILOTDECK_GATEWAY_URL']) delete (processEnv as Record<string,string|undefined>)[name];
 const server=spawn(process.execPath,[join(repo,'scripts/dev-launcher.mjs')],{cwd:repo,env:processEnv,stdio:'inherit'});
 process.on('SIGTERM',()=>server.kill('SIGTERM'));process.on('SIGINT',()=>server.kill('SIGINT'));
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.once('exit',code=>code===0?done():reject(new Error(`Demo UI exited ${code}`)));});
}else if(mode!=='prepare')throw new Error('Use prepare, live or ui.');
