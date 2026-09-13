import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Grade = { usable: boolean; checks: Record<string, boolean>; reasons: string[] };
export function grade(task: any, files: Record<string, string>, finalText: string): Grade {
  if (task.gradingTaskId) task = { ...task, id: task.gradingTaskId };
  const checks: Record<string, boolean> = {};
  const text = task.output ? files[task.output] ?? '' : extractText(finalText);
  checks.delivered = text.trim().length > 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const has = (pattern: RegExp) => pattern.test(text);
  if (task.id.startsWith('code-')) {
    try {
      const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const source = `const module = { exports: {} }; (function(exports,module){${compiled}\n})(module.exports,module); const { parseEnv, mergeIntervals } = module.exports;`;
      const evaluation = task.id === 'code-env' ? `
        const value = parseEnv(' # skip\\r\\n A = one=two \\r\\nB="x#y"\\nC=\\nNOPE\\n=bad\\nA=last\\n__proto__=safe');
        const flags = {basic:value.A==='last'&&value.B==='x#y'&&value.C==='',ignored:!('NOPE' in value)&&!('' in value),prototype:Object.hasOwn(value,'__proto__')&&value.__proto__==='safe',quotes:parseEnv("Q='a=b'\\nE= =x").Q==='a=b',empty:Object.keys(parseEnv('')).length===0}; flags;
      ` : `
        const input=[[3,5],[1,2],[2,3],[-2,-1]], before=JSON.stringify(input);
        const flags={merge:JSON.stringify(mergeIntervals(input))==='[[-2,-1],[1,5]]',immutable:JSON.stringify(input)===before,empty:JSON.stringify(mergeIntervals([]))==='[]',decimal:JSON.stringify(mergeIntervals([[.1,.2],[.2,.3]]))==='[[0.1,0.3]]'};
        flags.invalid=[null,[[2,1]],[[NaN,2]],[[0,Infinity]],[[1]],['bad']].every(v=>{try{mergeIntervals(v);return false}catch(e){return e instanceof TypeError}}); flags;
      `;
      Object.assign(checks, runInNewContext(`${source}\n${evaluation}`, {}, { timeout: 1000 }));
    } catch { checks.executable = false; }
  } else if (task.family === 'data') {
    try {
      const value = JSON.parse(text);
      if (task.id === 'data-revenue') {
        checks.net = value.net_cents === 5500;
        checks.included = JSON.stringify(value.included_ids) === JSON.stringify(['a','c','d','f','g']);
      } else {
        checks.minutes = value.total_minutes === 105;
        checks.count = value.eligible_count === 3;
        checks.strictThreshold = JSON.stringify(value.breach_ids) === '["b"]';
      }
    } catch { checks.parse = false; }
  } else if (task.id === 'research-launch') {
    checks.length = words <= 180;
    checks.scope = has(/5\s*%/) && has(/internal/i);
    checks.blockers = has(/reconcil/i) && has(/rollback/i) && has(/0\.7/) && has(/0\.1/);
    checks.owners = has(/Payments/i) && has(/SRE/i);
    checks.sources = has(/plan\.md/) && has(/update\.md/) && has(/meeting\.md/);
    checks.notCommitted = has(/not\s+(?:a\s+)?commit|no\s+.*commit|not\s+.*guarantee|uncommitted|no\s+.*date/i);
  } else if (task.id === 'research-vendor') {
    checks.length = words <= 160;
    checks.both = has(/Birch/i) && has(/Atlas/i);
    checks.gap = has(/10[,.]?000/) && has(/2[,.]?000/);
    checks.telemetry = has(/telemetry/i) && has(/disabl/i) && has(/traffic|outbound|network/i);
    checks.conditional = has(/conditional|contingent|subject to|only after|before|pending/i);
    checks.sources = has(/vendor-a\.md/) && has(/vendor-b\.md/) && has(/brief\.md/);
  } else if (task.id === 'text-runbook') {
    checks.length = words <= 140;
    checks.fiveSteps = (text.match(/^\s*\d+[.)]\s/gm) ?? []).length === 5;
    checks.stop = has(/data loss/i) && has(/stop/i) && has(/preserv/i) && has(/storage/i);
    checks.approval = has(/incident commander/i) && has(/approv/i) && has(/deploy/i);
    checks.recovery = has(/0\.5\s*%/) && has(/10\s+(?:consecutive\s+)?minutes/i);
    checks.followup = has(/record|document/i);
  } else if (task.id === 'text-reply') {
    checks.length = words >= 60 && words <= 110;
    checks.policy = has(/30/) && has(/unused/i);
    checks.requiredInfo = has(/order number/i) && has(/proof of purchase/i);
    checks.inspection = has(/inspection|inspect/i);
    checks.noPromise = !has(/(?:we will|we'll|guaranteed|approved)\s+(?:issue\s+)?(?:a\s+|your\s+)?refund/i);
  }
  const reasons = Object.entries(checks).filter(([, pass]) => !pass).map(([key]) => key);
  return { usable: reasons.length === 0, checks, reasons };
}
export function extractText(finalText: string): string {
  try {
    const value = JSON.parse(finalText.replace(/^```json\s*|\s*```$/g, ''));
    return value.result?.text ?? value.text ?? value.summary ?? finalText;
  } catch {
    const legacy = /(?:^|\n)Result:\s*([\s\S]*?)(?=\n(?:Key files|Files changed|Issues):|$)/.exec(finalText);
    return legacy?.[1]?.trim() ?? finalText;
  }
}
