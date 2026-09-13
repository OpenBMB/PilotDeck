import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {grade} from './grade.js';
import {resolve} from 'node:path';
const base=resolve(process.argv[2]??'artifacts/subtask-delivery-benchmark');
const rows:any[]=[];
const knownSum=(values:unknown[]):number|null=>values.every((v):v is number=>typeof v==='number'&&Number.isFinite(v))?values.reduce((sum,v)=>sum+v,0):null;
for(const cohort of ['natural-v1','research-path-correction-v1','controlled-v1']){
 const tasks=JSON.parse(await readFile(cohort==='controlled-v1'?new URL('./faults.json',import.meta.url):join(base,cohort,'cases.json'),'utf8'));
 const protocol=JSON.parse(await readFile(join(base,cohort,'protocol.json'),'utf8'));
 for(const task of tasks){if(cohort==='research-path-correction-v1'&&task.id!=='research-launch')continue;
 for(const arm of protocol.arms){const r=JSON.parse(await readFile(join(base,cohort,'runs',task.id,arm,'result.json'),'utf8'));
 const g=grade(task,r.files,r.finalText);const note=task.id==='research-vendor'&&g.reasons.length===1&&g.reasons[0]==='sources'?'Business recommendation usable; all-source filename coverage is incomplete. Strict grade remains failed.':'';
 const usage=(kind:string)=>{const calls=r.calls.filter((c:any)=>c.kind===kind);return {calls:calls.length,totalTokens:knownSum(calls.map((c:any)=>c.usage?.totalTokens)),inputTokens:knownSum(calls.map((c:any)=>c.usage?.inputTokens)),cacheReadTokens:knownSum(calls.map((c:any)=>c.usage?.cacheReadTokens)),outputTokens:knownSum(calls.map((c:any)=>c.usage?.outputTokens))}};
 const row={cohort,task:task.id,arm,strictGrade:g,businessUsable:!r.error&&(g.usable||!!note),note,originalGrade:r.grade,error:r.error,attempts:r.attempts.map((a:any)=>({...grade(task,a.files,a.finalText??r.finalText),attempt:a.attempt})),delivery:r.report?.delivery,producer:usage('producer'),judge:usage('judge')};rows.push(row);
 }
 if(cohort!=='controlled-v1')for(const kind of ['best-of-3',...(task.voteable?['self-consistency']:[])]){const selected=JSON.parse(await readFile(join(base,cohort,'runs',task.id,kind+'.json'),'utf8'));const ix=kind==='best-of-3'?selected.selection?.index:selected.selectedIndex;const proposal=rows.find(r=>r.cohort===cohort&&r.task===task.id&&r.arm===`proposal-${ix}`);rows.push({cohort,task:task.id,arm:kind,strictGrade:proposal?.strictGrade??{usable:false,reasons:['selector_error']},businessUsable:!selected.error&&!!proposal?.businessUsable,note:proposal?.note,selectedIndex:ix,error:selected.error,selectorUsage:selected.selection?.usage,producer:{totalTokens:knownSum(rows.filter(r=>r.cohort===cohort&&r.task===task.id&&r.arm.startsWith('proposal-')).map(r=>r.producer.totalTokens))}});}
 }
}
await writeFile(join(base,'adjudication-v2.json'),JSON.stringify({note:'Original results immutable. Regrade fixes ESM execution, consecutive-minutes wording, and legacy Result section extraction. Business-grade relaxation for vendor filenames is shown separately and applies to every arm. Corrected launch fixture reruns every arm.',rows},null,2));
const natural=rows.filter(r=>(r.cohort==='natural-v1'&&r.task!=='research-launch')||(r.cohort==='research-path-correction-v1'));
for(const arm of ['off','guidance','l1','l1-judge','best-of-3','self-consistency']){const rs=natural.filter(r=>r.arm===arm);console.log(arm,JSON.stringify({n:rs.length,strict:rs.filter(r=>r.strictGrade.usable).length,business:rs.filter(r=>r.businessUsable).length,producer:knownSum(rs.map(r=>r.producer.totalTokens)),judge:knownSum(rs.map(r=>r.judge ? r.judge.totalTokens : r.arm === 'best-of-3' ? r.selectorUsage?.totalTokens : 0))}));for(const r of rs)console.log(r.task,r.strictGrade.reasons,r.businessUsable,r.delivery?.status,r.delivery?.attempts?.map((a:any)=>[a.checks.status,a.review?.status]),r.producer.totalTokens,r.judge?.totalTokens??r.selectorUsage?.totalTokens??0);}
for(const arm of ['off','l1','judge-0','judge-2']){const rs=rows.filter(r=>r.cohort==='controlled-v1'&&r.arm===arm);console.log('CONTROLLED',arm);for(const r of rs)console.log(r.task,r.strictGrade.reasons,r.businessUsable,r.delivery?.status,r.delivery?.attempts?.map((a:any)=>[a.checks.status,a.review?.status]),r.producer.totalTokens,r.judge?.totalTokens);}
