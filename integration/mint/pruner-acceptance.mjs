import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import {writeFile} from 'node:fs/promises';
const cwd=process.env.PILOTDECK_MINT_PROJECT;
await writeFile(cwd+'/pruner-one.txt',Array.from({length:90},(_,i)=>`first inventory ${i} apples pears warehouse quantity ${i}`).join('\n'));
await writeFile(cwd+'/pruner-two.txt',Array.from({length:90},(_,i)=>`second inventory ${i} apples pears warehouse quantity ${i}`).join('\n'));
const gw=new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND,cwd,stateDir:process.env.PILOTDECK_MINT_STATE_DIR,env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'}});
const sessionKey='pruner-acceptance:'+crypto.randomUUID();console.log(JSON.stringify({sessionKey}));
try{for(const message of ['Use read_file to read pruner-one.txt with limit 90. Reply DONE.','Use read_file to read pruner-two.txt with limit 90. Reply DONE.','Do not use tools. Reply DONE.'])for await(const e of gw.submitTurn({sessionKey,message,runId:crypto.randomUUID()})){console.log(JSON.stringify(e));if(e.type==='permission_request')await gw.permissionDecide({requestId:e.requestId,decision:'deny'});}console.log(JSON.stringify(await gw.readSessionMessages({sessionKey})));}finally{gw.close();}
