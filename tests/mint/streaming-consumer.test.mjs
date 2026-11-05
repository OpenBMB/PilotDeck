import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const project=process.env.MINT_STREAMING_PROBE_PROJECT;
const source=await readFile(new URL('../../integration/mint/streaming-consumer.mjs',import.meta.url),'utf8');
const codec=project && new URL('file://'+project+'/.mint/packages/pilotdeck/model-provider-openai-consumer@0.1.2/vendor/pilotdeck-model-openai-compat-0.1.2/dist/index.js').href;
const module=codec && await import('data:text/javascript;base64,'+Buffer.from(source.replace("'pilotdeck-model-openai-compat'",JSON.stringify(codec))).toString('base64'));
function payload(){return {pilotdeck_openai:{mode:'stream',idempotency_key:'test',provider:{url:'http://local',apiKey:'test'},request:{model:'local',messages:[{role:'user',content:[{type:'text',text:'hello'}]}],tools:[],maxOutputTokens:100}}};}
test('live override emits text before transport completes and preserves split UTF-8', {skip:!project},async()=>{
 let hook;const events=[];
 module.default.activate({on:(_,fn)=>{hook=fn},call:async request=>{events.push(request.payload)},stream:async(_,onEvent)=>{
  onEvent({type:'response',contentType:'text/event-stream'});
  const first=Buffer.from('data: '+JSON.stringify({id:'1',choices:[{index:0,delta:{content:'中文🦀'}}]})+'\n\n');
  for(const byte of first)onEvent({type:'bytes',base64:Buffer.from([byte]).toString('base64')});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events[0].text,'中文🦀');
  onEvent({type:'bytes',base64:Buffer.from('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n').toString('base64')});
 }});
 assert.equal((await hook(payload())).patch.pilotdeck_openai_result.streamed,true);
 assert.equal(events.at(-1).kind,'done');
});
test('incomplete stream cannot emit a successful terminal event',{skip:!project},async()=>{
 let hook;const events=[];
 module.default.activate({on:(_,fn)=>{hook=fn},call:async request=>events.push(request.payload),stream:async(_,onEvent)=>{onEvent({type:'bytes',base64:Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'partial'}}]})+'\n\n').toString('base64')});}});
 await assert.rejects(hook(payload()), /ended before|incomplete/);
 assert.equal(events.some(e=>e.kind==='done'),false);
});


test('published codec normalized tool finish is accepted',{skip:!project},async()=>{
 let hook;const events=[];
 module.default.activate({on:(_,fn)=>{hook=fn},call:async request=>events.push(request.payload),stream:async(_,onEvent)=>{
 const frames=[{id:'reply',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call1',function:{name:'read_file',arguments:'{"file_path":"a.txt"}'}}]}}]},
 {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];
 onEvent({type:'bytes',base64:Buffer.from(frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n').toString('base64')});
 }});
 await hook(payload());
 assert.equal(events.find(e=>e.kind==='tool_call_start').name,'read_file');
 assert.equal(events.find(e=>e.kind==='tool_call_args_delta').delta,'{"file_path":"a.txt"}');
 assert.equal(events.at(-1).kind,'done');
});
