import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const root=process.env.SOP_ACCEPTANCE_ROOT,endpoint=process.env.SOP_RUNTIME_ORIGIN||'http://127.0.0.1:27491',out=`${root}/evidence/eight-1015`;
if(!root)throw new Error('Set SOP_ACCEPTANCE_ROOT to the native deployment directory');
const prefix=`eight-negative-${Date.now()}`,results=[];
const services=JSON.parse(await readFile(`${root}/services.json`,'utf8')),token=services.runtime.env.SOP_PUBLISH_TOKEN;
async function call(path,body){const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const env=(id,revision,extra={})=>({protocolVersion:'3.0',requestId:id,operationId:id,turnId:'negative-turn',...(revision===undefined?{}:{expectedRevision:revision}),...extra});
const definition={sop_id:prefix,version:'1',content:{start_node_id:'work',terminal_node_ids:['done'],nodes:[{node_id:'work',expected_user_info:['ticket'],allowed_actions:['call_tool:lookup']},{node_id:'done'}],edges:[{source_node_id:'work',next_node_id:'done'}]}};
assert.equal((await call('/v1/definitions',definition)).status,200);
const receipt=sessionId=>({sessionId,turnId:'negative-turn',nodeId:'work',capabilityId:'lookup',operationId:'lookup',status:'succeeded'});
for(const [name,code,proposal,modify] of [
 ['missing-slot','REQUIRED_SLOT_MISSING',{status:'completed',reply:'Done'},r=>[r]],
 ['missing-receipt','REQUIRED_CAPABILITY_NOT_INVOKED',{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'}},()=>[]],
 ['invalid-next','INVALID_TRANSITION',{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'},nextStepId:'absent'},r=>[r]],
 ['wrong-node','RECEIPT_SCOPE_MISMATCH',{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'}},r=>[{...r,nodeId:'done'}]],
 ['wrong-turn','RECEIPT_SCOPE_MISMATCH',{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'}},r=>[{...r,turnId:'other'}]],
 ['undeclared','CAPABILITY_UNDECLARED',{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'}},r=>[{...r,capabilityId:'absent'}]],
]){const sessionId=`${prefix}-${name}`,url=`/v1/sessions/${sessionId}`;assert.equal((await call(url+'/prepare',env('prepare',undefined,{sopId:prefix}))).status,200);const before=(await call(url)).body.state;const rejected=await call(url+'/submit',env('submit',0,{proposal,receipts:modify(receipt(sessionId))}));assert.equal(rejected.body.error?.code,code);assert.deepEqual((await call(url)).body.state,before);results.push({name,sessionId,code,status:rejected.status,unchanged:true});}
const sessionId=`${prefix}-cas`,url=`/v1/sessions/${sessionId}`;await call(url+'/prepare',env('prepare',undefined,{sopId:prefix}));const command=env('advance',0,{proposal:{status:'completed',reply:'Done',slotUpdates:{ticket:'TEST'}},receipts:[receipt(sessionId)]}),first=await call(url+'/submit',command);assert.equal(first.status,200);assert.deepEqual(await call(url+'/submit',command),first);const stale=await call(url+'/submit',env('stale',0,{proposal:{status:'completed',reply:'Done'}}));assert.equal(stale.status,409);assert.equal((await call(url)).body.state.revision,1);results.push({name:'cas-and-submit-replay',sessionId,duplicate:true,stale:stale.body.error.code,revision:1});
await writeFile(`${out}/deployed-negative.json`,JSON.stringify({status:'PASS',results},null,2));console.log(JSON.stringify(results,null,2));
