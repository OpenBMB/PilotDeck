import { randomBytes } from 'node:crypto';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainEvent, Rectangle } from 'electron';
import type { SystemNotification } from '../../../ui/shared/notifications';

export type TaskReminderSnapshot = { scope: string; language: string; reminders: SystemNotification[]; soundId?: string; error?: string };
type Palette = { background: string; foreground: string; muted: string; border: string; accent: string; soft: string };

export function taskReminderHtml(nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
  *{box-sizing:border-box}body{margin:0;background:var(--background,#fff);color:var(--foreground,#262626);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}header{padding:14px 18px;border-bottom:1px solid var(--border,#ddd);font-weight:600;-webkit-app-region:drag}main{padding:12px;display:grid;gap:12px;max-height:calc(100vh - 48px);overflow:auto}article{padding:16px;border:1px solid var(--border,#ddd);border-radius:14px}h2{font-size:14px;margin:8px 0}p{font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;color:var(--muted,#666);display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.label{color:var(--accent,#555);font-size:12px;display:flex;align-items:center;gap:8px}.label button{margin-left:auto}button{font:inherit;cursor:pointer;background:transparent;color:var(--accent,#555);border:0;border-radius:7px;padding:5px 8px}button:hover{background:var(--soft,#eee)}button:focus-visible{outline:2px solid var(--accent,#555);outline-offset:2px}footer{display:flex;justify-content:space-between;align-items:center;margin-top:12px}time{font-size:11px;color:var(--muted,#666)}
  </style></head><body><header id="heading">PilotDeck</header><main id="cards" aria-live="polite"></main><script nonce="${nonce}">
  window.taskReminders.onUpdate(({snapshot,palette})=>{
    for(const [key,value] of Object.entries(palette))document.documentElement.style.setProperty('--'+key,value);
    const zh=snapshot.language.startsWith('zh');document.documentElement.lang=zh?'zh-CN':'en';
    document.getElementById('heading').textContent=zh?'PilotDeck · 定时提醒':'PilotDeck · Scheduled reminders';
    const cards=document.getElementById('cards');cards.replaceChildren();
    for(const item of snapshot.reminders){
      const article=document.createElement('article');article.setAttribute('role','alert');article.dataset.reminderId=item.id;
      const label=document.createElement('div');label.className='label';label.textContent=item.body.split('\\n')[0];
      const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label',(zh?'关闭提醒：':'Dismiss reminder: ')+item.title);close.onclick=()=>window.taskReminders.dismiss(item.id);label.append(close);
      const title=document.createElement('h2');title.textContent=item.title;
      const body=document.createElement('p');body.textContent=item.body.split('\\n').slice(1).join('\\n');
      const footer=document.createElement('footer');const time=document.createElement('time');time.textContent=new Date(item.data.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const view=document.createElement('button');view.textContent=zh?'查看任务 ↗':'View task ↗';view.onclick=()=>window.taskReminders.view(item.id);footer.append(time,view);
      article.append(label,title,body,footer);cards.append(article);
    }
    if(snapshot.error){const status=document.createElement('p');status.setAttribute('role','status');status.textContent=snapshot.error;cards.append(status);}
  });
  </script></body></html>`;
}

/** One independent, non-modal window. Navigation and focus never acknowledge it. */
export function createTaskReminderWindow(options: {
  platform: NodeJS.Platform; create: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  preloadPath: string; workArea: () => Rectangle; palette: () => Palette; isQuitting: () => boolean;
  view: (data: SystemNotification['data']) => Promise<void>; dismiss: (id: string) => void;
  allowSound: () => boolean; beep: () => void; report: (error: unknown) => void;
}) {
  let window: BrowserWindow | null = null;
  let url = '';
  let loading: Promise<void> | null = null;
  let snapshot: TaskReminderSnapshot = { scope: '', language: 'en', reminders: [] };
  const sounded = new Set<string>();
  const publish = () => { if (window && !window.isDestroyed()) window.webContents.send('pilotdeck:task-reminders-update', { snapshot, palette: options.palette() }); };
  const dispose = () => { const previous = window; window = null; loading = null; previous?.destroy(); };
  return {
    dispose,
    refresh: publish,
    setScope(scope: string | null) { if (scope !== snapshot.scope) { snapshot = { scope: scope || '', language: 'en', reminders: [] }; dispose(); } },
    async update(value: TaskReminderSnapshot) {
      snapshot = value;
      if (!value.reminders.length || options.isQuitting()) { dispose(); return; }
      const area = options.workArea();
      const width = Math.min(400, area.width - 32), height = Math.min(560, area.height - 32, 68 + value.reminders.length * 205);
      if (!window || window.isDestroyed()) {
        const nonce = randomBytes(18).toString('hex');
        url = `data:text/html;charset=utf-8,${encodeURIComponent(taskReminderHtml(nonce))}`;
        const created = options.create({ width, height, x: area.x + area.width - width - 16, y: area.y + area.height - height - 16,
          show: false, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false,
          fullscreenable: false, title: 'PilotDeck', backgroundColor: options.palette().background,
          webPreferences: { preload: options.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window = created;
        created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        created.webContents.on('will-navigate', event => event.preventDefault());
        created.on('close', event => {
          if (!options.isQuitting() && snapshot.reminders.length) { event.preventDefault(); options.dismiss(snapshot.reminders[0].id); }
        });
        created.on('closed', () => { if (window === created) { window = null; loading = null; } });
        if (options.platform !== 'win32') created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        loading = created.loadURL(url).then(() => { if (window === created && !created.isDestroyed()) { publish(); created.showInactive(); } });
      } else {
        window.setBounds({ x: area.x + area.width - width - 16, y: area.y + area.height - height - 16, width, height });
        if (!loading) publish();
      }
      const pending = loading;
      try { await pending; if (loading === pending) loading = null; publish(); }
      catch (error) { if (window && !window.isDestroyed()) { dispose(); throw error; } }
      if (value.soundId && value.reminders.some(item => item.id === value.soundId) && !sounded.has(value.soundId)) {
        sounded.add(value.soundId);
        if (options.allowSound()) options.beep();
      }
    },
    handle(event: IpcMainEvent, value: { id?: unknown; action?: unknown }) {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== url) return false;
      const item = snapshot.reminders.find(item => item.id === value?.id);
      if (!item) return false;
      if (value.action === 'dismiss') options.dismiss(item.id);
      else if (value.action === 'view') void options.view(item.data).catch(options.report);
      else return false;
      return true;
    },
  };
}
