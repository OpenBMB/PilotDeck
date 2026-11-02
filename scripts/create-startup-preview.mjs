// Optional local review artifact. Not part of the shipped application/router.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { renderLoadingHtml } = require('../apps/desktop/dist/appearance.js');
let logPath = '~/.pilotdeck/logs/runtime.log';
try { logPath = (await (await fetch('http://127.0.0.1:3001/api/diagnostics/location')).json()).logPath || logPath; } catch {}
let html = renderLoadingHtml({ language: 'zh-CN', themeMode: 'light' }, true);
html = html.replace('<head>', `<head><script>
window.pilotdeckDesktop={getAppearance:()=>({language:'zh-CN',themeMode:'light'}),getRuntimeStatus:()=>({phase:'starting',progress:8,startedAt:Date.now(),phaseStartedAt:Date.now()}),onRuntimeStatus:()=>()=>{}};
</script>`);
html = html.replace('</body>', `<nav aria-label="启动界面演示" style="position:fixed;bottom:20px;left:20px;right:20px;z-index:100;text-align:center;font:13px/1.8 system-ui,sans-serif;color:#737373">
<p>界面演示 · 不修改配置</p>
${[['fast','快速启动'],['slow','慢速启动'],['oom','内存不足'],['config','配置错误'],['missing','缺少文件']].map(([id,label])=>`<button data-scenario="${id}" style="border:1px solid #ddd;border-radius:8px;padding:7px 12px;margin:4px;background:white;color:#171717;cursor:pointer">${label}</button>`).join('')}
<a href="/" style="margin-left:12px;color:#171717">打开工作区</a></nav>
<div id="preview-completed" style="display:none;position:fixed;inset:0;place-items:center;font:20px system-ui,sans-serif">启动完成</div>
<script>(()=>{
let timers=[];
const root=document.getElementById('startup'),done=document.getElementById('preview-completed');
const codes={oom:'PD_RUNTIME_OUT_OF_MEMORY',config:'PD_CONFIG_INVALID',missing:'PD_RESOURCE_NOT_FOUND'};
function run(kind){
 timers.forEach(clearTimeout);timers=[];done.style.display='none';root.dataset.leaving='false';root.dataset.complete='false';
 const startedAt=Date.now();
 const update=(phase,progress,extra={})=>window.__pilotdeckStartupUpdate({phase,progress,startedAt,phaseStartedAt:Date.now(),...extra});
 update('starting',8);
 const slow=kind==='slow',times=slow?[600,1800,4200,12000]:[140,280,480,760];
 for(const [i,stage] of [['config',22],['server',45],['gateway',78],['ready',96]].entries()){
  timers.push(setTimeout(()=>update(stage[0],stage[1]),times[i]));
 }
  if(codes[kind]){timers.forEach(clearTimeout);timers=[setTimeout(()=>update('gateway',78),400),setTimeout(()=>update('error',78,{error:'Error code: '+codes[kind],logPath:${JSON.stringify(logPath).replaceAll('<', '\u003c')}}),1000)];}
 else{timers.push(setTimeout(()=>{update('ready',100,{completed:true});root.dataset.complete='true';},times[3]+200),setTimeout(()=>{root.dataset.leaving='true';},times[3]+500),setTimeout(()=>{done.style.display='grid';},times[3]+700));}
}
document.querySelectorAll('[data-scenario]').forEach(button=>button.addEventListener('click',()=>run(button.dataset.scenario)));
document.getElementById('retry').onclick=()=>run('fast');run('slow');
})();</script></body>`);
const destination = path.resolve('ui/dist/startup-preview.html');
fs.writeFileSync(destination, html);
console.log(`Startup preview: http://127.0.0.1:3001/startup-preview.html (${destination})`);
