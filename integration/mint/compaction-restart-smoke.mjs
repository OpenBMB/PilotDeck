import { MintAcpGateway } from '../../ui/server/services/mintAcpGateway.js';
import assert from 'node:assert/strict';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime';
const sessionKey='unified:compaction-restart-'+crypto.randomUUID();
function gateway(){return new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND || root+'/unified/launch.py',cwd:process.env.PILOTDECK_MINT_PROJECT || root+'/provider-probe-project',stateDir:root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1',MINT_COMPACTION_TEST_MESSAGES:'7',MINT_COMPACTION_TEST_MODE:'basic'}});}
console.log(JSON.stringify({event:'restart_session',sessionKey}));
let gw=gateway();
try {
 for(const message of ['Remember the secret fruit apricot. Reply OK.','Our fruit inventory uses plain text. Reply OK.','Preserve the secret fruit in the inventory. Reply OK.','Do not use tools. State the secret fruit only.']) {
  for await(const e of gw.submitTurn({sessionKey,message,runId:crypto.randomUUID()})) console.log(JSON.stringify(e));
 }
 gw.close();
 await new Promise(r=>setTimeout(r,2000));
 gw=gateway();
 let answer='';
 for await(const e of gw.submitTurn({sessionKey,message:'After service restart, what is the secret fruit? Do not use tools.',runId:crypto.randomUUID()})) {console.log(JSON.stringify(e));if(e.type==='assistant_text_delta')answer+=e.text;}
 const history=await gw.readSessionMessages({sessionKey});
 console.log(JSON.stringify({event:'restart_history',messages:history.messages}));
 assert.match(answer.toLowerCase(),/apricot/);
 assert.equal(history.messages.filter(m=>m.role==='user').length,5);
} finally{gw.close();}
