import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  Folder,
  Loader2,
  MessageCircleMore,
  MoreHorizontal,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UsersRound,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type {
  AgentGroup,
  AgentGroupMember,
  AgentGroupMessage,
  AgentGroupParticipant,
  AvailableGroupMember,
  AvailableGroupMembers,
  GroupMemberKind,
  GroupTriggerMode,
} from '../../types/group';
import { api } from '../../utils/api';
import { useAuth } from '../auth/context/AuthContext';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { MentionComposer, type MentionDraft } from './MentionComposer';

type Props = {
  groupId: string;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  onGroupsChanged: () => void;
  onArchived: () => void;
  onRequestDelete?: (group: AgentGroup) => void;
  onOpenFiles?: () => void;
};

const POLL_MS = 1_200;

const kindLabel: Record<GroupMemberKind, string> = {
  pilotdeck_main: 'PilotDeck 实例 · 主智能体',
  pilotdeck_local: '智能体',
  pilotdeck_remote: 'PilotDeck 实例',
  staffdeck: '数字员工',
  staffdeck_mock: 'Mock 数字员工',
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

function metadataString(message: AgentGroupMessage, key: string) {
  const value = message.metadata?.[key];
  return typeof value === 'string' ? value : '';
}

function ActivityMessage({ message }: { message: AgentGroupMessage }) {
  const [expanded, setExpanded] = useState(false);
  const activityType = metadataString(message, 'activityType');
  const toolName = metadataString(message, 'toolName');
  const running = message.status === 'thinking' || message.status === 'queued';
  const failed = message.status === 'failed';
  const label = activityType === 'tool'
    ? `${running ? '正在调用' : failed ? '调用失败' : '已调用'} ${toolName || '工具'}`
    : running ? '正在思考' : failed ? '思考中断' : '已完成思考';
  const Icon = activityType === 'tool' ? Wrench : Brain;

  return (
    <div className="ml-12 max-w-[82%] rounded-xl border border-neutral-200/80 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-900/70">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-neutral-600 dark:text-neutral-300"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" /> : failed ? <AlertCircle className="h-3.5 w-3.5 text-red-500" /> : <Icon className="h-3.5 w-3.5 text-neutral-500" />}
        <span className="flex-1 font-medium">{message.senderName} · {label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded ? (
        <div className={cn(
          'border-t border-neutral-200/70 px-3 py-2 text-xs leading-5 dark:border-neutral-800',
          failed ? 'text-red-600 dark:text-red-300' : 'whitespace-pre-wrap break-words text-neutral-600 dark:text-neutral-300',
        )}>
          {failed ? message.error || message.content || '执行失败' : message.content || '暂无详细信息'}
        </div>
      ) : null}
    </div>
  );
}

function DelegationMessage({ message, memberMap }: { message: AgentGroupMessage; memberMap: Map<string, AgentGroupMember> }) {
  const targetId = metadataString(message, 'targetMemberId');
  const targetName = metadataString(message, 'targetMemberName') || memberMap.get(targetId)?.name || targetId;
  const waiting = message.status === 'thinking' || message.status === 'queued';
  const failed = message.status === 'failed';
  const source = message.senderMemberId ? memberMap.get(message.senderMemberId) : undefined;
  return (
    <div className="flex gap-3">
      {source ? <AgentAvatar member={source} /> : <div className="h-9 w-9" />}
      <div className="min-w-0 max-w-[82%] flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">{message.senderName}</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <div className={cn(
          'rounded-2xl rounded-tl-md border px-4 py-3 text-sm shadow-sm',
          failed
            ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
            : 'border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/25',
        )}>
          <div className="flex items-center gap-2">
            {waiting ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> : failed ? <AlertCircle className="h-4 w-4 text-red-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
            <span className="font-medium">{waiting ? '正在询问' : failed ? '询问失败' : '已询问'}</span>
            <ArrowRight className="h-3.5 w-3.5 text-neutral-400" />
            <span className="rounded-md bg-white/80 px-2 py-0.5 font-medium text-blue-700 dark:bg-blue-950/70 dark:text-blue-200">@{targetName}</span>
          </div>
          {message.content ? <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-neutral-600 dark:text-neutral-300">{message.content}</div> : null}
          {failed && message.error ? <div className="mt-2 text-xs text-red-600 dark:text-red-300">{message.error}</div> : null}
        </div>
      </div>
    </div>
  );
}

export default function GroupChatView({
  groupId,
  isSidebarCollapsed,
  onOpenSidebar,
  onGroupsChanged,
  onArchived,
  onRequestDelete,
  onOpenFiles,
}: Props) {
  const [group, setGroup] = useState<AgentGroup | null>(null);
  const [messages, setMessages] = useState<AgentGroupMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastMessageSignatureRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

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
  const canManageMembers = group?.participantRole === 'owner' || group?.participantRole === 'moderator';
  const roundInProgress = messages.some((message) => message.status === 'thinking' || message.status === 'queued');
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
  const searchMatches = useMemo(
    () => normalizedSearchQuery
      ? messages.filter((message) => `${message.senderName}\n${message.content}`.toLocaleLowerCase('zh-CN').includes(normalizedSearchQuery))
      : [],
    [messages, normalizedSearchQuery],
  );
  const activeSearchMessageId = searchMatches[activeSearchIndex]?.id;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const revealSearchMatch = (index: number) => {
    if (searchMatches.length === 0) return;
    const nextIndex = (index + searchMatches.length) % searchMatches.length;
    setActiveSearchIndex(nextIndex);
    document.getElementById(`group-message-${searchMatches[nextIndex].id}`)?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'center',
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
  };

  const send = async (draft: MentionDraft) => {
    if (!group || sending || roundInProgress) return false;
    setSending(true);
    setError('');
    try {
      const response = await api.sendGroupMessage(group.id, draft);
      const payload = await json<{ error?: string }>(response);
      if (!response.ok) throw new Error(readError(payload, '发送失败'));
      await refresh(true);
      onGroupsChanged();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
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
      <header className="relative z-[80] flex h-14 shrink-0 items-center gap-3 overflow-visible border-b border-neutral-100 bg-white px-4 dark:border-neutral-900 dark:bg-neutral-950 sm:px-6">
        {isSidebarCollapsed ? (
          <button type="button" onClick={onOpenSidebar} aria-label="显示侧边栏" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold">{group.title}</h1>
            {group.muted ? <BellOff className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-label="消息免打扰" /> : null}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-neutral-500">
            <span>{projectLabel(group)}</span>
            <span>·</span>
            <span>{group.triggerMode === 'auto' ? '智能协调' : '仅 @ 触发'}</span>
          </div>
        </div>
        <div className="hidden items-center -space-x-1.5 sm:flex">
          {group.members.slice(0, 6).map((member) => <AgentAvatar key={member.id} member={member} size="small" />)}
          {group.members.length > 6 ? <span className="ml-2 text-xs text-neutral-500">+{group.members.length - 6}</span> : null}
        </div>
        {canManageMembers ? (
          <button type="button" onClick={() => setInviteOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">邀请</span>
          </button>
        ) : null}
        <div className="hidden h-5 w-px bg-neutral-200 dark:bg-neutral-800 sm:block" aria-hidden="true" />
        {searchOpen ? (
          <div role="search" aria-label="搜索群组消息" className="flex h-8 w-[min(310px,34vw)] min-w-[220px] items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 text-neutral-500 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
            <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                const value = event.target.value;
                setSearchQuery(value);
                const normalizedValue = value.trim().toLocaleLowerCase('zh-CN');
                const firstMatch = normalizedValue
                  ? messages.find((message) => `${message.senderName}\n${message.content}`.toLocaleLowerCase('zh-CN').includes(normalizedValue))
                  : undefined;
                if (firstMatch) {
                  requestAnimationFrame(() => {
                    document.getElementById(`group-message-${firstMatch.id}`)?.scrollIntoView?.({
                      behavior: 'smooth',
                      block: 'center',
                    });
                  });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeSearch();
                if (event.key === 'Enter') revealSearchMatch(activeSearchIndex + (event.shiftKey ? -1 : 1));
              }}
              placeholder="搜索群组消息"
              aria-label="搜索群组消息"
              className="min-w-0 flex-1 bg-transparent text-xs text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            />
            <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">
              {searchMatches.length ? `${activeSearchIndex + 1}/${searchMatches.length}` : '0/0'}
            </span>
            <button type="button" onClick={() => revealSearchMatch(activeSearchIndex - 1)} disabled={!searchMatches.length} aria-label="上一个结果" className="rounded p-0.5 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"><ArrowUp className="h-3 w-3" /></button>
            <button type="button" onClick={() => revealSearchMatch(activeSearchIndex + 1)} disabled={!searchMatches.length} aria-label="下一个结果" className="rounded p-0.5 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"><ArrowDown className="h-3 w-3" /></button>
            <button type="button" onClick={closeSearch} aria-label="关闭搜索" className="rounded p-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-3 w-3" /></button>
          </div>
        ) : null}
        <div className="flex h-9 shrink-0 items-center gap-1" aria-label="群组工具">
          <button
            type="button"
            aria-label="搜索当前群组"
            aria-pressed={searchOpen}
            onClick={() => {
              setMenuOpen(false);
              if (searchOpen) closeSearch(); else setSearchOpen(true);
            }}
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              searchOpen
                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-950/70 dark:text-blue-200'
                : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
            )}
          >
            <Search className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              closeSearch();
              onOpenFiles?.();
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <Folder className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>文件</span>
          </button>
          <div ref={menuRef} className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="更多群组操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.9} />
            </button>
            {menuOpen ? (
              <div role="menu" aria-label="群组操作" className="absolute right-0 top-10 z-[90] w-36 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl shadow-black/10 dark:border-neutral-700 dark:bg-neutral-900">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-neutral-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 focus:outline-none dark:text-neutral-300 dark:hover:bg-blue-950/60 dark:hover:text-blue-200"
                >
                  <Settings2 className="h-4 w-4 text-neutral-400" strokeWidth={1.75} />
                  <span>群组设置</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="flex items-center gap-2 font-medium"><MessageCircleMore className="h-4 w-4" />群组协作已开启</div>
            <p className="mt-1 text-blue-700/80 dark:text-blue-300/80">
              {group.triggerMode === 'auto'
                ? '消息先交给你的通用 PilotDeck 智能体；它会自主回答或真实邀请合适成员协作，显式 @ 的成员必须被邀请。'
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
            let messageContent;
            if (message.kind === 'activity') {
              messageContent = <ActivityMessage message={message} />;
            } else if (message.kind === 'delegation') {
              messageContent = <DelegationMessage message={message} memberMap={memberMap} />;
            } else if (message.senderType === 'system') {
              messageContent = (
                <div className="flex justify-center">
                  <div className="max-w-[80%] rounded-full bg-neutral-100 px-3 py-1.5 text-center text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{message.content}</div>
                </div>
              );
            } else {
              const isUser = message.senderType === 'user';
              const member = message.senderMemberId ? memberMap.get(message.senderMemberId) : undefined;
              messageContent = (
                <div className={cn('flex gap-3', isUser && 'justify-end')}>
                  {!isUser && (member ? <AgentAvatar member={member} /> : (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800"><Bot className="h-4 w-4" /></div>
                  ))}
                  <div className={cn('min-w-0', isUser ? 'max-w-[78%]' : 'max-w-[calc(100%-3rem)] flex-1')}>
                    <div className={cn('mb-1 flex items-center gap-2 text-[11px] text-neutral-500', isUser && 'justify-end')}>
                      <span className="font-medium text-neutral-700 dark:text-neutral-300">{message.senderName}</span>
                      {!isUser && member ? <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">{kindLabel[member.kind]}</span> : null}
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    <div className={cn(
                      'text-left text-sm leading-6',
                      isUser && 'rounded-[22px] bg-neutral-100 px-4 py-2.5 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100',
                      !isUser && 'py-1 text-neutral-800 dark:text-neutral-100',
                      message.status === 'failed' && 'rounded-xl bg-red-50 px-4 py-3 text-red-700 dark:bg-red-950/30 dark:text-red-300',
                    )}>
                      {message.status === 'thinking' ? (
                        <div className="flex items-center gap-2 text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /><span>{message.senderName} 正在输入…</span></div>
                      ) : message.status === 'failed' ? (
                        <div>回复失败：{message.error || '未知错误'}</div>
                      ) : isUser ? (
                        <div className="whitespace-pre-wrap break-words">{message.content}</div>
                      ) : (
                        <Markdown className="group-chat-markdown">{message.content}</Markdown>
                      )}
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={message.id}
                id={`group-message-${message.id}`}
                className={cn(
                  'scroll-mt-20 rounded-xl transition-colors',
                  activeSearchMessageId === message.id && 'bg-amber-50/80 ring-4 ring-amber-50/80 dark:bg-amber-950/20 dark:ring-amber-950/20',
                )}
              >
                {messageContent}
              </div>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 bg-white px-4 pb-5 pt-3 dark:bg-neutral-950 sm:px-8">
        <div className="relative mx-auto max-w-3xl">
          {error ? <div className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
          <MentionComposer
            members={group.members}
            placeholder={group.triggerMode === 'mentions' ? '输入消息，使用 @成员 或 @所有人 触发回复…' : '向群组发送消息，由你的通用智能体理解并协调…'}
            disabled={roundInProgress}
            sending={sending}
            statusText={roundInProgress ? '智能体正在处理并协调本轮消息' : undefined}
            onSubmit={send}
          />
        </div>
      </div>

      {settingsOpen ? (
        <GroupSettingsDrawer
          group={group}
          onClose={() => setSettingsOpen(false)}
          onInvite={() => setInviteOpen(true)}
          onChanged={async () => { await refresh(true); onGroupsChanged(); }}
          onArchived={onArchived}
          onRequestDelete={onRequestDelete}
        />
      ) : null}
      {inviteOpen && canManageMembers ? (
        <InviteMembersDialog
          group={group}
          onClose={() => setInviteOpen(false)}
          onChanged={async () => { await refresh(true); onGroupsChanged(); }}
        />
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 rounded-full transition disabled:cursor-not-allowed disabled:opacity-45', checked ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-700')}>
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
  onRequestDelete,
}: {
  group: AgentGroup;
  onClose: () => void;
  onInvite: () => void;
  onChanged: () => Promise<void>;
  onArchived: () => void;
  onRequestDelete?: (group: AgentGroup) => void;
}) {
  const { user } = useAuth();
  const [title, setTitle] = useState(group.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState<AgentGroupParticipant[]>([]);
  const [participantCandidates, setParticipantCandidates] = useState<Array<{ userId: number; displayName: string; projectRole: string; defaultInstance: { id: string; name: string; kind: string } | null }>>([]);
  const [myInstances, setMyInstances] = useState<Array<{ id: string; name: string; status: string; isDefault: boolean }>>([]);
  const [inviteUserId, setInviteUserId] = useState('');
  const isOwner = group.participantRole === 'owner';
  const canManageMembers = isOwner || group.participantRole === 'moderator';

  const refreshParticipants = useCallback(async () => {
    const [participantsResponse, instancesResponse] = await Promise.all([
      api.groupParticipants(group.id),
      api.instances.list(),
    ]);
    const participantsPayload = await json<{ participants?: AgentGroupParticipant[]; error?: string }>(participantsResponse);
    const instancesPayload = await json<{ instances?: Array<{ id: string; name: string; status: string; isDefault: boolean }>; error?: string }>(instancesResponse);
    if (!participantsResponse.ok) throw new Error(readError(participantsPayload, '加载群组参与者失败'));
    if (!instancesResponse.ok) throw new Error(readError(instancesPayload, '加载实例失败'));
    setParticipants(participantsPayload.participants || []);
    setMyInstances((instancesPayload.instances || []).filter((instance) => instance.status === 'approved'));
    if (group.participantRole === 'owner' || group.participantRole === 'moderator') {
      const candidatesResponse = await api.groupParticipantCandidates(group.id);
      const candidatesPayload = await json<{ candidates?: typeof participantCandidates; error?: string }>(candidatesResponse);
      if (!candidatesResponse.ok) throw new Error(readError(candidatesPayload, '加载可邀请用户失败'));
      setParticipantCandidates(candidatesPayload.candidates || []);
    }
  }, [group.id, group.participantRole]);

  useEffect(() => {
    void refreshParticipants().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refreshParticipants]);

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
              <input value={title} disabled={!isOwner} onChange={(event) => setTitle(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 text-sm outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700" />
              {isOwner ? <button type="button" disabled={saving || !title.trim() || title.trim() === group.title} onClick={() => void patchGroup({ title: title.trim() })} className="rounded-lg bg-neutral-900 px-3 text-xs text-white disabled:opacity-35 dark:bg-white dark:text-neutral-900">保存</button> : null}
            </div>
          </label>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div><div className="text-sm font-medium">仅 @ 触发</div><div className="text-xs text-neutral-500">开启后，未提及成员的消息只保存。</div></div>
              <Toggle checked={group.triggerMode === 'mentions'} disabled={!isOwner} onChange={(checked) => void patchGroup({ triggerMode: checked ? 'mentions' : 'auto' })} label="仅 @ 触发" />
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

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">人类参与者与入口实例</h3>
            {participants.map((participant) => (
              <div key={participant.userId} className="rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0"><div className="truncate text-sm font-medium">{participant.displayName}{participant.userId === user?.id ? '（你）' : ''}</div><div className="truncate text-[11px] text-neutral-500">{participant.role} · {participant.boundInstanceId || '未绑定实例'}</div></div>
                  {(group.participantRole === 'owner' || group.participantRole === 'moderator') && participant.role !== 'owner' ? (
                    <div className="flex gap-1">
                      <button type="button" className="rounded-md px-2 py-1 text-[11px] hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={async () => { const response = await api.updateGroupParticipant(group.id, participant.userId, { role: participant.role === 'moderator' ? 'member' : 'moderator' }); if (!response.ok) { const payload = await json<{ error?: string }>(response); throw new Error(readError(payload, '修改角色失败')); } await refreshParticipants(); }}>{participant.role === 'moderator' ? '设为成员' : '设为管理员'}</button>
                      <button type="button" className="rounded-md px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 dark:text-red-300" onClick={async () => { await api.removeGroupParticipant(group.id, participant.userId); await refreshParticipants(); }}>移除</button>
                    </div>
                  ) : null}
                </div>
                {participant.userId === user?.id && myInstances.length > 1 ? (
                  <select className="mt-2 h-8 w-full rounded-lg border border-neutral-200 bg-transparent px-2 text-xs dark:border-neutral-700" value={participant.boundInstanceId || ''} onChange={async (event) => { const response = await api.updateMyGroupParticipation(group.id, { instanceId: event.target.value }); if (!response.ok) { const payload = await json<{ error?: string }>(response); setError(readError(payload, '切换实例失败')); return; } await refreshParticipants(); await onChanged(); }}>
                    {myInstances.map((instance) => <option key={instance.id} value={instance.id}>{instance.name}{instance.isDefault ? '（默认）' : ''}</option>)}
                  </select>
                ) : null}
              </div>
            ))}
            {canManageMembers && participantCandidates.length > 0 ? (
              <div className="flex gap-2">
                <select className="h-9 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-2 text-xs dark:border-neutral-700" value={inviteUserId} onChange={(event) => setInviteUserId(event.target.value)}>
                  <option value="">选择项目成员</option>
                  {participantCandidates.map((candidate) => <option key={candidate.userId} value={candidate.userId} disabled={!candidate.defaultInstance}>{candidate.displayName} · {candidate.projectRole}{candidate.defaultInstance ? ` · ${candidate.defaultInstance.name}` : ' · 无可用实例'}</option>)}
                </select>
                <button type="button" disabled={!inviteUserId || saving} className="rounded-lg bg-neutral-900 px-3 text-xs text-white disabled:opacity-35 dark:bg-white dark:text-neutral-900" onClick={async () => { setSaving(true); try { const response = await api.addGroupParticipant(group.id, { userId: Number(inviteUserId), role: 'member' }); const payload = await json<{ error?: string }>(response); if (!response.ok) throw new Error(readError(payload, '邀请用户失败')); setInviteUserId(''); await refreshParticipants(); await onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setSaving(false); } }}>加入群组</button>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">成员顺序</h3>{canManageMembers ? <button type="button" onClick={onInvite} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950"><Plus className="h-3.5 w-3.5" />邀请</button> : null}</div>
            {secondary.map((member, index) => (
              <div key={member.id} className="flex items-center gap-2 rounded-xl border border-neutral-100 p-2.5 dark:border-neutral-800">
                <AgentAvatar member={member} size="small" />
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{index + 1}. {member.name}</div><div className="truncate text-[11px] text-neutral-500">{kindLabel[member.kind]} · @{member.name}</div></div>
                {canManageMembers ? <button type="button" disabled={index === 0 || saving} onClick={() => void reorder(index, -1)} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-20 dark:hover:bg-neutral-800"><ArrowUp className="h-3.5 w-3.5" /></button> : null}
                {canManageMembers ? <button type="button" disabled={index === secondary.length - 1 || saving} onClick={() => void reorder(index, 1)} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 disabled:opacity-20 dark:hover:bg-neutral-800"><ArrowDown className="h-3.5 w-3.5" /></button> : null}
              </div>
            ))}
            {group.members.filter((member) => member.id === 'main').map((member) => (
              <div key={member.id} className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/50 p-2.5 dark:border-blue-900 dark:bg-blue-950/20">
                <AgentAvatar member={member} size="small" />
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">入口. {member.name}</div><div className="truncate text-[11px] text-neutral-500">智能协调模式下优先理解需求并决定是否邀请成员</div></div>
              </div>
            ))}
          </section>

          {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}

          {isOwner ? <button
            type="button"
            onClick={async () => {
              if (onRequestDelete) {
                onRequestDelete(group);
                onClose();
                return;
              }
              if (!window.confirm(`归档群组“${group.title}”？`)) return;
              const response = await api.archiveGroup(group.id);
              if (response.ok) onArchived();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            <Trash2 className="h-4 w-4" />归档群组
          </button> : null}
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

  useEffect(() => {
    void api.availableGroupMembers().then(async (response: Response) => {
      const payload = await json<AvailableGroupMembers & { error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || '加载可邀请成员失败');
      setAvailable(payload);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
  }, []);

  const add = async (candidate: AvailableGroupMember) => {
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
    { title: 'Mock 数字员工', items: available.mocks },
  ] : [];

  return (
    <div data-modal-overlay className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-100 px-5 dark:border-neutral-800"><Plus className="h-5 w-5 text-blue-600" /><div className="flex-1"><h2 className="font-semibold">邀请群组成员</h2><p className="text-xs text-neutral-500">成员可以是 PilotDeck 实例、智能体或数字员工。</p></div><button type="button" aria-label="关闭邀请成员" onClick={onClose} className="rounded-lg p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button></div>
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
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{candidate.name}</div><div className="truncate text-[11px] text-neutral-500">{candidate.role || kindLabel[candidate.kind]} · @{candidate.name}</div>{candidate.description ? <div className="mt-0.5 line-clamp-2 text-[11px] text-neutral-400">{candidate.description}</div> : null}</div>
                    {isInvited && member ? <button type="button" disabled={addingId === candidate.id} onClick={() => void remove(member)} className="rounded-lg px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950">移除</button> : <button type="button" disabled={Boolean(addingId)} onClick={() => void add(candidate)} className="rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900">邀请</button>}
                  </div>
                );
              })}
              {section.items.length === 0 ? <div className="rounded-xl bg-neutral-50 px-3 py-3 text-xs text-neutral-500 dark:bg-neutral-800/50">暂无可用成员</div> : null}
            </section>
          ))}

          <section className="rounded-xl border border-neutral-100 bg-neutral-50 p-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/50">
            远程 PilotDeck 需先在“设置 → 账号与成员”登记，并由管理员测试批准；它会作为对应人类参与者的绑定入口加入群组，不再接受群聊内直接填写任意地址。
          </section>

          {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
        <div className="flex justify-end border-t border-neutral-100 px-5 py-4 dark:border-neutral-800"><button type="button" onClick={onClose} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm text-white dark:bg-white dark:text-neutral-900">完成</button></div>
      </div>
    </div>
  );
}
