import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
test('historical tool results include terminal updates only',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mint-history-'));
 try {
 const gw=new MintAcpGateway({command:'/unused',cwd:root,stateDir:root});
 await mkdir(path.join(root,'.mint/sessions'),{recursive:true});
 await writeFile(gw.mappingPath('test'),JSON.stringify({id:'kernel'}));
 const events=[{event:'tool_call_update',call_id:'c',status:'in_progress'}, {event:'tool_call_update',call_id:'c',status:'completed',content:[{type:'text',text:'full original'}]}];
 await writeFile(path.join(root,'.mint/sessions/kernel.jsonl'),events.map((event,i)=>JSON.stringify({seq:i,event})).join('\n'));
 const h=await gw.readSessionMessages({sessionKey:'test'});
 assert.equal(h.messages.length,1);assert.equal(h.messages[0].ok,true);assert.match(h.messages[0].text,/full original/);
 }finally{await rm(root,{recursive:true,force:true});}
});
