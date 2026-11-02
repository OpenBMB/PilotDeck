import { startupLabels } from './startupPresentation';
import { normalizeLightAppearance, deriveLightColors, type LightAppearance } from './lightAppearance';
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

export function renderLoadingHtml(appearance: DesktopAppearance): string {
  const labels = startupLabels(appearance.language);
  const light = normalizeLightAppearance(appearance.lightAppearance);
  const canvas = light.preset === 'default' ? '#ffffff' : deriveLightColors(light).background;
  return `<!doctype html>
<html lang="${appearance.language}" data-theme="${appearance.themeMode}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>PilotDeck</title>
<style>
:root {color-scheme:light;--bg:${canvas};--fg:#171717;--muted:#737373;--line:#e5e5e5;--error:#dc2626}
:root[data-theme="dark"] {color-scheme:dark;--bg:#0a0a0a;--fg:#f5f5f5;--muted:#a3a3a3;--line:#262626;--error:#f87171}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{color-scheme:dark;--bg:#0a0a0a;--fg:#f5f5f5;--muted:#a3a3a3;--line:#262626;--error:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px;padding-top:calc(24px + var(--desktop-caption-height,0px));display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(360px,100%);text-align:center}.mark{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 16px;border-radius:12px;background:var(--fg);color:var(--bg);font-size:30px;font-weight:700}h1{margin:0 0 24px;font-size:24px;line-height:32px;font-weight:700}.track{height:4px;overflow:hidden;border-radius:9px;background:var(--line)}.bar{height:100%;width:8%;border-radius:9px;background:var(--fg);transition:width .45s ease}#message{margin:16px 0 0;color:var(--muted);font-size:14px;line-height:20px}
#failure{display:none;text-align:left;border:1px solid var(--line);border-radius:12px;padding:24px}h2{margin:0;font-size:18px;line-height:26px}#reason{font-size:14px;line-height:22px;margin:12px 0}#code,#log,#saveStatus{font-size:12px;line-height:18px;color:var(--muted);overflow-wrap:anywhere}#log{margin:8px 0 20px}.actions{display:flex;gap:10px}button{flex:1;border:1px solid var(--line);border-radius:7px;padding:10px 12px;background:var(--fg);color:var(--bg);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}.secondary{background:transparent;color:var(--fg)}button:disabled{opacity:.6;cursor:default}.error{width:min(440px,100%)}.error #loading{display:none}.error #failure{display:block}@media(prefers-reduced-motion:reduce){.bar{transition:none}}
</style></head><body><main id="startup"><div class="mark" aria-hidden="true">P</div><h1>PilotDeck</h1>
<div id="loading" role="status"><div class="track" role="progressbar" aria-label="PilotDeck" aria-valuemin="0" aria-valuemax="100" aria-valuenow="8"><div class="bar" id="bar"></div></div><p id="message">${labels.starting}</p></div>
<section id="failure" role="alert"><h2>${labels.failed}</h2><p id="reason"></p><div id="code"></div><p id="log"></p><div class="actions"><button id="retry">${labels.restart}</button><button id="saveLog" class="secondary">${labels.save}</button></div><p id="saveStatus" role="status"></p></section>
</main><script>
const labels=${JSON.stringify(labels)};
const main=document.getElementById('startup'),bar=document.getElementById('bar'),message=document.getElementById('message');
let progress=8;
function update(status){
 if(!status)return;
 if(status.phase==='starting')progress=8;
 progress=Math.max(progress,status.progress||8);bar.style.width=progress+'%';bar.parentElement.setAttribute('aria-valuenow',String(progress));
 main.classList.toggle('error',status.phase==='error');
 if(status.phase==='error'){
  const code=(status.error||'').match(/\\bPD_[A-Z_]+\\b/)?.[0]||'PD_RUNTIME_PROCESS_FAILED';
  document.getElementById('reason').textContent=labels[code]||labels.unknown;
  document.getElementById('code').textContent=code;
  document.getElementById('log').textContent=status.logPath?labels.log+': '+status.logPath:'';
 }else message.textContent=labels[status.phase]||labels.starting;
}
window.pilotdeckDesktop?.onRuntimeStatus(update);update(window.pilotdeckDesktop?.getRuntimeStatus?.());
document.getElementById('retry').addEventListener('click',()=>window.pilotdeckDesktop?.retryRuntime());
document.getElementById('saveLog').addEventListener('click',async()=>{
 const button=document.getElementById('saveLog'),status=document.getElementById('saveStatus');button.disabled=true;status.textContent='';
 try{const result=await window.pilotdeckDesktop?.saveRuntimeLogs();if(result&&!result.canceled)status.textContent=labels.saved;}catch{status.textContent=labels.saveFailed;}finally{button.disabled=false;}
});
</script></body></html>`;
}
