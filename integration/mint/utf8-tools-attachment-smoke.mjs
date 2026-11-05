import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import {writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=root+'/utf8-registry-project';
await writeFile(cwd+'/utf8-attachment.txt','Acceptance code: plum-742; warehouse: 青岛; symbol: 🙂.');
const gw=new MintAcpGateway({command:root+'/utf8-unified/launch.py',cwd,stateDir:root+'/utf8-unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'}});
try{
 const sessionKey='utf8:tools-attachment-'+crypto.randomUUID();
 for await(const event of gw.submitTurn({sessionKey,message:'Use write_file to create utf8-proof.txt with content 中文🙂 apricot. Then read that file and report the content.',runId:crypto.randomUUID()})){
  console.log(JSON.stringify(event));if(event.type==='permission_request')await gw.permissionDecide({requestId:event.requestId,decision:'allow'});
 }
 assert.match(await readFile(cwd+'/utf8-proof.txt','utf8'),/中文🙂/);
 let answer='';for await(const event of gw.submitTurn({sessionKey,message:'Read the attached text. Reply with the acceptance code and warehouse.',attachments:[{type:'file',path:cwd+'/utf8-attachment.txt',name:'utf8-attachment.txt'}],runId:crypto.randomUUID()})){
 console.log(JSON.stringify(event));if(event.type==='assistant_text_delta')answer+=event.text;
 }
 assert.match(answer,/plum-742/);assert.match(answer,/青岛/);
}finally{gw.close();}
