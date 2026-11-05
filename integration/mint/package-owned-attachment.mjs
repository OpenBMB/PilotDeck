import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=(process.env.PILOTDECK_MINT_PROJECT || root+'/package-owned-project');await writeFile(cwd+'/package-attachment.txt','Acceptance code plum-742. Warehouse 青岛.');
const gw=new MintAcpGateway({command:(process.env.PILOTDECK_MINT_COMMAND || root+'/package-owned-unified/launch.py'),cwd,stateDir:(process.env.PILOTDECK_MINT_STATE_DIR || root+'/package-owned-unified/acp-map'),env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'}});
let text='';try{for await(const e of gw.submitTurn({sessionKey:'package-attachment:'+crypto.randomUUID(),message:'Read the uploaded attachment context. State its acceptance code and warehouse. Do not use tools.',attachments:[{type:'file',path:cwd+'/package-attachment.txt',name:'package-attachment.txt'}],runId:crypto.randomUUID()})){console.log(JSON.stringify(e));if(e.type==='assistant_text_delta')text+=e.text;}}
finally{gw.close();}assert.match(text,/plum-742/);assert.match(text,/青岛/);
