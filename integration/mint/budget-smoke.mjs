import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
const root=process.env.PILOTDECK_TEST_RUNTIME || '/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=process.env.PILOTDECK_MINT_PROJECT || root+'/provider-probe-project';
const gw=new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND || root+'/unified/launch.py',cwd,stateDir:root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'},timeoutMs:300000});
let finishReason='';
try {
  for await (const e of gw.submitTurn({sessionKey:'unified:budget-block-'+crypto.randomUUID(),message:'Budget limit test: '+ 'distinct budget input sentence '.repeat(15000),runId:crypto.randomUUID()})) {
    console.log(JSON.stringify(e));
    if (e.type === 'turn_completed') finishReason = e.finishReason;
  }
  if (finishReason !== 'max_tokens') throw Error(`budget was not enforced: ${finishReason || 'no terminal event'}`);
  console.log(JSON.stringify({event:'budget_block',finishReason,providerRequest:false}));
} finally { gw.close(); }
