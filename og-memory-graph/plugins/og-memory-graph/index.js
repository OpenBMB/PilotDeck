










let iframeEl = null;
let currentSrc = null;

function buildSrc(ogBase, project, model) {
  if (!project || !project.path) return null;
  const params = new URLSearchParams({
    workspace: project.path,
    name: project.name || 'project',
    model: model || 'deepseek',
    _v: String(Date.now())
  });
  return `${ogBase}/embed/memory-graph?${params.toString()}`;
}

async function render(container, api) {
  let cfg;
  try {
    cfg = await api.rpc('GET', 'config');
  } catch (e) {
    container.innerHTML = `<div style="padding:16px;font-size:13px;color:#dc2626">记忆图谱插件服务未就绪：${String(e)}</div>`;
    return;
  }
  const ogBase = cfg.og_base || 'http://127.0.0.1:8000';
  const model = cfg.model || 'deepseek';
  const ctx = api.context;
  const src = buildSrc(ogBase, ctx.project, model);

  if (!src) {
    container.innerHTML = '<div style="padding:16px;font-size:13px;color:#64748b">请选择一个项目查看记忆图谱。</div>';
    return;
  }

  if (!iframeEl) {
    iframeEl = document.createElement('iframe');
    iframeEl.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    iframeEl.setAttribute('allow', 'same-origin;popups');
    iframeEl.title = '记忆图谱';
    container.innerHTML = '';
    container.appendChild(iframeEl);
  }

  if (src !== currentSrc) {
    currentSrc = src;
    iframeEl.src = src;
  }
}

export function mount(container, api) {
  currentSrc = null;
  iframeEl = null;
  render(container, api).catch((e) => {
    container.innerHTML = `<div style="padding:16px;font-size:13px;color:#dc2626">加载失败：${String(e)}</div>`;
  });

  const off = api.onContextChange(() => {
    render(container, api).catch(() => {});
  });

  container.__ogUnsub = off;
}

export function unmount(container) {
  if (container.__ogUnsub) {
    try {container.__ogUnsub();} catch {}
    container.__ogUnsub = null;
  }
  iframeEl = null;
  currentSrc = null;
  container.innerHTML = '';
}
