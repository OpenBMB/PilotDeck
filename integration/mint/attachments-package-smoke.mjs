import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import {writeFile,readdir} from 'node:fs/promises';import assert from 'node:assert/strict';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=root+'/attachments-registry-project';
const evidence=root+'/attachments-unified/request-evidence';
await writeFile(cwd+'/package-attachment.txt','Acceptance code: amber-618. Warehouse: 青岛. Symbol: 🙂.');
const gw=new MintAcpGateway({command:root+'/attachments-unified/launch.py',cwd,stateDir:root+'/attachments-unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'}});
try {
 let answer='';for await(const e of gw.submitTurn({sessionKey:'attachment:package-'+crypto.randomUUID(),message:'Read the attachment. What is the acceptance code and warehouse?',attachments:[{type:'file',path:cwd+'/package-attachment.txt',name:'package-attachment.txt'}],runId:crypto.randomUUID()})){console.log(JSON.stringify(e));if(e.type==='assistant_text_delta')answer+=e.text;}
 assert.match(answer,/amber-618/);assert.match(answer,/青岛/);
 const before=(await readdir(evidence)).length;let failed=false;
 const state=await gw.session('attachment:missing-'+crypto.randomUUID());
 try { const result=await gw.request('session/prompt',{sessionId:state.id,prompt:[{type:'text',text:'Read attachment.'}],_meta:{'mint/structured-input':true,'mint/attachments':[{uri:'env://local/missing-package.txt',name:'missing.txt'}]}}); console.log(JSON.stringify({missing_result:result})); failed=result._meta?.['mint/loop_job']?.outcome==='failed'; }catch(e){failed=true;console.log(JSON.stringify({expected_error:e.message}));}
 assert.ok(failed);assert.equal((await readdir(evidence)).length,before);
 console.log('PASS attachment projection and missing-file blocks provider');
}finally{gw.close();}
