import { useMemo, useState } from 'react';
import { BellOff, MessagesSquare, X } from 'lucide-react';
import type { Project } from '../../types/app';
import type { AgentGroup, GroupTriggerMode } from '../../types/group';

type Props = {
  projects: Project[];
  initialProjectName?: string;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    projectName: string;
    triggerMode: GroupTriggerMode;
    muted: boolean;
  }) => Promise<AgentGroup>;
};

export default function GroupCreateDialog({
  projects,
  initialProjectName,
  onClose,
  onCreate,
}: Props) {
  const defaultProjectName = useMemo(() => {
    if (initialProjectName && projects.some((project) => project.name === initialProjectName)) {
      return initialProjectName;
    }
    return projects.find((project) => project.name === 'general')?.name || projects[0]?.name || '';
  }, [initialProjectName, projects]);
  const [title, setTitle] = useState('');
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [triggerMode, setTriggerMode] = useState<GroupTriggerMode>('auto');
  const [muted, setMuted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!title.trim() || !projectName || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onCreate({ title: title.trim(), projectName, triggerMode, muted });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <div data-modal-overlay className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex items-center gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
            <MessagesSquare className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">创建智能体群组</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">主智能体会常驻，先理解需求，再自主决定是否邀请其他成员协作。</p>
          </div>
          <button type="button" aria-label="关闭创建群组" onClick={onClose} className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">群组名称</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="例如：PilotDeck × StaffDeck 产品讨论"
              className="h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-blue-950"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">绑定工作空间</span>
            <select
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              className="h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-950"
            >
              {projects.map((project) => (
                <option key={project.name} value={project.name}>
                  {project.name === 'general' ? '通用' : project.displayName || project.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-neutral-500">群组中的本地 PilotDeck 智能体会在这个目录内读取项目上下文。</p>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">智能体触发方式</legend>
            <label className="flex cursor-pointer gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
              <input type="radio" checked={triggerMode === 'auto'} onChange={() => setTriggerMode('auto')} />
              <span>
                <span className="block text-sm font-medium">智能协调</span>
                <span className="block text-xs text-neutral-500">消息先由你的通用智能体处理；需要时再真实邀请合适成员。</span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
              <input type="radio" checked={triggerMode === 'mentions'} onChange={() => setTriggerMode('mentions')} />
              <span>
                <span className="block text-sm font-medium">仅 @ 触发</span>
                <span className="block text-xs text-neutral-500">只有被 @ 的智能体回复，也可以使用 @所有人。</span>
              </span>
            </label>
          </fieldset>

          <label className="flex cursor-pointer items-center justify-between rounded-xl bg-neutral-50 px-3 py-3 dark:bg-neutral-800/60">
            <span className="flex items-center gap-2">
              <BellOff className="h-4 w-4 text-neutral-500" />
              <span>
                <span className="block text-sm font-medium">消息免打扰</span>
                <span className="block text-xs text-neutral-500">静默通知和醒目未读提示，不暂停执行。</span>
              </span>
            </span>
            <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} className="h-4 w-4" />
          </label>

          {error ? <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button type="button" onClick={onClose} className="h-9 rounded-lg px-4 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800">取消</button>
          <button
            type="button"
            disabled={!title.trim() || !projectName || submitting}
            onClick={() => void submit()}
            className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {submitting ? '创建中…' : '创建群组'}
          </button>
        </div>
      </div>
    </div>
  );
}
