// Each case runs the same locked ACP assembly; failures remain visible in JSONL.
import {MintAcpGateway} from '../../../ui/server/services/mintAcpGateway.js';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const cwd=process.env.MINT_PROJECT;
if(!cwd)throw Error('Run through repro/run.py --root INSTANCE exec -- node integration/mint/repro/scenarios.mjs');
const cases={
 instructions:['Do not use tools. What is the deployment acceptance marker in PILOTDECK.md?',/MINT_REPRO_13/],
 prompt:['Do not use tools. State the agent product, runtime and operating system from your system context.',/PilotDeck/],
 time:['Do not use tools. What is the current date from your environment context?',/2026|20\d\d/],
 attachments:['Read the attached text and report its code and warehouse.',/plum-742/],
 fs:['Use write_file to create repro-output.txt containing exactly "中文🙂 MINT_REPRO_FS". Then read_file that file and report the content.',/MINT_REPRO_FS/],
 retention:['Use read_file to read retention-large.txt. Reply with the first row.',/inventory row 0/],
 pruner:['Use read_file to read pruner-one.txt. Then use read_file to read pruner-two.txt. Reply DONE.',/DONE/i],
 budget:['Budget input '+ 'distinct budget input sentence '.repeat(15000),null],
 provider:['Reply exactly MINT_PROVIDER_OK.',/MINT_PROVIDER_OK/],
 image:['Call read_file exactly once with file_path tiny.png, then describe the image.',null],
 compaction_basic:['Do not use tools. Remember fruit apricot. Reply OK.',/OK/i],
 compaction_port:['Do not use tools. Remember fruit apricot. Reply OK.',/OK/i],
};
await writeFile(cwd+'/attachment.txt','Acceptance code: plum-742; warehouse: 青岛.');
for(const name of ['retention-large','pruner-one','pruner-two'])await writeFile(cwd+'/'+name+'.txt',Array.from({length:100},(_,i)=>`inventory row ${i}: apples pears apricots warehouse quantity ${i}`).join('\n'));
await writeFile(cwd+'/tiny.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfZkAAAAASUVORK5CYII=','base64'));
const selected=process.argv.slice(2).length?process.argv.slice(2):Object.keys(cases);let failures=0;
for(const name of selected){
 if(!cases[name])throw Error('Unknown case '+name);
 const gateway=new MintAcpGateway({command:process.env.PILOTDECK_MINT_COMMAND,cwd,stateDir:process.env.PILOTDECK_MINT_STATE_DIR,timeoutMs:120000});
 let answer='',finish='',key='repro:'+name+':'+randomUUID();
 try{
  for await(const event of gateway.submitTurn({sessionKey:key,message:cases[name][0],...(name==='attachments'?{attachments:[{type:'file',path:cwd+'/attachment.txt',name:'attachment.txt'}]}:{}),runId:randomUUID()})){
   console.log(JSON.stringify({case:name,...event}));if(event.type==='assistant_text_delta')answer+=event.text;if(event.type==='turn_completed')finish=event.finishReason;if(event.type==='permission_request')await gateway.permissionDecide({requestId:event.requestId,decision:'allow'});
  }
  if(name==='budget')assert.equal(finish,'max_tokens');else if(cases[name][1])assert.match(answer,cases[name][1]);
  if(name==='fs')assert.match(await readFile(cwd+'/repro-output.txt','utf8'),/中文🙂 MINT_REPRO_FS/);
  console.log(JSON.stringify({case:name,status:'scenario_completed',session:key,note:'A completed answer alone does not prove package invocation; inspect model/hook/tool evidence.'}));
 }catch(error){failures++;console.log(JSON.stringify({case:name,status:'failed',error:error.message}));}
 finally{gateway.close();}
}
process.exitCode=failures?1:0;
