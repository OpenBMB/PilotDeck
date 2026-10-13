import { useEffect, useRef, useState } from 'react';
import { Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';

type Binding = { status: string; agentName?: string; error?: { message: string } };
export function StaffDeckProjectBinding({ projectName }: { projectName?: string }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [binding, setBinding] = useState<Binding>();
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController>();
  const endpoint = `/api/projects/${encodeURIComponent(projectName ?? '')}/staffdeck-binding`;
  useEffect(() => {
    setBinding(undefined);
    setBusy(false);
    if (!projectName || projectName === 'general') return;
    const controller = new AbortController();
    activeRequest.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const read = () => authenticatedFetch(endpoint, { signal: controller.signal, suppressServerErrorToast: true })
      .then(async response => {
        if (response.ok && !controller.signal.aborted) {
          const next = await response.json();
          if (controller.signal.aborted) return;
          setBinding(next);
          if (next.status === 'binding') timer = setTimeout(read, 1000);
        }
      }).catch(() => {});
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, projectName]);
  if (!binding || binding.status === 'disabled') return null;
  const labels: Record<string, string> = zh
    ? { pending: '待绑定', binding: '绑定中', bound: '已绑定', failed: '绑定失败' }
    : { pending: 'Pending', binding: 'Connecting', bound: 'Connected', failed: 'Connection failed' };
  const retry = async () => {
    const controller = activeRequest.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`${endpoint}/ensure`, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(zh ? '无法完成绑定' : 'Could not connect');
      const next = await response.json();
      if (controller.signal.aborted) return;
      setBinding(next);
      window.dispatchEvent(new Event('pilotdeck:module-runtime-changed'));
    } catch (error) {
      if (controller.signal.aborted) return;
      setBinding({ status: 'failed', error: { message: String(error instanceof Error ? error.message : error) } });
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm" role="status">
    <Link2 size={16} aria-hidden="true" />
    <span>StaffDeck: {labels[binding.status] ?? binding.status}</span>
    {binding.agentName && <span className="min-w-0 break-all text-muted-foreground">{binding.agentName}</span>}
    {binding.error && <span className="min-w-0 break-words text-red-600">{binding.error.message}</span>}
    {binding.status !== 'bound' && <button type="button" disabled={busy || binding.status === 'binding'}
      onClick={retry} className="inline-flex items-center gap-1 rounded border px-2 py-1 disabled:opacity-50">
      <RefreshCw size={14} aria-hidden="true" />
      {busy ? (zh ? '绑定中' : 'Connecting') : binding.status === 'failed' ? (zh ? '重试' : 'Retry') : (zh ? '创建并绑定' : 'Create and connect')}
    </button>}
  </div>;
}
