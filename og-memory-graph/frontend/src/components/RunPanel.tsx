import { useEffect, useRef, useState } from 'react';
import type { TaskOut } from '../types';
import { createTask, fetchTasks, fetchTask, cancelTask, streamTask } from '../api/client';
import { usePreferences } from '../context/PreferenceContext';

interface Props {clusterId: string;model: string;}

const LLM_MODELS = [
{ value: 'deepseek-v4-pro', label: 'DeepSeek v4 Pro' },
{ value: 'deepseek-v4-flash', label: 'DeepSeek v4 Flash' },
{ value: 'doubao-seed-2-0-pro-260215', label: 'Doubao Seed Pro' },
{ value: 'qwen3-7b-plus', label: 'Qwen3 7B Plus' },
{ value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
{ value: 'gpt-4o', label: 'GPT-4o' },
{ value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
{ value: 'MiniMax-M3', label: 'MiniMax M3' }];


const FLAGS = [
{ key: 'curation', label: '--curation' },
{ key: 'rewrite', label: '--rewrite' },
{ key: 'balanced', label: '--balanced' },
{ key: 'polish', label: '--polish' },
{ key: 'skip_build', label: '--skip-build' }];


const STATUS_COLOR: Record<string, string> = {
  pending: '#94a3b8', running: '#f59e0b', done: '#22c55e', failed: '#ef4444'
};

function fmt(dt: string | null) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('zh-CN', { hour12: false });
}

function sendNotification(title: string, body: string) {
  if (Notification.permission === 'granted')
  new Notification(title, { body, icon: '/favicon.ico' });
}

export default function RunPanel({ clusterId }: Props) {
  const { prefs } = usePreferences();
  const [selModel, setSelModel] = useState(prefs.preferred_model || 'deepseek-v4-pro');
  const [flags, setFlags] = useState<Record<string, boolean>>(
    Object.fromEntries((prefs.default_flags || []).map((f) => [f, true]))
  );


  const prefApplied = useRef(false);
  useEffect(() => {
    if (!prefApplied.current && prefs.preferred_model !== 'deepseek-v4-pro') {
      setSelModel(prefs.preferred_model);
      setFlags(Object.fromEntries((prefs.default_flags || []).map((f) => [f, true])));
      prefApplied.current = true;
    }
  }, [prefs]);
  const [tasks, setTasks] = useState<TaskOut[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<TaskOut | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);


  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();
  }, []);

  const reload = () => {fetchTasks(clusterId).then(setTasks).catch(() => {});};
  useEffect(() => {reload();}, [clusterId]);


  const closeSSE = () => {
    sseRef.current?.close();
    sseRef.current = null;
  };
  useEffect(() => () => closeSSE(), []);

  const autoScroll = () => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  };


  const startSSE = (taskId: string) => {
    closeSSE();
    setLogLines([]);
    const src = streamTask(taskId);
    sseRef.current = src;

    src.onmessage = (e: MessageEvent) => {
      try {
        const line = JSON.parse(e.data) as string;
        setLogLines((prev) => [...prev, line]);
        setTimeout(autoScroll, 20);
      } catch {}
    };

    const finalize = (st: string) => {
      closeSSE();
      setActiveTask((prev) => prev ? { ...prev, status: st as TaskOut['status'] } : prev);
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: st as TaskOut['status'] } : t));
      reload();
      sendNotification('og_impl_v6', `任务 ${taskId.slice(0, 8)}… ${st === 'done' ? '✅ 完成' : '❌ 失败'}`);
    };
    src.addEventListener('done', () => finalize('done'));
    src.addEventListener('failed', () => finalize('failed'));
    src.onerror = () => {closeSSE();reload();};
  };

  const handleStart = async () => {
    setError('');setStarting(true);
    try {
      const cfg: Record<string, unknown> = { model: selModel, ...flags };
      const t = await createTask({ cluster_id: clusterId, type: 'run_a', config: cfg });
      setTasks((prev) => [t, ...prev]);
      setActiveId(t.id);
      setActiveTask(t);
      startSSE(t.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeId) return;
    await cancelTask(activeId).catch(() => {});
    closeSSE();
    const t = await fetchTask(activeId).catch(() => null);
    if (t) setActiveTask(t);
    reload();
  };

  const selectTask = async (t: TaskOut) => {
    closeSSE();
    setActiveId(t.id);
    setActiveTask(t);
    const log = await fetchTask(t.id).catch(() => null);
    if (log) setLogLines(log.log_tail);
    if (t.status === 'running') startSSE(t.id);
    setTimeout(autoScroll, 50);
  };

  const isRunning = activeTask?.status === 'running';

  return (
    <div className="run-panel">
      {}
      <div className="run-left">
        <div className="run-ctrl">
          <label className="form-row-h">
            <span>LLM 模型</span>
            <select className="form-sel" value={selModel}
            onChange={(e) => setSelModel(e.target.value)} disabled={isRunning}>
              {LLM_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>

          <div className="run-flags">
            {FLAGS.map((f) =>
            <label key={f.key} className="flag-row">
                <input type="checkbox" checked={!!flags[f.key]} disabled={isRunning}
              onChange={(e) => setFlags((prev) => ({ ...prev, [f.key]: e.target.checked }))} />
                <code>{f.label}</code>
              </label>
            )}
          </div>

          {error && <div className="form-err">{error}</div>}

          <div className="run-actions">
            <button className="btn-primary" onClick={handleStart} disabled={starting || isRunning}>
              {starting ? '启动中…' : '▶ 开始运行'}
            </button>
            {isRunning && <button className="btn-danger" onClick={handleCancel}>⏹ 中止</button>}
          </div>
        </div>

        <div className="run-history">
          <div className="run-hist-hd">历史任务</div>
          {tasks.length === 0 ?
          <div className="empty" style={{ padding: '16px', fontSize: 13 }}>暂无记录</div> :
          tasks.map((t) =>
          <div key={t.id}
          className={`run-hist-item${activeId === t.id ? ' on' : ''}`}
          onClick={() => selectTask(t)}>
                  <span className="run-badge"
            style={{ background: STATUS_COLOR[t.status] + '22', color: STATUS_COLOR[t.status] }}>
                    {t.status}
                  </span>
                  <span className="run-hist-time">{fmt(t.started_at)}</span>
                </div>
          )
          }
        </div>
      </div>

      {}
      <div className="run-right">
        {activeTask ?
        <>
              <div className="log-hd">
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{activeTask.id.slice(0, 8)}…</span>
                <span className="run-badge"
            style={{ background: STATUS_COLOR[activeTask.status] + '22',
              color: STATUS_COLOR[activeTask.status] }}>
                  {activeTask.status}
                </span>
                {activeTask.finished_at &&
            <span style={{ fontSize: 11, color: '#94a3b8' }}>完成于 {fmt(activeTask.finished_at)}</span>
            }
                {activeTask.status === 'running' &&
            <span style={{ fontSize: 11, color: '#f59e0b' }}>● 实时流</span>
            }
              </div>
              <div className="log-box" ref={logRef}>
                {logLines.length === 0 ?
            <span style={{ color: '#64748b' }}>（等待输出…）</span> :
            logLines.map((line, i) => <div key={i} className="log-line">{line}</div>)
            }
              </div>
            </> :
        <div className="empty" style={{ margin: 'auto' }}>← 点击历史任务查看日志，或开始新运行</div>
        }
      </div>
    </div>);

}
