import { useCallback, useEffect, useRef, useState } from 'react';
import type { FrontendModule, SurfaceProps } from '../contracts';
import { authenticatedFetch } from '../../utils/api';
import { SkillFlow } from './staffdeck/vendor/DistillPage';
import type { SkillCard } from './staffdeck/vendor/DistillPageHost';
import SopVersionDetailDialog from './staffdeck/vendor/SopVersionDetailDialog';
import FormalSopApprovalInbox from './staffdeck/vendor/FormalSopApprovalInbox';
import { createPublicApprovalClient, type ApprovalStatus, type PinnedApproval } from './staffdeck/public-approval-client';
import StaffDeckLocaleBoundary from './staffdeck/StaffDeckLocaleBoundary';

type Draft = { id: string; sop_id: string; etag: string; revision: number; content: SkillCard; status: string };
type CatalogRow = { sop_id: string; name?: string; status: string; published_version?: string; content?: SkillCard };
async function request(path: string, input?: unknown, signal?: AbortSignal) {
  const response = await authenticatedFetch(`/api/sop/native/${path}`, {
    ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }), signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `SOP request failed (${response.status})`);
  return body;
}
const management = (operation: string, input: Record<string, unknown> = {}) => request('management', { operation, input });
const button = 'rounded border border-border px-3 py-2 text-sm disabled:opacity-50';

/** Native host owns management and generation; shared graph and version views are UI only. */
export function PilotDeckSopPage() {
  const [rows, setRows] = useState<CatalogRow[]>([]), [drafts, setDrafts] = useState<Draft[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null), [content, setContent] = useState<SkillCard | null>(null);
  const [source, setSource] = useState(''), [sourceOpen, setSourceOpen] = useState(false);
  const [prompt, setPrompt] = useState(''), [modelId, setModelId] = useState('');
  const [capabilities, setCapabilities] = useState<any>({ models: [], bindings: [] });
  const [jobId, setJobId] = useState(() => sessionStorage.getItem('pilotdeck-sop-job') || '');
  const [stream, setStream] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState(''), [versions, setVersions] = useState<any[]>([]), [detail, setDetail] = useState<any>(null);
  const graph = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const catalog = await management('list'); setRows(catalog.data); setDrafts(catalog.drafts);
  }, []);
  const selectDraft = (value: Draft) => { setDraft(value); setContent(value.content); setSource(JSON.stringify(value.content, null, 2)); setVersions([]); };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh().catch(cause => setError(cause.message)); void request('capabilities').then(setCapabilities).catch(cause => setError(cause.message)); }, [refresh]);
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    sessionStorage.setItem('pilotdeck-sop-job', jobId);
    let after = 0, ended = false;
    const consume = async () => {
      while (!controller.signal.aborted && !ended) {
        try {
          const response = await authenticatedFetch(`/api/sop/native/jobs/${encodeURIComponent(jobId)}/events?after_seq=${after}`, { signal: controller.signal });
          if (!response.ok || !response.body) throw new Error('Cannot read generation task');
          let buffer = ''; const decoder = new TextDecoder(); const reader = response.body.getReader();
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split('\n\n'); buffer = blocks.pop() || '';
            for (const block of blocks) {
              const event = block.match(/^event: (.+)$/m)?.[1]; const raw = block.match(/^data: (.+)$/m)?.[1];
              if (!raw) continue; const data = JSON.parse(raw); after = data.seq;
              if (event === 'chunk') setStream(value => value + data.content);
              if (event === 'chunk_reset') setStream('');
              if (event === 'complete') { selectDraft(data.saved_draft); setNotice('生成结果已保存为草稿，请检查后发布。'); ended = true; void refresh(); }
              if (event === 'error') { setError(data.message); ended = true; }
            }
          }
        } catch (cause) { if (controller.signal.aborted) return; setError(`生成连接中断，正在续读：${(cause as Error).message}`); }
        if (!ended) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (ended) { setJobId(''); sessionStorage.removeItem('pilotdeck-sop-job'); }
    };
    void consume(); return () => controller.abort();
  }, [jobId, refresh]);
  const save = async () => {
    if (!content) throw new Error('请选择草稿');
    const next = draft ? await management('replace_draft', { sopId: draft.sop_id, draftId: draft.id, etag: draft.etag, content })
      : await management('create', { content });
    selectDraft(next); await refresh(); return next as Draft;
  };
  const generate = (kind: 'generate' | 'rewrite') => action(async () => {
    let saved = draft;
    if (kind === 'rewrite') saved = await save();
    const job = await request('jobs', { kind, prompt, instruction: prompt, modelId,
      ...(saved && kind === 'rewrite' ? { sopId: saved.sop_id, draftId: saved.id, etag: saved.etag } : {}) });
    setStream(''); setJobId(job.id);
  });
  const showVersions = (sopId: string) => action(async () => {
    const result = await management('list_versions', { sopId }); setVersions(result.data);
  });
  const bindings = (kind: string) => capabilities.bindings.filter((value: any) => value.kind === kind).map((value: any) => ({ id: value.capabilityId, name: value.capabilityId }));
  return <StaffDeckLocaleBoundary><main className="h-full overflow-y-auto p-4 text-foreground sm:p-6" data-testid="native-sop-page">
    <h1 className="text-xl font-semibold">SOP 工作流</h1>
    <p className="my-2 text-sm text-muted-foreground">生成后保存草稿，发布后可在对话使用 /sop 工作流ID。人工节点由当前登录 owner 处理。</p>
    {error && <p role="alert" className="my-2 break-words text-destructive">{error}</p>}
    {notice && <p role="status" className="my-2 text-sm">{notice}</p>}
    <div className="my-4 flex flex-wrap gap-2">
      <button className={button} onClick={() => { setDraft(null); setContent({ skill_id: `sop_${Date.now()}`, name: '新工作流', version: '1.0.0', start_node_id: 'done', terminal_node_ids: ['done'], nodes: [{ node_id: 'done', type: 'response', instruction: '总结结果并完成' }], edges: [] }); setVersions([]); }}>新建</button>
      <label className={button}>导入 JSON<input aria-label="导入 SOP JSON" type="file" accept=".json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void action(async () => { selectDraft(await management('import', { content: JSON.parse(await file.text()) })); await refresh(); }); }} /></label>
      <button className={button} onClick={() => void action(refresh)}>刷新目录</button>
    </div>
    <section aria-label="SOP 生成" className="mb-4 space-y-2 rounded border border-border p-3">
      <label className="block">生成或改写要求<textarea aria-label="生成要求" className="mt-1 w-full rounded border border-border bg-background p-2" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><select aria-label="生成模型" className={button + ' max-w-full bg-background'} value={modelId} onChange={event => setModelId(event.target.value)}><option value="">默认模型</option>{capabilities.models.map((model: any) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select>
        <button className={button} disabled={busy || Boolean(jobId) || !prompt.trim()} onClick={() => void generate('generate')}>生成 SOP</button>
        <button className={button} disabled={busy || Boolean(jobId) || !content || !prompt.trim()} onClick={() => void generate('rewrite')}>改写当前草稿</button>
        {jobId && <button className={button} onClick={() => void action(async () => { await request(`jobs/${jobId}/cancel`, {}); })}>取消生成</button>}
      </div>
      {jobId && <p role="status">正在生成，任务 {jobId}</p>}
      {stream && <details><summary>模型输出</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{stream}</pre></details>}
    </section>
    <section aria-label="工作流目录" className="mb-4 grid gap-2 sm:grid-cols-2">
      {rows.map(row => <article key={row.sop_id} className="min-w-0 rounded border border-border p-3"><strong className="break-all">{row.name || row.sop_id}</strong><p className="break-all text-xs">{row.sop_id} · {row.status} · {row.published_version || '未发布'}</p>
        <div className="mt-2 flex flex-wrap gap-2"><button className={button} onClick={() => void showVersions(row.sop_id)}>版本</button>
          {row.content && <button className={button} onClick={() => void action(async () => { const value = structuredClone(row.content!); const parts = String(value.version).split('.'); value.version = `${parts[0] || 1}.${parts[1] || 0}.${Number(parts[2] || 0) + 1}`; selectDraft(await management('create', { content: value })); await refresh(); })}>新版本草稿</button>}
          <button className={button} onClick={() => void action(async () => { await management('archive', { sopId: row.sop_id }); await refresh(); })}>归档</button>
          <button className={button} onClick={() => { if (window.confirm(`删除 ${row.sop_id}？已有会话仍保留固定快照。`)) void action(async () => { await management('delete', { sopId: row.sop_id }); await refresh(); }); }}>删除</button>
        </div></article>)}
    </section>
    <section aria-label="草稿目录" className="mb-4 flex flex-wrap gap-2">{drafts.map(value => <button key={value.id} className={button} onClick={() => void action(async () => selectDraft(await management('get_draft', { sopId: value.sop_id, draftId: value.id })))}>{value.content.name || value.sop_id} 草稿 r{value.revision}</button>)}</section>
    {versions.length > 0 && <section aria-label="版本列表" className="my-4">{versions.map(value => <div key={value.version} className="my-2 flex flex-wrap gap-2"><span>{value.name} {value.version}</span><button className={button} onClick={() => setDetail(value)}>版本详情</button><button className={button} onClick={() => void action(async () => { await management('rollback', { sopId: value.sop_id, version: value.version }); await refresh(); setNotice(`发布指针已切换至 ${value.version}`); })}>回退到此版本</button></div>)}</section>}
    {content && <section aria-label="草稿编辑器" className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2"><input aria-label="工作流名称" className={button + ' min-w-0 bg-background'} value={content.name || ''} onChange={event => setContent({ ...content, name: event.target.value })} /><input aria-label="版本号" className={button + ' w-28 bg-background'} value={content.version || ''} onChange={event => setContent({ ...content, version: event.target.value })} />
        <button className={button} disabled={busy} onClick={() => void action(async () => { await save(); setNotice('草稿已保存'); })}>保存草稿</button>
        <button className={button} disabled={busy} onClick={() => void action(async () => { const saved = await save(); await management('publish', { sopId: saved.sop_id, draftId: saved.id, expectedRevision: saved.revision }); setDraft(null); setContent(null); await refresh(); setNotice('发布成功，新会话立即使用此版本'); })}>发布</button>
        <button className={button} onClick={() => { setSource(JSON.stringify(content, null, 2)); setSourceOpen(!sourceOpen); }}>JSON 编辑</button>
      </div>
      {sourceOpen && <div><textarea aria-label="SOP JSON" className="h-64 w-full rounded border border-border bg-background p-2 font-mono text-xs" value={source} onChange={event => setSource(event.target.value)} /><button className={button} onClick={() => void action(async () => { const result = await management('validate', { content: JSON.parse(source) }); setContent(result.content); setNotice('定义校验通过'); })}>校验并应用 JSON</button></div>}
      <div ref={graph} className="relative min-h-[580px] overflow-hidden rounded border border-border"><SkillFlow skill={content} selectedPaths={[]} highlightedPaths={[]} updatingPaths={[]} dirtyPaths={[]} textDiffs={[]} toolDescriptions={{}} toolStatuses={{}} generalSkills={bindings('skill')} sopSkills={rows.filter(row => row.status === 'published').map(row => ({ id: row.sop_id, skill_id: row.sop_id, name: row.name || row.sop_id, version: row.published_version! }))} tools={bindings('tool')} knowledgeBases={bindings('knowledge')} tenantUsers={[{ id: 'pilotdeck:owner', username: '当前登录 owner' }]} containerRef={graph as any} lockSkillId={Boolean(draft)} assistantPanelOpen={false} onAssistantPanelOpenChange={() => {}} onFullscreenChange={() => {}} onToggle={() => {}} onEdit={value => setContent(value)} /></div>
    </section>}
    <SopVersionDetailDialog detail={detail} onClose={() => setDetail(null)} />
  </main></StaffDeckLocaleBoundary>;
}

const approvalClient = createPublicApprovalClient(() => '', 'pilotdeck');
export function PilotDeckSopApproval({ sessionId, projectKey, refreshKey, disabled, onError }: SurfaceProps) {
  const [status, setStatus] = useState<ApprovalStatus | null>(null), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const pending = useRef<{ key: string; requestId: string; message: string } | null>(null);
  useEffect(() => {
    setStatus(null); setError(''); if (!sessionId) return;
    const controller = new AbortController();
    const load = () => approvalClient.status({ sessionKey: sessionId, projectKey }, { signal: controller.signal }).then(setStatus).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sessionId, projectKey, refreshKey]);
  const reply = async (approval: PinnedApproval, message: string) => {
    if (!sessionId || disabled) return;
    const key = `${sessionId}:${approval.waitId}:${approval.revision}`;
    if (pending.current?.key !== key || pending.current.message !== message) pending.current = { key, requestId: crypto.randomUUID(), message };
    setSubmitting(true); setError('');
    try {
      await approvalClient.resume({ sessionKey: sessionId, projectKey, requestId: pending.current.requestId, waitId: approval.waitId, expectedRevision: approval.revision, message });
      setStatus(await approvalClient.status({ sessionKey: sessionId, projectKey }));
    } catch (cause) { const text = (cause as Error).message; setError(text); onError?.(text); }
    finally { setSubmitting(false); }
  };
  if (!status?.approval && !status?.approvalError) return error ? <p role="alert">{error}</p> : null;
  return <FormalSopApprovalInbox status={status} error={error} submitting={submitting || disabled} onReply={reply} />;
}

const module: FrontendModule = {
  id: 'pilotdeck.sop', slot: 'sop', source: 'pilotdeck', contract: 'sop.lifecycle/v3', frontendApiVersion: 'frontend-module/v1', buildMarker: 'pilotdeck.sop.ui/v1', requires: ['agentLoop'],
  pages: [{ id: 'sop', path: '/sop', label: 'SOP 工作流', component: PilotDeckSopPage }, { id: 'sop-distill', path: '/sop/distill', label: '编辑工作流', component: PilotDeckSopPage }],
  approvalInbox: FormalSopApprovalInbox,
  chatExtensions: [{ id: 'native-sop-approval', label: 'SOP 人工审批', component: PilotDeckSopApproval, requiresRuntime: true }],
};
export default module;
