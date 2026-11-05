import {MintAcpGateway} from '../../ui/server/services/mintAcpGateway.js';
const root='/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime',cwd=root+'/provider-probe-project';
const gw=new MintAcpGateway({command:root+'/unified/launch.py',cwd,stateDir:root+'/unified/acp-map',env:{...process.env,PILOTDECK_MINT_STRUCTURED_INPUT:'1'},timeoutMs:300000});
try{for await(const e of gw.submitTurn({sessionKey:'unified:budget-block-'+crypto.randomUUID(),message:'Budget limit test: '+ 'distinct budget input sentence '.repeat(15000),runId:crypto.randomUUID()}))console.log(JSON.stringify(e));throw Error('unexpected model completion');}catch(e){console.log(JSON.stringify({event:'budget_block',error:e.message}));if(!/budget/i.test(e.message))throw e;}finally{gw.close();}
