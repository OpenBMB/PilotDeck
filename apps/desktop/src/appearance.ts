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
  const text = (value: string) => startupText(value, appearance.language);
  const light = normalizeLightAppearance(appearance.lightAppearance);
  const canvas = light.preset === 'default' ? '#ffffff' : deriveLightColors(light).background;
  return `<!doctype html>
<html lang="${appearance.language}" data-theme="${appearance.themeMode}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PilotDeck</title>
  <style>
     :root { color-scheme: light; --bg: ${canvas}; --fg: #171717; --muted: #525252; --line: #e5e5e5; --panel: #fafafa; --error-bg: #fef2f2; --error-fg: #991b1b; --shadow: rgba(0,0,0,.12); }
    :root[data-theme="dark"] { color-scheme: dark; --bg: #0a0a0a; --fg: #f5f5f5; --muted: #a3a3a3; --line: #303039; --panel: #19191f; --error-bg: #35191f; --error-fg: #fecaca; --shadow: rgba(0,0,0,.35); }
    @media (prefers-color-scheme: dark) {
      :root[data-theme="system"] { color-scheme: dark; --bg: #0a0a0a; --fg: #f5f5f5; --muted: #a3a3a3; --line: #303039; --panel: #19191f; --error-bg: #35191f; --error-fg: #fecaca; --shadow: rgba(0,0,0,.35); }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding-top: var(--desktop-caption-height, 0px);
      display: grid;
      place-items: center;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    main {
      width: min(520px, calc(100vw - 48px));
      display: grid;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--fg);
      color: var(--bg);
      font-weight: 800;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      background: var(--panel);
      box-shadow: 0 18px 60px var(--shadow);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--line);
      border-top-color: var(--fg);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #message {
      margin: 0;
      font-size: 15px;
      line-height: 1.45;
      color: var(--fg);
    }
    #detail {
      display: none;
      margin: 14px 0 0;
      padding: 12px;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      border-radius: 6px;
      background: var(--error-bg);
      color: var(--error-fg);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #log {
      margin-top: 12px;
      color: var(--muted);
      font-size: 12px;
      word-break: break-all;
    }
    .actions {
      display: none;
      gap: 10px;
      margin-top: 16px;
    }
    button {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 12px;
      background: var(--fg);
      color: var(--bg);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--fg);
    }
    .error .spinner { display: none; }
    .error #detail,
    .error .actions { display: flex; }
    .error #detail { display: block; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">P</div><div>PilotDeck</div></div>
    <section class="panel" id="panel">
      <div class="row">
        <div class="spinner" aria-hidden="true"></div>
        <p id="message">${text("Preparing PilotDeck runtime...")}</p>
      </div>
      <pre id="detail"></pre>
      <div id="log"></div>
      <div class="actions">
        <button id="retry">${text("Retry")}</button>
        <button id="openLog" class="secondary">${text("Open Log")}</button>
      </div>
    </section>
  </main>
  <script>
    const translations = ${JSON.stringify(appearance.language === 'zh-CN' ? STARTUP_ZH : {})};
    const translate = value => translations[value] || value;
    const panel = document.getElementById("panel");
    const message = document.getElementById("message");
    const detail = document.getElementById("detail");
    const log = document.getElementById("log");
    const retry = document.getElementById("retry");
    const openLog = document.getElementById("openLog");

    window.pilotdeckDesktop?.onRuntimeStatus((status) => {
      message.textContent = translate(status.message || "Starting PilotDeck...");
      log.textContent = status.logPath ? translate("Log: ") + status.logPath : "";
      if (status.phase === "error") {
        panel.classList.add("error");
        detail.textContent = status.error || translate(status.message || "Unknown startup error.");
      } else {
        panel.classList.remove("error");
        detail.textContent = "";
      }
    });
    retry.addEventListener("click", () => window.pilotdeckDesktop?.retryRuntime());
    openLog.addEventListener("click", () => window.pilotdeckDesktop?.openRuntimeLog());
  </script>
</body>
</html>`;
}
