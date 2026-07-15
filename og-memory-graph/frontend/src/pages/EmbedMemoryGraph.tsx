













import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import GraphView from '../components/GraphView';
import ReportView from '../components/ReportView';
import RefsViewLite from '../components/RefsViewLite';



type EmbedTab = 'graph' | 'reports' | 'refs';
type InitStage = 'loading' | 'ready' | 'error';
type PipelineStatus = string;

interface StatusPayload {
  pipeline_status: PipelineStatus;
  current_phase: number;
  last_sync: string | null;
  output_files: string[];
  topic: string;
  memory_path?: string;
}

interface SyncPayload {
  status: string;
  message: string;
  changed_files?: {path: string;type: string;}[];
  new_phase?: number;
}



const EMBED_BG = '#ffffff';
const BORDER_COLOR = '#e2e8f0';
const TEXT_MUTED = '#64748b';
const TEXT_MAIN = '#0f172a';
const ACCENT = '#6366f1';
const ACCENT_DIM = 'rgba(99,102,241,0.12)';

const POLL_INTERVAL_MS = 3000;






function makeClusterId(workspacePath: string): string {

  let h = 5381;
  for (let i = 0; i < workspacePath.length; i++) {
    h = (h << 5) + h + workspacePath.charCodeAt(i) >>> 0;
  }
  return `pd-${h.toString(16).padStart(8, '0').slice(0, 8)}`;
}



export default function EmbedMemoryGraph() {
  const [searchParams] = useSearchParams();

  const workspace = searchParams.get('workspace') ?? '';
  const memoryPath = searchParams.get('memory_path') ?? '';
  const name = searchParams.get('name') ?? 'pilotdeck-workspace';
  const model = searchParams.get('model') ?? 'deepseek';


  const [clusterId, setClusterId] = useState<string>("");

  const [initStage, setInitStage] = useState<InitStage>('loading');
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>('idle');
  const [outputFiles, setOutputFiles] = useState<string[]>([]);
  const [tab, setTab] = useState<EmbedTab>('graph');
  const [isSyncing, setIsSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [highlightRef, setHighlightRef] = useState<number | null>(null);

  const handleCitationClick = useCallback((refNum: number) => {
    setHighlightRef(refNum);
    setTab('refs');
  }, []);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPipelineStatus = useRef<PipelineStatus>('idle');



  const showToast = useCallback((msg: string, durationMs = 3000) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);



  const startPolling = useCallback((cid: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      const res = await fetch(`/api/pd/status/${encodeURIComponent(cid)}`).catch(() => null);
      if (!res?.ok) return;
      const data: StatusPayload = await res.json();
      const newStatus = data.pipeline_status ?? 'idle';
      const files = data.output_files ?? [];
      setPipelineStatus(newStatus);
      setOutputFiles(files);

      if (newStatus !== 'running' && newStatus !== 'initializing') {
        clearInterval(pollTimerRef.current!);
        pollTimerRef.current = null;
        if (newStatus === 'done') {
          showToast('✓ 图谱已更新完成');
        } else if (newStatus.startsWith('failed')) {
          showToast('⚠ Pipeline 失败，请查看日志', 6000);
        }
      }
      prevPipelineStatus.current = newStatus;
    }, POLL_INTERVAL_MS);
  }, [showToast]);



  useEffect(() => {
    if (!workspace && !name) {
      setInitStage('error');
      setInitError('缺少 workspace 或 name 参数');
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        const res = await fetch('/api/pd/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace,
            memory_path: memoryPath || undefined,
            workspace_name: name,
            workspace_desc: '',
            model
          })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`init 失败 (${res.status}): ${text}`);
        }
        const data = await res.json();
        if (cancelled) return;

        const cid = data.cluster_id ?? makeClusterId(workspace);
        setClusterId(cid);


        const sr = await fetch(`/api/pd/status/${encodeURIComponent(cid)}`).catch(() => null);
        if (sr?.ok) {
          const sd: StatusPayload = await sr.json();
          if (!cancelled) {
            setPipelineStatus(sd.pipeline_status ?? 'idle');
            setOutputFiles(sd.output_files ?? []);

            if (sd.pipeline_status === 'running' || sd.pipeline_status === 'initializing') {
              startPolling(cid);
            }
          }
        }

        setInitStage('ready');
      } catch (e: unknown) {
        if (!cancelled) {
          setInitStage('error');
          setInitError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    init();
    return () => {cancelled = true;};

  }, []);



  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);



  const handleSync = useCallback(async () => {
    if (isSyncing || pipelineStatus === 'running' || initStage !== 'ready') return;
    setIsSyncing(true);
    try {
      const res = await fetch(`/api/pd/sync/${encodeURIComponent(clusterId)}`, {
        method: 'POST'
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        showToast(`⚠ 同步失败：${text}`, 5000);
        return;
      }
      const data: SyncPayload = await res.json();

      if (data.status === 'no_changes') {
        showToast('无新变化，无需更新');
      } else if (data.status === 'started') {
        const count = data.changed_files?.length ?? 0;
        showToast(`检测到 ${count} 个文件变化，正在更新…`);
        setPipelineStatus('running');
        startPolling(clusterId);
      } else if (data.status === 'pipeline_running') {
        showToast('Pipeline 仍在运行，请稍候');
      } else {
        showToast(data.message ?? '同步请求已发送');
      }
    } catch (e: unknown) {
      showToast(`⚠ 网络错误：${e instanceof Error ? e.message : String(e)}`, 5000);
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, pipelineStatus, initStage, clusterId, showToast, startPolling]);





  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data) return;
      if (e.data.type === 'og-sync') {
        handleSync();
      } else if (e.data.type === 'og-navigate') {
        const t = e.data.tab as EmbedTab;
        if (t === 'graph' || t === 'reports' || t === 'refs') setTab(t);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleSync]);



  const hasAnyReport = outputFiles.some((f) => f.endsWith('.md'));



  const isRunning = pipelineStatus === 'running' || pipelineStatus === 'initializing';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', width: '100%',
      background: EMBED_BG, color: TEXT_MAIN,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
      position: 'relative'
    }}>
      {}
      <style>{`
        @keyframes og-pulse {
          0%,100%{opacity:1} 50%{opacity:.4}
        }
        @keyframes og-fadein {
          from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)}
        }
      `}</style>

      {}
      {toast &&
      <div style={{
        position: 'absolute', top: '52px', left: '50%',
        transform: 'translateX(-50%)',
        background: '#f8fafc', border: `1px solid ${BORDER_COLOR}`,
        borderRadius: '8px', padding: '7px 16px',
        fontSize: '13px', color: TEXT_MAIN,
        zIndex: 100, whiteSpace: 'nowrap',
        animation: 'og-fadein 0.2s ease',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        pointerEvents: 'none'
      }}>
          {toast}
        </div>
      }

      {}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 12px', height: '44px',
        background: '#f8fafc', borderBottom: `1px solid ${BORDER_COLOR}`,
        flexShrink: 0, gap: '8px'
      }}>
        {}
        <span style={{ fontSize: '13px', color: TEXT_MUTED, fontWeight: 600, marginRight: '4px' }}>
          {name}
        </span>

        {}
        <div style={{ flex: 1 }} />

        {}
        {initStage === 'loading' &&
        <span style={{ fontSize: '12px', color: TEXT_MUTED }}>● 初始化…</span>
        }
        {initStage === 'error' &&
        <span style={{ fontSize: '12px', color: '#ef4444', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ✕ {initError ?? '初始化失败'}
          </span>
        }
      </div>

      {}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '6px 12px', borderBottom: `1px solid ${BORDER_COLOR}`,
        background: '#f8fafc', flexShrink: 0
      }}>
        {(['graph', 'reports', 'refs'] as EmbedTab[]).map((t) =>
        <button
          key={t}
          onClick={() => setTab(t)}
          style={{
            padding: '5px 14px',
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            background: tab === t ? ACCENT_DIM : 'transparent',
            color: tab === t ? ACCENT : TEXT_MUTED,
            transition: 'background 0.12s, color 0.12s'
          }}>
          
            {t === 'graph' ? '图谱' : t === 'reports' ? '报告' : '参考文献'}
          </button>
        )}

        {}
        {initStage === 'ready' &&
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: TEXT_MUTED }}>
            {hasAnyReport ? '✓ 报告可用' : isRunning ? '生成中…' : '暂无报告'}
          </span>
        }
      </div>

      {}
      {}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {initStage === 'loading' &&
        <div style={{
          height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: TEXT_MUTED, fontSize: '14px', gap: '10px'
        }}>
            <span style={{ animation: 'og-pulse 1.2s ease-in-out infinite' }}>●</span>
            正在初始化记忆图谱…
          </div>
        }

        {initStage === 'error' &&
        <div style={{
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: '#ef4444', fontSize: '14px', gap: '8px'
        }}>
            <div>⚠ 初始化失败</div>
            <div style={{ fontSize: '12px', color: TEXT_MUTED, maxWidth: '400px', textAlign: 'center' }}>
              {initError}
            </div>
          </div>
        }

        {initStage === 'ready' && tab === 'graph' &&
        <GraphView clusterId={clusterId} model={model} />
        }

        {initStage === 'ready' && tab === 'reports' &&
        <ReportView
          clusterId={clusterId}
          model={model}
          onCitationClick={handleCitationClick} />

        }

        {initStage === 'ready' && tab === 'refs' &&
        <RefsViewLite
          clusterId={clusterId}
          model={model}
          highlightRef={highlightRef} />

        }
      </div>
    </div>);

}
