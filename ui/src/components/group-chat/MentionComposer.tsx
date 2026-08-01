import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AtSign, Loader2, Send, UsersRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AgentGroupMember, GroupMemberCategory } from '../../types/group';

export type MentionDraft = {
  content: string;
  mentionedMemberIds: string[];
  mentionAll: boolean;
};

export type MentionComposerHandle = {
  openMentionMenu: () => void;
};

type Props = {
  members: AgentGroupMember[];
  placeholder: string;
  disabled?: boolean;
  sending?: boolean;
  statusText?: string;
  onSubmit: (draft: MentionDraft) => boolean | Promise<boolean>;
};

type MentionCandidate = {
  id: string;
  name: string;
  category: GroupMemberCategory | 'all';
  member?: AgentGroupMember;
};

const categoryLabel: Record<GroupMemberCategory, string> = {
  pilotdeck_instance: 'PilotDeck 实例',
  agent: '智能体',
  employee: '数字员工',
};

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\u00a0/g, ' ');
  if (!(node instanceof HTMLElement)) return '';
  if (node.dataset.mentionId) return node.textContent || '';
  if (node.tagName === 'BR') return '\n';
  const content = Array.from(node.childNodes).map(serializeNode).join('');
  return ['DIV', 'P'].includes(node.tagName) ? `${content}\n` : content;
}

function editorText(editor: HTMLElement) {
  return Array.from(editor.childNodes).map(serializeNode).join('').replace(/\n+$/u, '').trim();
}

function createMentionChip(candidate: MentionCandidate) {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.mentionId = candidate.id;
  if (candidate.id === 'all') chip.dataset.mentionAll = 'true';
  chip.className = [
    'mx-0.5 inline-flex select-none items-center rounded-md px-1.5 py-0.5 align-baseline',
    'bg-blue-50 font-medium text-blue-700 ring-1 ring-inset ring-blue-200',
    'dark:bg-blue-950/70 dark:text-blue-200 dark:ring-blue-800',
  ].join(' ');
  chip.textContent = `@${candidate.name}`;
  return chip;
}

function adjacentMention(selection: Selection, direction: 'backward' | 'forward') {
  if (!selection.isCollapsed) return null;
  const node = selection.focusNode;
  const offset = selection.focusOffset;
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    if (direction === 'backward') {
      const previous = node.previousSibling;
      if (offset === 0 && previous instanceof HTMLElement && previous.dataset.mentionId) {
        return { chip: previous, spacer: null as Text | null };
      }
      if (offset === 1 && /^[\s\u00a0]$/u.test(text.slice(0, 1))
          && previous instanceof HTMLElement && previous.dataset.mentionId) {
        return { chip: previous, spacer: node as Text };
      }
    } else if (offset === text.length) {
      const next = node.nextSibling;
      if (next instanceof HTMLElement && next.dataset.mentionId) {
        return { chip: next, spacer: null as Text | null };
      }
    }
  }
  if (node instanceof HTMLElement) {
    const index = direction === 'backward' ? offset - 1 : offset;
    const sibling = node.childNodes[index];
    if (sibling instanceof HTMLElement && sibling.dataset.mentionId) {
      return { chip: sibling, spacer: null as Text | null };
    }
    if (sibling?.nodeType === Node.TEXT_NODE && /^[\s\u00a0]*$/u.test(sibling.textContent || '')) {
      const chip = direction === 'backward' ? sibling.previousSibling : sibling.nextSibling;
      if (chip instanceof HTMLElement && chip.dataset.mentionId) {
        return { chip, spacer: sibling as Text };
      }
    }
  }
  return null;
}

export const MentionComposer = forwardRef<MentionComposerHandle, Props>(function MentionComposer({
  members,
  placeholder,
  disabled = false,
  sending = false,
  statusText,
  onSubmit,
}, ref) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasContent, setHasContent] = useState(false);

  const candidates = useMemo<MentionCandidate[]>(() => {
    const normalized = query.toLocaleLowerCase();
    const all: MentionCandidate[] = [
      { id: 'all', name: '所有人', category: 'all' },
      ...members.map((member) => ({
        id: member.id,
        name: member.name,
        category: member.category,
        member,
      })),
    ];
    return all.filter((candidate) => !normalized
      || candidate.name.toLocaleLowerCase().includes(normalized)
      || candidate.id.toLocaleLowerCase().includes(normalized));
  }, [members, query]);

  const syncContent = () => setHasContent(Boolean(editorRef.current && editorText(editorRef.current)));

  const captureMentionQuery = () => {
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !editorRef.current?.contains(selection.focusNode)) {
      setMenuOpen(false);
      return;
    }
    const node = selection.focusNode;
    if (node?.nodeType !== Node.TEXT_NODE) {
      setMenuOpen(false);
      return;
    }
    const prefix = (node.textContent || '').slice(0, selection.focusOffset);
    const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
    if (!match) {
      setMenuOpen(false);
      return;
    }
    const range = document.createRange();
    range.setStart(node, selection.focusOffset - match[1].length - 1);
    range.setEnd(node, selection.focusOffset);
    mentionRangeRef.current = range;
    setQuery(match[1]);
    setSelectedIndex(0);
    setMenuOpen(true);
  };

  const openMentionMenu = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 && editor.contains(selection.focusNode)
      ? selection.getRangeAt(0).cloneRange()
      : document.createRange();
    if (!selection?.rangeCount || !editor.contains(selection.focusNode)) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    mentionRangeRef.current = range;
    setQuery('');
    setSelectedIndex(0);
    setMenuOpen(true);
  };

  useImperativeHandle(ref, () => ({ openMentionMenu }));

  const insertMention = (candidate: MentionCandidate) => {
    const editor = editorRef.current;
    const range = mentionRangeRef.current;
    if (!editor || !range) return;
    range.deleteContents();
    const chip = createMentionChip(candidate);
    const spacer = document.createTextNode('\u00a0');
    range.insertNode(spacer);
    range.insertNode(chip);
    const selection = window.getSelection();
    const caret = document.createRange();
    caret.setStartAfter(spacer);
    caret.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(caret);
    mentionRangeRef.current = null;
    setMenuOpen(false);
    setQuery('');
    syncContent();
    editor.focus();
  };

  const submit = async () => {
    const editor = editorRef.current;
    if (!editor || disabled || sending) return;
    const content = editorText(editor);
    if (!content) return;
    const chips = Array.from(editor.querySelectorAll<HTMLElement>('[data-mention-id]'));
    const mentionedMemberIds = [...new Set(chips
      .map((chip) => chip.dataset.mentionId || '')
      .filter((id) => id && id !== 'all'))];
    const mentionAll = chips.some((chip) => chip.dataset.mentionAll === 'true');
    const accepted = await onSubmit({ content, mentionedMemberIds, mentionAll });
    if (!accepted) return;
    editor.replaceChildren();
    setHasContent(false);
    setMenuOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (candidates.length > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setSelectedIndex((index) => (index + delta + candidates.length) % candidates.length);
        }
        return;
      }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && candidates[selectedIndex]) {
        event.preventDefault();
        insertMention(candidates[selectedIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && window.getSelection()) {
      const adjacent = adjacentMention(
        window.getSelection() as Selection,
        event.key === 'Backspace' ? 'backward' : 'forward',
      );
      if (adjacent) {
        event.preventDefault();
        adjacent.chip.remove();
        if (adjacent.spacer) adjacent.spacer.deleteData(0, 1);
        syncContent();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onInput = (_event: FormEvent<HTMLDivElement>) => {
    syncContent();
    captureMentionQuery();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  };

  return (
    <div className="relative">
      {menuOpen ? (
        <div role="listbox" aria-label="选择要提及的成员" className="absolute bottom-full left-0 z-40 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => insertMention(candidate)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left',
                index === selectedIndex ? 'bg-blue-50 dark:bg-blue-950/60' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
              )}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-200">
                {candidate.id === 'all' ? <UsersRound className="h-3.5 w-3.5" /> : <AtSign className="h-3.5 w-3.5" />}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">@{candidate.name}</div>
                <div className="truncate text-[11px] text-neutral-500">
                  {candidate.category === 'all' ? '按群组顺序触发全部成员' : categoryLabel[candidate.category]}
                </div>
              </div>
            </button>
          ))}
          {candidates.length === 0 ? <div className="px-3 py-4 text-center text-xs text-neutral-500">没有匹配的成员</div> : null}
        </div>
      ) : null}
      <div className="rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm focus-within:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="relative">
          {!hasContent ? <div className="pointer-events-none absolute inset-x-2 top-1.5 text-sm leading-6 text-neutral-400">{placeholder}</div> : null}
          <div
            ref={editorRef}
            role="textbox"
            aria-label="群组消息"
            aria-multiline="true"
            contentEditable={!disabled && !sending}
            suppressContentEditableWarning
            onInput={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={captureMentionQuery}
            className="max-h-40 min-h-[52px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-2 py-1.5 text-sm leading-6 outline-none"
          />
        </div>
        <div className="flex items-center gap-2 px-1 pt-1">
          <button type="button" onClick={openMentionMenu} disabled={disabled} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
            <AtSign className="h-4 w-4" /> 提及成员
          </button>
          {statusText ? <span className="text-xs text-amber-600 dark:text-amber-300">{statusText}</span> : null}
          <button
            type="button"
            aria-label="发送群组消息"
            onClick={() => void submit()}
            disabled={!hasContent || disabled || sending}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white dark:text-neutral-900"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
});
