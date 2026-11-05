import { MintAcpGateway } from '../../ui/server/services/mintAcpGateway.js';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=root+'/provider-probe-project';
const mode=process.env.MINT_COMPACTION_TEST_MODE || 'basic';
const sessionKey='unified:compaction-'+mode+'-'+crypto.randomUUID();
console.log(JSON.stringify({event:'compaction_session',sessionKey}));
const gw=new MintAcpGateway({command:root+'/unified/launch.py',cwd,stateDir:root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1',MINT_COMPACTION_TEST_MESSAGES:'7',MINT_COMPACTION_TEST_MODE:mode}});
try {for(const message of ['Remember our objective: prepare a fruit inventory. The secret fruit is apricot. Reply OK.','We completed the inventory file draft. Next we need to review it. Reply OK.','Keep this decision: use plain text files and preserve the secret fruit. Reply OK.','Do not use file tools. Name the secret fruit only.','After compaction, what is the secret fruit? Reply briefly.']){for await(const e of gw.submitTurn({sessionKey,message,runId:crypto.randomUUID()}))console.log(JSON.stringify(e));}}
finally{gw.close();}
