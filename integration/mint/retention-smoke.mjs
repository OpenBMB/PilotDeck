import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
import {writeFile,readFile,readdir} from 'node:fs/promises';
const root=process.env.PILOTDECK_TEST_RUNTIME || '/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=process.env.PILOTDECK_MINT_PROJECT || root+'/provider-probe-project';
const body=Array.from({length:100},(_,i)=>`inventory row ${i}: apples pears apricots warehouse quantity ${i%47}`).join('\n');
await writeFile(cwd+'/retention-large.txt',body);
const gw=new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND || root+'/unified/launch.py',cwd,stateDir:root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1',MINT_RETENTION_MAX_BYTES:'3000'},timeoutMs:300000});
const sessionKey='unified:retention-'+crypto.randomUUID();
try {for(const message of ['Use read_file to read retention-large.txt. Then reply briefly with the first row.','Use read_file to read browser-proof.txt. Reply briefly with its content.','Recall the first inventory row from the earlier tool result. Reply briefly.']) {
for await(const e of gw.submitTurn({sessionKey,message,runId:crypto.randomUUID()}))console.log(JSON.stringify(e));}
console.log(JSON.stringify({event:'retention_smoke_done',sessionKey}));}finally{gw.close();}
