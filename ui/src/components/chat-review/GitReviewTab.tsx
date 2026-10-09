import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, GitBranch, Link, ArrowUpFromLine, RefreshCw, Loader2 } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { readJson, useChatReview, type GitEntry } from './ChatReviewContext';
import { getWorkspaceFileIdentity, getWorkspaceRelativePath } from '../../utils/workspaceFileMention';
import GitFileGroup from './GitFileGroup';

type Remote = { hasRemote?: boolean; hasUpstream?: boolean; remoteName?: string; ahead?: number; behind?: number; error?: string };
const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900';
const selectionKey = (side: 'staged' | 'unstaged', path: string) => `${side}:${path}`;
const entryKeys = (file: GitEntry) => [
  ...(file.staged && !file.conflicted ? [selectionKey('staged', file.path)] : []),
  ...(file.unstaged || file.conflicted ? [selectionKey('unstaged', file.path)] : []),
];

export default function GitReviewTab() {
  const review = useChatReview()!;
  const [selected, setSelected] = useState<string[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]), [remote, setRemote] = useState<Remote>({}), [remoteUrl, setRemoteUrl] = useState('');
  const [remoteSetupOpen, setRemoteSetupOpen] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string; side: string } | null>(null);
  const selectionTarget = useRef<string | null>(null);
  const project = review.project, status = review.git;
  const refreshDetails = useCallback(async () => {
    if (!project) return;
    const options = { suppressServerErrorToast: true };
    const [branchResult, remoteResult] = await Promise.all([
      authenticatedFetch(`/api/git/branches?project=${encodeURIComponent(project.name)}`, options).then(response => response.json()).catch(() => ({})),
      authenticatedFetch(`/api/git/remote-status?project=${encodeURIComponent(project.name)}`, options).then(response => response.json()).catch(() => ({})),
    ]);
    setBranches(branchResult.localBranches ?? branchResult.branches ?? []); setRemote(remoteResult);
  }, [project]);
  const refresh = useCallback(async () => { await review.refreshGit(); }, [review.refreshGit]);
  useEffect(() => { if (status && !status.error) void refreshDetails(); }, [status, refreshDetails]);
  const checkpoint = review.data.checkpoints.find(item => item.id === review.checkpointId) ?? review.data.checkpoints.filter(item => item.phase === 'after').at(-1);
  useEffect(() => {
    const repository = status?.repositoryRoot ?? '', workspace = project?.fullPath || project?.path || '';
    if (!repository || !status?.entries) {
      selectionTarget.current = null; setSelected(previous => previous.length ? [] : previous); return;
    }
    if (review.loading && !review.data.checkpoints.length) return;
    const target = `${repository}\0${workspace}\0${review.sessionId}\0${checkpoint?.id ?? ''}`;
    if (selectionTarget.current === target) {
      const existing = new Set(status.entries.flatMap(entryKeys));
      setSelected(previous => previous.every(file => existing.has(file)) ? previous : previous.filter(file => existing.has(file)));
      return;
    }
    selectionTarget.current = target;
    const subdirectory = getWorkspaceRelativePath(workspace, repository);
    const prefix = subdirectory ? `${subdirectory}/` : '';
    const identities = new Set(checkpoint?.changes.map(file => getWorkspaceFileIdentity(`${prefix}${file.path}`, repository)) ?? []);
    // Keep Git's exact filename for subsequent operations while matching Windows
    // drive letters, separators and casing through the shared path helper.
    setSelected(status.entries.filter(file => identities.has(getWorkspaceFileIdentity(file.path, repository))).flatMap(entryKeys));
  }, [checkpoint, status?.repositoryRoot, status?.entries, project?.fullPath, project?.path, review.sessionId, review.loading, review.data.checkpoints.length]);
  const execute = async (operation: string, extra: Record<string, unknown> = {}) => {
    if (!project || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await readJson<{ output?: string }>(await authenticatedFetch('/api/git/operation', { method: 'POST', suppressServerErrorToast: true, body: JSON.stringify({ project: project.name, sessionId: review.sessionId, operation, ...extra }) }));
      setNotice(operation === 'commit' ? '本地提交已创建。' : operation === 'push' ? '推送完成。' : operation === 'init' ? 'Git 仓库已初始化，请选择文件创建首次提交。' : '操作完成。');
      if (operation === 'commit') { setMessage(''); setSelected([]); }
      if (operation === 'remote') { setRemoteUrl(''); setRemoteSetupOpen(false); }
      await refresh(); await review.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const blocked = busy || review.running || review.data.busy || review.readOnly;
  const entries = status?.entries ?? [], staged = entries.filter(file => file.staged && !file.conflicted), unstaged = entries.filter(file => file.unstaged && !file.conflicted), conflicted = entries.filter(file => file.conflicted);
  const viewDiff = async (file: GitEntry, side: 'staged' | 'unstaged') => {
    if (!project) return;
    setError(null);
    try {
      const result = await readJson<{ diff: string }>(await authenticatedFetch(`/api/git/review-diff?project=${encodeURIComponent(project.name)}&file=${encodeURIComponent(file.path)}&side=${side}`, { suppressServerErrorToast: true }));
      setDiff({ path: file.path, text: result.diff, side });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const group = (label: string, files: GitEntry[], side: 'staged' | 'unstaged') => <GitFileGroup label={label} files={files} side={side} blocked={blocked}
    selected={files.filter(file => selected.includes(selectionKey(side, file.path))).map(file => file.path)}
    onSelection={(paths, checked) => {
      const keys = new Set(paths.map(path => selectionKey(side, path)));
      setSelected(previous => checked ? [...new Set([...previous, ...keys])] : previous.filter(key => !keys.has(key)));
    }}
    onAction={files => void execute(side === 'staged' ? 'unstage' : 'stage', { files: [...new Set(files.flatMap(file => side === 'staged' && file.originalPath ? [file.path, file.originalPath] : [file.path]))] })}
    onDiff={file => void viewDiff(file, side)} />;
  if (!project) return <p className="p-4 text-xs text-neutral-500">选择项目后可管理 Git。</p>;
  const noRepository = status?.isRepository === false || (status?.error && /not a git repository|does not contain|initialize/i.test(status.error));
  return <div className="space-y-3 p-3.5 text-xs" data-testid="git-review-tab">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">Git 仓库</span>{notice && <span role="status" className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400"><Check aria-hidden="true" className="h-3 w-3" />{notice}</span>}</div>
    {error && <pre role="alert" className="whitespace-pre-wrap break-words rounded bg-red-500/10 p-2 font-sans text-red-600 dark:text-red-400">{error}</pre>}
    {noRepository ? <div className="space-y-3 py-6"><p>这个项目是普通文件夹，自动检查点和文件恢复可用。</p><button type="button" className={button} disabled={blocked} onClick={() => void execute('init')}><GitBranch className="h-3.5 w-3.5" />初始化 Git 仓库</button></div> : status?.error ? <p role="alert" className="text-red-500">{status.error}<button type="button" className={`${button} ml-2`} onClick={() => void refresh()}>刷新</button></p> : !status ? <p className="py-6 text-neutral-500">正在读取 Git 状态…</p> : <>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label title={status.repositoryRoot} className="inline-flex min-w-0 items-center gap-1.5"><GitBranch className="h-3.5 w-3.5 shrink-0" /><select aria-label="当前 Git 分支" value={status.branch ?? ''} disabled={blocked} onChange={event => void execute('checkout', { branch: event.target.value })} className="min-w-0 max-w-64 bg-transparent py-1"><option value={status.branch}>{status.branch}</option>{branches.filter(branch => branch !== status.branch).map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label>
        <div className="flex shrink-0 items-center gap-1">
          {remote.hasRemote ? <><button type="button" aria-label="Fetch" title="获取远程更新" className={button} disabled={blocked} onClick={() => void execute('fetch')}><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /></button><button type="button" aria-label="Push" title="推送当前分支" className={button} disabled={blocked || !status.hasCommits || (remote.hasUpstream && !remote.ahead)} onClick={() => void execute('push')}><ArrowUpFromLine aria-hidden="true" className="h-3.5 w-3.5" /></button></>
            : <button type="button" aria-expanded={remoteSetupOpen} aria-controls="git-remote-setup" className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-violet-600 dark:hover:text-violet-400" onClick={() => setRemoteSetupOpen(value => !value)}><Link aria-hidden="true" className="h-3 w-3" />连接远程仓库</button>}
        </div>
      </div>
      {remote.hasRemote && <p className="text-[11px] text-neutral-500">{`${remote.remoteName || 'origin'} · ↑${remote.ahead ?? 0} ↓${remote.behind ?? 0}${!remote.hasUpstream ? ' · 尚未设置跟踪分支' : ''}`}</p>}
      {!remote.hasRemote && remoteSetupOpen && <div id="git-remote-setup" className="space-y-2 rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800"><label className="block">远程仓库地址<input aria-label="远程仓库地址" value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="已创建仓库的 HTTPS 或 SSH 地址" className="mt-1 w-full rounded border border-neutral-200 bg-transparent p-2 dark:border-neutral-700" /></label><button type="button" className={button} disabled={blocked || !remoteUrl.trim()} onClick={() => void execute('remote', { remoteUrl: remoteUrl.trim() })}>关联仓库</button></div>}
      <div className="space-y-2">
        <textarea aria-label="Git 提交说明" placeholder={`消息（在“${status.branch || '当前分支'}”上提交）`} value={message} onChange={event => setMessage(event.target.value)} rows={1} className="block min-h-9 w-full resize-y rounded-md border border-neutral-200 bg-transparent px-2.5 py-2 text-xs placeholder:text-neutral-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 dark:border-neutral-700" />
        <button type="button" className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 font-medium text-white hover:bg-violet-700 disabled:opacity-40" title={staged.length ? `提交暂存区的全部 ${staged.length} 个文件` : '请先暂存需要提交的文件'} disabled={blocked || !message.trim() || !staged.length || !!conflicted.length} onClick={() => void execute('commit', { message: message.trim(), expectedIndexTree: status.indexTree })}>{busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Check aria-hidden="true" className="h-4 w-4" />}{status.hasCommits ? '提交' : '创建首次提交'}</button>
      </div>
      {conflicted.length > 0 && group('待解决冲突', conflicted, 'unstaged')}
      {staged.length > 0 && group('已暂存', staged, 'staged')}
      {unstaged.length > 0 && group('未暂存', unstaged, 'unstaged')}
      {!entries.length && <p className="py-3 text-neutral-500">工作区干净</p>}
      {diff && <div className="overflow-hidden rounded border border-neutral-200 dark:border-neutral-700"><div className="break-all bg-neutral-100 p-2 dark:bg-neutral-900">{diff.path} · {diff.side === 'staged' ? '已暂存' : '未暂存'}</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-5">{diff.text || '无文本差异。'}</pre></div>}
    </>}
  </div>;
}
