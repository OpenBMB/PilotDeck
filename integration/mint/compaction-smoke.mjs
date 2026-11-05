import { MintAcpGateway } from '../../ui/server/services/mintAcpGateway.js';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=process.env.PILOTDECK_MINT_PROJECT || root+'/provider-probe-project';
const mode=process.env.MINT_COMPACTION_TEST_MODE || 'basic';
const sessionKey='unified:compaction-'+mode+'-'+crypto.randomUUID();
console.log(JSON.stringify({event:'compaction_session',sessionKey}));
const gw=new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND || root+'/unified/launch.py',cwd,stateDir:process.env.PILOTDECK_MINT_STATE_DIR || root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1',MINT_COMPACTION_TEST_MESSAGES:'7',MINT_COMPACTION_TEST_MODE:mode}});
try {for(const message of ['Do not use tools. Remember the secret fruit apricot. Reply only OK.','Do not use tools. Remember our number is 42. Reply only OK.','Do not use tools. Remember our color is blue. Reply only OK.','Do not use tools. State the secret fruit only.','Do not use tools. After compaction, state the secret fruit only.']){for await(const e of gw.submitTurn({sessionKey,message,runId:crypto.randomUUID()})){console.log(JSON.stringify(e));if(e.type==='permission_request')await gw.permissionDecide({requestId:e.requestId,decision:'deny'});}}}
finally{gw.close();}
