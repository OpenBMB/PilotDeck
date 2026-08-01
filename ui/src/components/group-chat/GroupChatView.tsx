import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Bell,
  BellOff,
  Bot,
  Loader2,
  Menu,
  MessageCircleMore,
  MoreHorizontal,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type {
  AgentGroup,
  AgentGroupMember,
  AgentGroupMessage,
  AvailableGroupMember,
  AvailableGroupMembers,
  GroupMemberKind,
  GroupTriggerMode,
} from '../../types/group';
import { api } from '../../utils/api';
import { Markdown } from '../chat/view/subcomponents/Markdown';

type Props = {
  groupId: string;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  onGroupsChanged: () => void;
  onArchived: () => void;
};

const POLL_MS = 1_200;

const kindLabel: Record<GroupMemberKind, string> = {
  pilotdeck_main: '主智能体',
  pilotdeck_local: 'PilotDeck',
  pilotdeck_remote: '远程 PilotDeck',
  staffdeck: 'StaffDeck 员工',
  staffdeck_mock: 'Mock 员工',
};

const avatarTone: Record<GroupMemberKind, string> = {
  pilotdeck_main: 'bg-blue-600 text-white',
  pilotdeck_local: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-200',
  pilotdeck_remote: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200',
  staffdeck: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200',
  staffdeck_mock: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200',
};

function initials(name: string) {
  const compact = name.trim().replace(/\s+/g, ' ');
  if (!compact) return 'AI';
  const parts = compact.split(' ');
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return compact.slice(0, 2).toUpperCase();
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function projectLabel(group: AgentGroup) {
  if (group.projectName === 'general') return '通用';
  const segments = group.projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] || group.projectName;
}

function readError(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string') {
    return (payload as { error: string }).error;
  }
  return fallback;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json().catch(() => ({})) as T;
}

function AgentAvatar({ member, size = 'normal' }: { member: AgentGroupMember; size?: 'small' | 'normal' }) {
  return (
    <div
      title={`${member.name} · ${kindLabel[member.kind]}`}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-white dark:ring-neutral-950',
        size === 'small' ? 'h-7 w-7 text-[9px]' : 'h-9 w-9 text-[11px]',
        avatarTone[member.kind],
      )}
    >
      {member.id === 'main' ? <ShieldCheck className={size === 'small' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5'} /> : initials(member.name)}
    </div>
  );
}

export default function GroupChatView({
  groupId,
  isSidebarCollapsed,
  onOpenSidebar,
  onGroupsChanged,
  onArchived,
}: Props) {
  const [group, setGroup] = useState<AgentGroup | null>(null);
  const [messages, setMessages] = useState<AgentGroupMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastMessageSignatureRef = useRef('');

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [groupResponse, messagesResponse] = await Promise.all([
        api.group(groupId),
        api.groupMessages(groupId, 150),
      ]);
      const groupPayload = await json<{ group?: AgentGroup; error?: string }>(groupResponse);
      const messagesPayload = await json<{ messages?: AgentGroupMessage[]; error?: string }>(messagesResponse);
      if (!groupResponse.ok || !groupPayload.group) throw new Error(groupPayload.error || '加载群组失败');
      if (!messagesResponse.ok) throw new Error(messagesPayload.error || '加载群组消息失败');
      setGroup(groupPayload.group);
      setMessages(Array.isArray(messagesPayload.messages) ? messagesPayload.messages : []);
      setError('');
      if (document.visibilityState === 'visible') {
        void api.markGroupRead(groupId).then(() => onGroupsChanged()).catch(() => undefined);
      }
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [groupId, onGroupsChanged]);

  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const signature = messages.map((message) => `${message.id}:${message.status}:${message.updatedAt}`).join('|');
    if (signature === lastMessageSignatureRef.current) return;
    const firstLoad = !lastMessageSignatureRef.current;
    lastMessageSignatureRef.current = signature;
    requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      if (typeof timeline.scrollTo === 'function') {
        timeline.scrollTo({
          top: timeline.scrollHeight,
          behavior: firstLoad ? 'auto' : 'smooth',
        });
      } else {
        timeline.scrollTop = timeline.scrollHeight;
      }
    });
  }, [messages]);

  const memberMap = useMemo(
    () => new Map((group?.members || []).map((member) => [member.id, member])),
    [group?.members],
  );
  const roundInProgress = messages.some((message) => message.status === 'thinking' || message.status === 'queued');

  const mentionCandidates = useMemo(() => {
    if (!group) return [];
    const query = mentionQuery.toLowerCase();
    return group.members.filter((member) =>
      !query || member.id.toLowerCase().includes(query) || member.name.toLowerCase().includes(query),
    );
  }, [group, mentionQuery]);

  const updateMentionState = (next: string, cursor = next.length) => {
    const prefix = next.slice(0, cursor);
    const match = prefix.match(/(?:^|[^a-zA-Z0-9_@])@([^\s@]*)$/u);
    setMentionOpen(Boolean(match));
    setMentionQuery(match?.[1] || '');
  };

  const insertMention = (id: string) => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? input.length;
    const prefix = input.slice(0, cursor);
    const match = prefix.match(/(?:^|[^a-zA-Z0-9_@])@([^\s@]*)$/u);
    const start = match ? cursor - match[1].length - 1 : cursor;
    const token = id === 'all' ? '@所有人 ' : `@${id} `;
    const next = `${input.slice(0, start)}${token}${input.slice(cursor)}`;
    setInput(next);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const position = start + token.length;
      textarea?.focus();
      textarea?.setSelectionRange(position, position);
    });
  };

  const send = async () => {
    if (!group || !input.trim() || sending || roundInProgress) return;
    const content = input.trim();
    const mentionAll = /(?:^|[^a-zA-Z0-9_@])@(所有人|all)(?=\s|$|[,.!?;:，。！？；：、])/iu.test(content);
    const mentionedMemberIds = group.members
      .filter((member) => new RegExp(
        `(?:^|[^a-zA-Z0-9_@])@${member.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$|[,.!?;:，。！？；：、])`,
        'iu',
      ).test(content))
      .map((member) => member.id);
    setSending(true);
    setError('');
    try {
      const response = await api.sendGroupMessage(group.id, { content, mentionedMemberIds, mentionAll });
      const payload = await json<{ error?: string }>(response);
      if (!response.ok) throw new Error(readError(payload, '发送失败'));
      setInput('');
      setMentionOpen(false);
      await refresh(true);
      onGroupsChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  if (loading && !group) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-neutral-400" /></div>;
  }

  if (!group) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <UsersRound className="h-10 w-10 text-neutral-300" />
        <p className="text-sm text-neutral-600 dark:text-neutral-300">{error || '群组不存在或已经归档。'}</p>
        <button type="button" onClick={onArchived} className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-neutral-900">返回群组列表</button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-100 px-4 dark:border-neutral-900 sm:px-6">
        {isSidebarCollapsed ? (
          <button type="button" onClick={onOpenSidebar} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <Menu className="h-4 w-4" />
          </button>
        ) : null}
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
          <UsersRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold">{group.title}</h1>
            {group.muted ? <BellOff className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-label="消息免打扰" /> : null}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-neutral-500">
            <span>{projectLabel(group)}</span>
            <span>·</span>
            <span>{group.triggerMode === 'auto' ? '自动顺序轮询' : '仅 @ 触发'}</span>
          </div>
        </div>
        <div className="hidden items-center -space-x-1.5 sm:flex">
          {group.members.slice(0, 6).map((member) => <AgentAvatar key={member.id} member={member} size="small" />)}
          {group.members.length > 6 ? <span className="ml-2 text-xs text-neutral-500">+{group.members.length - 6}</span> : null}
        </div>
        <button type="button" onClick={() => setInviteOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">邀请</span>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100" aria-label="群组设置">
          <Settings2 className="h-4 w-4" />
        </button>
      </header>

      <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="flex items-center gap-2 font-medium"><MessageCircleMore className="h-4 w-4" />群组协作已开启</div>
            <p className="mt-1 text-blue-700/80 dark:text-blue-300/80">
              {group.triggerMode === 'auto'
                ? '未指定成员时全员按顺序回复、主智能体最后综合；@具体成员时只触发被提及成员，@所有人触发全体。'
                : '消息只有在 @成员 或 @所有人 时才调用智能体；未 @ 的消息仍会保存在时间线中。'}
            </p>
          </div>

          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-neutral-400">
              <UsersRound className="h-10 w-10 stroke-[1.4]" />
              <p className="text-sm">还没有群组消息</p>
              <p className="text-xs">先邀请成员，然后发起一次讨论。</p>
            </div>
          ) : null}

          {messages.map((message) => {
            if (message.senderType === 'system') {
              return (
                <div key={message.id} className="flex justify-center">
                  <div className="max-w-[80%] rounded-full bg-neutral-100 px-3 py-1.5 text-center text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{message.content}</div>
                </div>
              );
            }
            const isUser = message.senderType === 'user';
            const member = message.senderMemberId ? memberMap.get(message.senderMemberId) : undefined;
            return (
              <div key={message.id} className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
                {isUser ? (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"><UserRound className="h-4 w-4" /></div>
                ) : member ? <AgentAvatar member={member} /> : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800"><Bot className="h-4 w-4" /></div>
                )}
                <div className={cn('min-w-0 max-w-[82%]', isUser && 'text-right')}>
                  <div className={cn('mb-1 flex items-center gap-2 text-[11px] text-neutral-500', isUser && 'justify-end')}>
                    <span className="font-medium text-neutral-700 dark:text-neutral-300">{message.senderName}</span>
                    {!isUser && member ? <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">{kindLabel[member.kind]}</span> : null}
                    <span>{formatTime(message.createdAt)}</span>
                  </div>
                  <div className={cn(
                    'rounded-2xl px-4 py-3 text-left text-sm leading-6',
                    isUser
                      ? 'rounded-tr-md bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                      : 'rounded-tl-md border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900',
                    message.status === 'failed' && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30',
                  )}>
                    {message.status === 'thinking' ? (
                      <div className="flex items-center gap-2 text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /><span>{message.senderName} 正在输入…</span></div>
                    ) : message.status === 'failed' ? (
                      <div className="text-red-700 dark:text-red-300">回复失败：{message.error || '未知错误'}</div>
                    ) : isUser ? (
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    ) : (
                      <Markdown className="group-chat-markdown">{message.content}</Markdown>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-neutral-100 bg-white px-4 py-4 dark:border-neutral-900 dark:bg-neutral-950 sm:px-8">
        <div className="relative mx-auto max-w-3xl">
          {mentionOpen ? (
            <div className="absolute bottom-full left-0 z-40 mb-2 w-72 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention('all')} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950"><UsersRound className="h-3.5 w-3.5" /></div>
                <div><div className="text-sm font-medium">@所有人</div><div className="text-[11px] text-neutral-500">按群组顺序触发全部成员</div></div>
              </button>
              {mentionCandidates.map((member) => (
                <button key={member.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(member.id)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  <AgentAvatar member={member} size="small" />
                  <div className="min-w-0"><div className="truncate text-sm font-medium">{member.name}</div><div className="truncate text-[11px] text-neutral-500">@{member.id} · {kindLabel[member.kind]}</div></div>
                </button>
              ))}
            </div>
          ) : null}
          {error ? <div className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
          <div className="rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm focus-within:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                updateMentionState(event.target.value, event.target.selectionStart);
              }}
              onClick={(event) => updateMentionState(input, event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && mentionOpen) {
                  event.preventDefault();
                  setMentionOpen(false);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !mentionOpen) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={group.triggerMode === 'mentions' ? '输入消息，使用 @智能体 或 @所有人 触发回复…' : '向群组发送消息，所有成员将依次回复…'}
              className="max-h-40 min-h-[52px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-neutral-400"
            />
            <div className="flex items-center gap-2 px-1 pt-1">
              <button type="button" onClick={() => { setMentionOpen(true); setMentionQuery(''); textareaRef.current?.focus(); }} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
                <AtSign className="h-4 w-4" /> 提及成员
              </button>
              {roundInProgress ? <span className="text-xs text-amber-600 dark:text-amber-300">成员正在顺序回复，请等待本轮完成</span> : null}
              <button
                type="button"
                aria-label="发送群组消息"
                onClick={() => void send()}
                disabled={!input.trim() || sending || roundInProgress}
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white dark:text-neutral-900"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {settingsOpen ? (
        <GroupSettingsDrawer
          group={group}
          onClose={() => setSettingsOpen(false)}
          onInvite={() => setInviteOpen(true)}
          onChanged={async () => { await refresh(true); onGroupsChanged(); }}
          onArchived={onArchived}
        />
      ) : null}
      {inviteOpen ? (
        <InviteMembersDialog
          group={group}
          onClose={() => setInviteOpen(false)}
          onChanged={async () => { await refresh(true); onGroupsChanged(); }}
        />
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 rounded-full transition', checked ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-700')}>
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all', checked ? 'left-6' : 'left-1')} />
    </button>
  );
}

function GroupSettingsDrawer({
  group,
  onClose,
  onInvite,
  onChanged,
  onArchived,
}: {
  group: AgentGroup;
  onClose: () => void;
  onInvite: () => void;
  onChanged: () => Promise<void>;
  onArchived: () => void;
}) {
  const [title, setTitle] = useState(group.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const patchGroup = async (patch: Partial<{ title: string; triggerMode: GroupTriggerMode; muted: boolean }>) => {
    setSaving(true);
    setError('');
    try {
      const response = await api.updateGroup(group.id, patch);
      const payload = await json<{ error?: string }>(response);
      if (!response.ok) throw new Error(readError(payload, '保存群组设置失败'));
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const secondary = group.members.filter((member) => member.id !== 'main');
  const reorder = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= secondary.length) return;
    const ordered = [...secondary];
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setSaving(true);
    try {
      const response = await api.reorderGroupMembers(group.id, ordered.map((member) => member.id));
      const payload = await json<{ error?: string }>(response);
      if (!response.ok) throw new Error(readError(payload, '成员排序失败'));
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-modal-overlay className="absolute inset-0 z-50 flex justify-end bg-black/25" onMouseDown={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex h-16 items-center gap-3 border-b border-neutral-100 px-5 dark:border-neutral-800">
          <Settings2 className="h-5 w-5 text-neutral-500" />
          <h2 className="flex-1 font-semibold">群组设置</h2>
          <button type="button" aria-label="关闭群组设置" onClick={onClose} className="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">群组名称</span>
            <div className="flex gap-2">
              <input value={title} onChange={(event) => setTitle(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 text-sm outline-none focus:border-blue-400 dark:border-neutral-700" />
              <button type="button" disabled={saving || !title.trim() || title.trim() === group.title} onClick={() => void patchGroup({ title: title.trim() })} className="rounded-lg bg-neutral-900 px-3 text-xs text-white disabled:opacity-35 dark:bg-white dark:text-neutral-900">保存</button>
            </div>
          </label>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div><div className="text-sm font-medium">仅 @ 触发</div><div className="text-xs text-neutral-500">开启后，未提及成员的消息只保存。</div></div>
              <Toggle checked={group.triggerMode === 'mentions'} onChange={(checked) => void patchGroup({ triggerMode: checked ? 'mentions' : 'auto' })} label="仅 @ 触发" />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-2">{group.muted ? <BellOff className="mt-0.5 h-4 w-4 text-neutral-500" /> : <Bell className="mt-0.5 h-4 w-4 text-neutral-500" />}<div><div className="text-sm font-medium">消息免打扰</div><div className="text-xs text-neutral-500">静默通知和醒目未读提示，继续执行回复。</div></div></div>
              <Toggle checked={group.muted} onChange={(checked) => void patchGroup({ muted: checked })} label="消息免打扰" />
            </div>
          </div>

          <div className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/60">
            <div className="text-xs text-neutral-500">绑定工作空间</div>
            <div className="mt-1 truncate text-sm font-medium">{projectLabel(group)}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-neutral-400">{group.projectPath}</div>
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">成员与轮询顺序</h3><button type="button" onClick={onInvite} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950"><Plus className="h-3.5 w-3.5" />邀请</button></div>
            {secondary.map((member, index) => (
              <div key={member.id} className="flex items-center gap-2 rounded-xl border border-neutral-100 p-2.5 dark:border-neutral-800">
                <AgentAvatar member={member} size="small" />
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{index + 1}. {member.name}</div><div className="truncate text-[11px] text-neutral-500">{kindLabel[member.kind]} · @{member.id}</div></div>
                <button type="button" disabled={index === 0 || saving} onClick={() => void reorder(index, -1)} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-20 dark:hover:bg-neutral-800"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={index === secondary.length - 1 || saving} onClick={() => void reorder(index, 1)} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-20 dark:hover:bg-neutral-800"><ArrowDown className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {group.members.filter((member) => member.id === 'main').map((member) => (
              <div key={member.id} className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-2.5 dark:border-blue-900 dark:bg-blue-950/20">
                <AgentAvatar member={member} size="small" />
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">最后. {member.name}</div><div className="truncate text-[11px] text-neutral-500">固定在轮询末尾，负责综合总结</div></div>
              </div>
            ))}
          </section>

          {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}

          <button
            type="button"
            onClick={async () => {
              if (!window.confirm(`归档群组“${group.title}”？`)) return;
              const response = await api.archiveGroup(group.id);
              if (response.ok) onArchived();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            <Trash2 className="h-4 w-4" />归档群组
          </button>
        </div>
      </aside>
    </div>
  );
}

function InviteMembersDialog({ group, onClose, onChanged }: { group: AgentGroup; onClose: () => void; onChanged: () => Promise<void> }) {
  const [available, setAvailable] = useState<AvailableGroupMembers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingId, setAddingId] = useState('');
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remote, setRemote] = useState({ name: '', role: '', endpoint: '', tokenEnv: '' });

  useEffect(() => {
    void api.availableGroupMembers().then(async (response: Response) => {
      const payload = await json<AvailableGroupMembers & { error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || '加载可邀请成员失败');
      setAvailable(payload);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
  }, []);

  const add = async (candidate: AvailableGroupMember | { id?: string; kind: 'pilotdeck_remote'; name: string; role: string; endpoint: string; tokenEnv?: string }) => {
    const marker = candidate.id || candidate.name;
    setAddingId(marker);
    setError('');
    try {
      const response = await api.addGroupMember(group.id, {
        ...candidate,
        employeeId: 'employeeId' in candidate ? candidate.employeeId || candidate.id : undefined,
      });
      const payload = await json<{ error?: string }>(response);
      if (!response.ok) throw new Error(readError(payload, '邀请成员失败'));
      await onChanged();
      if (candidate.kind === 'pilotdeck_remote') setRemote({ name: '', role: '', endpoint: '', tokenEnv: '' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAddingId('');
    }
  };

  const remove = async (member: AgentGroupMember) => {
    setAddingId(member.id);
    try {
      const response = await api.removeGroupMember(group.id, member.id);
      if (!response.ok) {
        const payload = await json<{ error?: string }>(response);
        throw new Error(readError(payload, '移除成员失败'));
      }
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAddingId('');
    }
  };

  const invited = new Set(group.members.map((member) => member.id));
  const sections: Array<{ title: string; items: AvailableGroupMember[]; note?: string }> = available ? [
    { title: '本地 PilotDeck 智能体', items: available.local },
    { title: 'StaffDeck 数字员工', items: available.staffdeck, note: available.staffdeckConfigured ? (available.staffdeckError || undefined) : '尚未配置 StaffDeck，下面仍可使用 Mock 员工调试。' },
    { title: 'Mock 员工', items: available.mocks },
  ] : [];

  return (
    <div data-modal-overlay className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-100 px-5 dark:border-neutral-800"><Plus className="h-5 w-5 text-blue-600" /><div className="flex-1"><h2 className="font-semibold">邀请智能体或员工</h2><p className="text-xs text-neutral-500">成员会按设置中的顺序依次发言，主智能体始终最后总结。</p></div><button type="button" aria-label="关闭邀请成员" onClick={onClose} className="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-neutral-400" /></div> : null}
          {sections.map((section) => (
            <section key={section.title} className="space-y-2">
              <div><h3 className="text-sm font-semibold">{section.title}</h3>{section.note ? <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-300">{section.note}</p> : null}</div>
              {section.items.map((candidate) => {
                const isInvited = invited.has(candidate.id);
                const member = group.members.find((item) => item.id === candidate.id);
                return (
                  <div key={`${candidate.kind}:${candidate.id}`} className="flex items-center gap-3 rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
                    <div className={cn('flex h-9 w-9 items-center justify-center rounded-full text-[10px] font-semibold', avatarTone[candidate.kind])}>{initials(candidate.name)}</div>
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{candidate.name}</div><div className="truncate text-[11px] text-neutral-500">{candidate.role || kindLabel[candidate.kind]} · @{candidate.id}</div>{candidate.description ? <div className="mt-0.5 line-clamp-2 text-[11px] text-neutral-400">{candidate.description}</div> : null}</div>
                    {isInvited && member ? <button type="button" disabled={addingId === candidate.id} onClick={() => void remove(member)} className="rounded-lg px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950">移除</button> : <button type="button" disabled={Boolean(addingId)} onClick={() => void add(candidate)} className="rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900">邀请</button>}
                  </div>
                );
              })}
              {section.items.length === 0 ? <div className="rounded-xl bg-neutral-50 px-3 py-3 text-xs text-neutral-500 dark:bg-neutral-800/50">暂无可用成员</div> : null}
            </section>
          ))}

          <section className="space-y-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <button type="button" onClick={() => setRemoteOpen((open) => !open)} className="flex w-full items-center justify-between text-sm font-semibold"><span>远程 PilotDeck 实例</span><MoreHorizontal className="h-4 w-4 text-neutral-400" /></button>
            {remoteOpen ? (
              <div className="space-y-2 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/50">
                <input value={remote.name} onChange={(event) => setRemote({ ...remote, name: event.target.value })} placeholder="显示名称" className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900" />
                <input value={remote.role} onChange={(event) => setRemote({ ...remote, role: event.target.value })} placeholder="角色，例如：远程架构师" className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900" />
                <input value={remote.endpoint} onChange={(event) => setRemote({ ...remote, endpoint: event.target.value })} placeholder="http://127.0.0.1:8642" className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900" />
                <input value={remote.tokenEnv} onChange={(event) => setRemote({ ...remote, tokenEnv: event.target.value })} placeholder="可选：PILOTDECK_GROUP_REMOTE_TOKEN" className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900" />
                <button type="button" disabled={!remote.name.trim() || !remote.endpoint.trim() || Boolean(addingId)} onClick={() => void add({ kind: 'pilotdeck_remote', name: remote.name.trim(), role: remote.role.trim(), endpoint: remote.endpoint.trim(), tokenEnv: remote.tokenEnv.trim() || undefined })} className="h-9 w-full rounded-lg bg-neutral-900 text-sm text-white disabled:opacity-35 dark:bg-white dark:text-neutral-900">邀请远程实例</button>
              </div>
            ) : null}
          </section>

          {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
        <div className="flex justify-end border-t border-neutral-100 px-5 py-4 dark:border-neutral-800"><button type="button" onClick={onClose} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm text-white dark:bg-white dark:text-neutral-900">完成</button></div>
      </div>
    </div>
  );
}
