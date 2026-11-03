import { startupLabels, startupVisualProgress } from './startupPresentation';
import { startupStyle } from './startupStyle';
import { LIGHT_PRESETS, normalizeLightAppearance, deriveLightColors, type LightAppearance } from './lightAppearance';
import { normalizeInterfacePreferences, type InterfacePreferences } from './interfacePreferences';
export type DesktopAppearance = { language: 'en' | 'zh-CN'; themeMode: 'light' | 'dark' | 'system'; lightAppearance?: LightAppearance; interfacePreferences?: InterfacePreferences };

export function normalizeAppearance(value: unknown, locale = 'en'): DesktopAppearance {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    language: record.language === 'en' || record.language === 'zh-CN' ? record.language : locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    themeMode: record.themeMode === 'light' || record.themeMode === 'dark' ? record.themeMode : 'system',
    ...(record.lightAppearance !== undefined ? { lightAppearance: normalizeLightAppearance(record.lightAppearance) } : {}),
    ...(record.interfacePreferences !== undefined ? { interfacePreferences: normalizeInterfacePreferences(record.interfacePreferences) } : {}),
  };
}

const STARTUP_ZH: Record<string, string> = {
  "Preparing PilotDeck runtime...": "正在准备 PilotDeck 运行环境…",
  "Checking local configuration...": "正在检查本地配置…",
  "Starting Web UI server...": "正在启动网页服务…",
  "PilotDeck is ready for model setup.": "PilotDeck 已就绪，请配置模型。",
  "PilotDeck runtime stopped.": "PilotDeck 运行环境已停止。",
  "Gateway exited unexpectedly. The Web UI is still available.": "Gateway 意外退出，网页界面仍可使用。",
  "Model configuration needs attention.": "模型配置需要修复。",
  "Starting local gateway...": "正在启动本地 Gateway…",
  "PilotDeck is ready.": "PilotDeck 已就绪。",
  "Gateway failed to start. The Web UI is still available.": "Gateway 启动失败，网页界面仍可使用。",
  "server exited unexpectedly. See runtime log for details.": "网页服务意外退出，请查看运行日志。",
  "gateway exited unexpectedly. See runtime log for details.": "Gateway 意外退出，请查看运行日志。",
  "PilotDeck failed to start.": "PilotDeck 启动失败。",
  "PilotDeck failed to restore window.": "PilotDeck 无法恢复窗口。",
  "Retry": "重试",
  "Open Log": "打开日志",
  "Starting PilotDeck...": "正在启动 PilotDeck…",
  "Log: ": "日志：",
  "Unknown startup error.": "未知的启动错误。",
  "PilotDeck could not stop": "PilotDeck 无法停止"
};

export function startupText(message: string, language: DesktopAppearance['language']): string {
  return language === 'zh-CN' ? STARTUP_ZH[message] || message : message;
}

export function renderLoadingHtml(appearance: DesktopAppearance, web = false): string {
  const labels = startupLabels(appearance.language);
  const light = normalizeLightAppearance(appearance.lightAppearance);
  const canvas = light.preset === 'default' ? '#ffffff' : deriveLightColors(light).background;
  return `<!doctype html><html lang="${appearance.language}" data-theme="${appearance.themeMode}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>PilotDeck</title>
<style>
:root{color-scheme:light;--startup-bg:${canvas};--startup-fg:#171717;--startup-muted:#737373;--startup-line:#e5e5e5}
:root[data-theme="dark"]{color-scheme:dark;--startup-bg:#0a0a0a;--startup-fg:#f5f5f5;--startup-muted:#a3a3a3;--startup-line:#262626}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{color-scheme:dark;--startup-bg:#0a0a0a;--startup-fg:#f5f5f5;--startup-muted:#a3a3a3;--startup-line:#262626}}
${startupStyle}
#failure{display:none}#startup[data-error=true] #loading{display:none}#startup[data-error=true] #failure{display:block}#saveStatus:empty{display:none}
</style></head><body style="margin:0"><div class="pd-startup-screen" id="startup"><main><h1 class="pd-startup-brand">PilotDeck</h1>
<div id="loading" role="status"><div class="pd-startup-track" role="progressbar" aria-label="PilotDeck" aria-valuemin="0" aria-valuemax="100" aria-valuenow="8"><div class="pd-startup-bar" id="bar" style="width:8%"></div></div><p class="pd-startup-message" id="message">${labels.starting}</p></div>
<section class="pd-startup-failure" id="failure" role="alert"><h2>${labels.failed}</h2><p class="reason" id="reason"></p><div class="pd-startup-meta" id="code"></div><p class="pd-startup-meta" id="log"></p><div class="pd-startup-actions"><button id="retry">${labels.restart}</button><button id="saveLog" class="secondary">${labels.save}</button></div><p class="pd-startup-meta" id="saveStatus" role="status"></p></section>
</main></div><script>(()=>{
const web=${web};
const languages=${JSON.stringify({ en: startupLabels('en'), 'zh-CN': startupLabels('zh-CN') })};
const saved=key=>{try{return localStorage.getItem(key)}catch{return null}};
const appearance=web?(window.pilotdeckDesktop?.getAppearance?.()||{language:saved('userLanguage')||(navigator.language.startsWith('zh')?'zh-CN':'en'),themeMode:saved('themeMode')||saved('theme')||'system'}):${JSON.stringify({ language: appearance.language, themeMode: appearance.themeMode })};
let labels=languages[appearance.language]||languages.en;
if(web){
 document.documentElement.dataset.theme=appearance.themeMode;
 // The application's default canvas is lavender. Keep the startup canvas the
 // same as the native document, even after the application's CSS has loaded.
 let preference=appearance.lightAppearance;try{preference??=JSON.parse(saved('pilotdeck-light-appearance-v1')||'null')}catch{}
 const presets=${JSON.stringify(LIGHT_PRESETS)};
 const background=preference?.preset==='custom'?preference.custom?.background:preference?.preset!=='default'?presets[preference?.preset]?.background:null;
 const dark=appearance.themeMode==='dark'||appearance.themeMode==='system'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches;
 document.documentElement.style.setProperty('--startup-bg',dark?'#0a0a0a':/^#[0-9a-f]{6}$/i.test(background)?background:'#ffffff');
}
const root=document.getElementById('startup'),bar=document.getElementById('bar'),message=document.getElementById('message');
const visualProgress=${startupVisualProgress.toString()};
let current={phase:'starting',progress:8,startedAt:Date.now(),phaseStartedAt:Date.now()};
let animationStart=0;
function draw(){bar.style.width=visualProgress(current)+'%';bar.parentElement.setAttribute('aria-valuenow',String(current.progress||8))}
function update(status){
 if(!status)return;
 const reset=status.phase==='starting'&&current.phase!=='starting';
 const finishing=current.completed&&!reset&&status.phase!=='error'&&status.phase!=='stopped';
 current={...status,completed:!!(status.completed||finishing),leaving:!!(status.leaving||finishing&&current.leaving),progress:reset?8:Math.max(current.progress||8,status.progress||8),startedAt:status.startedAt||(reset?Date.now():current.startedAt),phaseStartedAt:status.phaseStartedAt||(status.phase===current.phase?current.phaseStartedAt:Date.now())};
 if(status.language)labels=languages[status.language]||languages.en;
 if(animationStart!==current.startedAt){animationStart=current.startedAt;root.style.setProperty('--startup-animation-offset',-(Date.now()-animationStart)+'ms')}
 window.__pilotdeckStartupState=current;root.dataset.error=String(status.phase==='error');root.dataset.complete=String(current.completed);root.dataset.leaving=String(current.leaving);draw();
 if(status.phase==='error'){
  const code=(status.error||'').match(/\\bPD_[A-Z_]+\\b/)?.[0]||'PD_RUNTIME_PROCESS_FAILED';
  document.getElementById('reason').textContent=labels[code]||labels.unknown;
  document.getElementById('code').textContent=code;
  document.getElementById('log').textContent=status.logPath?labels.log+': '+status.logPath:'';
 }else message.textContent=labels[status.phase]||labels.starting;
}
message.textContent=labels.starting;document.querySelector('#failure h2').textContent=labels.failed;document.getElementById('retry').textContent=labels.restart;document.getElementById('saveLog').textContent=labels.save;
// Seed the real position before enabling transitions. A new document must not
// animate from the template's 8% after the native loading page nearly finished.
bar.style.transition='none';
const unsubscribe=window.pilotdeckDesktop?.onRuntimeStatus(update);update(window.pilotdeckDesktop?.getRuntimeStatus?.()||current);
bar.getBoundingClientRect();bar.style.transition='';
const timer=setInterval(draw,400);window.__pilotdeckStartupCleanup=()=>{clearInterval(timer);unsubscribe?.()};window.__pilotdeckStartupUpdate=update;
document.getElementById('retry').addEventListener('click',()=>window.pilotdeckDesktop?.retryRuntime?window.pilotdeckDesktop.retryRuntime():window.location.reload());
document.getElementById('saveLog').addEventListener('click',async()=>{
 const button=document.getElementById('saveLog'),status=document.getElementById('saveStatus');button.disabled=true;status.textContent='';
 try{
  if(window.pilotdeckDesktop?.saveRuntimeLogs){const result=await window.pilotdeckDesktop.saveRuntimeLogs();if(!result.canceled)status.textContent=labels.saved}
  else{const response=await fetch('/api/diagnostics/logs');if(!response.ok)throw Error('Download failed');const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='PilotDeck-runtime.log';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 }catch{status.textContent=labels.saveFailed}finally{button.disabled=false}
});
})();</script></body></html>`;
}
