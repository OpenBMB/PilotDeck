// Shared by the native page, the pre-bundle HTML and React on every platform.
export const startupStyle = `
.pd-startup-screen{position:fixed;inset:var(--desktop-caption-height,0px) 0 0;z-index:50;display:grid;place-items:center;box-sizing:border-box;padding:24px;background:var(--startup-bg,#fff);color:var(--startup-fg,#171717);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:pd-startup-enter .28s ease-out both;transition:opacity .18s ease,transform .18s ease}
.pd-startup-screen[data-leaving=true]{animation:none;opacity:0;transform:translateY(-4px);pointer-events:none}
.pd-startup-screen main{width:min(360px,100%);margin:0;text-align:center}
.pd-startup-screen[data-error=true] main{width:min(440px,100%)}
.pd-startup-brand{margin:0 0 28px;font-size:32px;font-weight:500;line-height:1.2;letter-spacing:-.045em}
.pd-startup-track{height:4px;overflow:hidden;border-radius:8px;background:var(--startup-line,#e5e5e5)}
.pd-startup-bar{position:relative;height:100%;border-radius:8px;background:var(--startup-fg,#171717);overflow:hidden;transition:width 1.1s cubic-bezier(.22,.61,.36,1)}
.pd-startup-bar:after{content:"";position:absolute;inset:0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);animation:pd-startup-glide 2.8s ease-in-out infinite}
.pd-startup-screen[data-complete=true] .pd-startup-bar{transition-duration:.24s}
.pd-startup-message{margin:18px 0 0;font-size:14px;line-height:22px;color:var(--startup-muted,#737373)}
.pd-startup-failure{border:1px solid var(--startup-line,#e5e5e5);border-radius:12px;padding:24px;text-align:center;animation:pd-startup-enter .2s ease-out both}
.pd-startup-failure h2{margin:0;font-size:18px;line-height:26px;font-weight:600}
.pd-startup-failure .reason{margin:12px 0;font-size:14px;line-height:22px}
.pd-startup-meta{font-size:12px;line-height:18px;color:var(--startup-muted,#737373);overflow-wrap:anywhere}
.pd-startup-actions{display:flex;gap:10px;margin-top:20px}
.pd-startup-actions button{flex:1;appearance:none;border:1px solid var(--startup-line,#e5e5e5);border-radius:7px;padding:10px 12px;background:var(--startup-fg,#171717);color:var(--startup-bg,#fff);font-family:inherit;font-size:14px;font-weight:500;line-height:20px;cursor:pointer}
.pd-startup-actions button.secondary{background:transparent;color:var(--startup-fg,#171717)}
.pd-startup-actions button:disabled{opacity:.6;cursor:default}
@keyframes pd-startup-enter{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
@keyframes pd-startup-glide{0%{transform:translateX(-160%)}100%{transform:translateX(340%)}}
@media(prefers-reduced-motion:reduce){.pd-startup-screen,.pd-startup-failure,.pd-startup-bar,.pd-startup-bar:after{animation:none;transition:none}}
`;
