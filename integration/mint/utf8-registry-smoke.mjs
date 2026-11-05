import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import assert from 'node:assert/strict';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime';
const cwd=root+'/utf8-registry-project';
const gw=new MintAcpGateway({command:root+'/utf8-unified/launch.py',cwd,stateDir:root+'/utf8-unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'}});
try{
 const sessionKey='utf8:unicode-'+crypto.randomUUID();let text='';
 for await(const e of gw.submitTurn({sessionKey,message:'Reply with exactly 中文🙂 apricot',runId:crypto.randomUUID()})){console.log(JSON.stringify(e));if(e.type==='assistant_text_delta')text+=e.text;}
 assert.match(text,/中文🙂/);
}finally{gw.close();}
