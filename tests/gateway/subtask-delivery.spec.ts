import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import type { PilotConfigSnapshot } from '../../src/pilot/config/types.js';

async function fixture(t: test.TestContext, delivery: Record<string, unknown>, requestReview = true) {
  const home = await mkdtemp(join(tmpdir(), 'pilot-delivery-gateway-'));
  const config = { schemaVersion:1,agent:{model:'p/default',subagents:{default:'p/child'},delivery},
    extension:{builtinPluginsEnabled:{'windows-skills':false,'browser-use':false,funasr:false}},memory:{enabled:false},telemetry:{enabled:false},
    model:{providers:{p:{protocol:'openai',url:'https://example.test/v1',apiKey:'test-key',models:{default:{},chosen:{},child:{}}}}},
    router:{enabled:false,tokenSaver:{enabled:false},autoOrchestrate:{enabled:false},zeroUsageRetry:{enabled:false},transientRetry:{enabled:false}} };
  await writeFile(join(home,'pilotdeck.yaml'),JSON.stringify(config));await mkdir(join(home,'skills'));
  let mainCalls=0;
  const children:CanonicalModelRequest[]=[],reviews:CanonicalModelRequest[]=[];
  const local=createLocalGateway({pilotHome:home,projectRoot:home,builtinSkillsRoot:join(home,'skills'),permissionMode:'bypassPermissions',
    env:{...process.env,PILOT_HOME:home,PILOT_AGENT_MODEL:undefined,PILOTDECK_CONFIG_PATH:undefined},
    __testModelFactory:(snapshot:PilotConfigSnapshot)=>({ ...createModelRuntime(snapshot.config.model),
      async *stream(request:CanonicalModelRequest):AsyncIterable<CanonicalModelEvent>{
        if(request.metadata?.subagentId){
          children.push(request);
          yield {type:'text_delta',text:'{"summary":"Computed the result.","result":{"text":"Four."}}'};
        }else if(mainCalls++===0){
          yield {type:'tool_call_end',toolCall:{id:'delegate-1',name:'agent',input:{description:'Compute one answer',prompt:'Return the word Four as the result.',delivery:{review:requestReview,schema:{type:'object',properties:{result:{type:'object',properties:{text:{type:'string'}}}}}}}}};
        }else yield {type:'text_delta',text:'Received child delivery.'};
        yield {type:'usage',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
      },
      async complete(request:CanonicalModelRequest){
        if(request.metadata?.purpose==='subtask_delivery_review')reviews.push(request);
        return {role:'assistant' as const,content:[{type:'text' as const,text:'{"verdict":"accepted","summary":"The requested word is present.","issues":[]}'}],finishReason:'stop' as const,usage:{inputTokens:20,outputTokens:10,totalTokens:30}};
      },
    })});
  t.after(async()=>{local.dispose();await rm(home,{recursive:true,force:true});});
  const events:any[]=[];
  for await(const event of local.gateway.submitTurn({projectKey:home,sessionKey:'web:delivery',channelKey:'web',message:'Delegate the answer.',modelSelection:{mode:'model',provider:'p',model:'chosen'}}))events.push(event);
  return {home,children,reviews,events};
}

test('gateway carries Auto configuration and defaults reviewer to the selected main model', async t=>{
  const f=await fixture(t,{mode:'auto',prompt:'CUSTOM UI PROMPT. Use result.text.'});
  assert.equal(f.children.length,1);
  assert.equal(f.children[0].model,'child');
  assert.match(f.children[0].systemPrompt??'',/CUSTOM UI PROMPT/);
  assert.equal(f.reviews.length,1);
  assert.equal(f.reviews[0].model,'chosen');
  assert.deepEqual(f.reviews[0].tools,[]);
  const result=f.events.find(event=>event.type==='tool_call_finished'&&event.data?.delivery)?.data;
  assert.ok(result?.delivery_file, 'actual gateway tool data must contain the host receipt');
  const receipt=JSON.parse(await readFile(result.delivery_file,'utf8'));
  assert.equal(receipt.content.result.text,'Four.');
  assert.equal(receipt.review.status,'accepted');
});

test('configured reviewer overrides inheritance while per-task opt-out and Off bypass it', async t=>{
  const custom=await fixture(t,{reviewerModel:'p/default'});
  assert.equal(custom.reviews[0]?.model,'default');
  const notRequested=await fixture(t,{mode:'auto'},false);
  assert.equal(notRequested.reviews.length,0);
  const off=await fixture(t,{mode:'off'},true);
  assert.equal(off.reviews.length,0);
  assert.doesNotMatch(off.children[0]?.systemPrompt??'',/Delivery protocol/);
  assert.equal(off.events.some(event=>event.type==='tool_call_finished'&&event.data?.delivery),false);
});
