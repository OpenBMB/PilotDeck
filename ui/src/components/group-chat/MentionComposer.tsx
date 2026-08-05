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
import { AtSign, Loader2, Paperclip, Send, UsersRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import type {
  AgentGroupFileAttachment,
  AgentGroupImageAttachment,
  AgentGroupMember,
  GroupMemberCategory,
} from '../../types/group';
import { api } from '../../utils/api';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';

export type MentionDraft = {
  content: string;
  mentionedMemberIds: string[];
  mentionAll: boolean;
  images?: AgentGroupImageAttachment[];
  attachments?: AgentGroupFileAttachment[];
};

export type MentionComposerHandle = {
  openMentionMenu: () => void;
};

type Props = {
  members: AgentGroupMember[];
  projectName: string;
  placeholder: string;
  disabled?: boolean;
  sending?: boolean;
  statusText?: string;
  onSubmit: (draft: MentionDraft) => boolean | Promise<boolean>;
};

type UploadedAttachments = {
  images?: AgentGroupImageAttachment[];
  files?: AgentGroupFileAttachment[];
  error?: string;
};

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

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
  projectName,
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
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const attachedFilesRef = useRef<File[]>([]);
  const submittingRef = useRef(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const accepted = incoming.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    const oversized = incoming.length - accepted.length;
    const current = attachedFilesRef.current;
    const next = [...current, ...accepted].slice(0, MAX_ATTACHMENTS);
    const dropped = Math.max(0, current.length + accepted.length - MAX_ATTACHMENTS);
    attachedFilesRef.current = next;
    setAttachedFiles(next);
    if (oversized > 0) setAttachmentError(`有 ${oversized} 个附件超过 20 MB，未添加。`);
    else if (dropped > 0) setAttachmentError(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
    else setAttachmentError('');
  };

  const submit = async () => {
    const editor = editorRef.current;
    if (!editor || disabled || sending || uploading || submittingRef.current) return;
    const rawContent = editorText(editor);
    const filesToUpload = attachedFilesRef.current;
    if (!rawContent && filesToUpload.length === 0) return;
    submittingRef.current = true;
    const chips = Array.from(editor.querySelectorAll<HTMLElement>('[data-mention-id]'));
    const mentionedMemberIds = [...new Set(chips
      .map((chip) => chip.dataset.mentionId || '')
      .filter((id) => id && id !== 'all'))];
    const mentionAll = chips.some((chip) => chip.dataset.mentionAll === 'true');
    let uploaded: UploadedAttachments = {};
    if (filesToUpload.length > 0) {
      setUploading(true);
      setAttachmentError('');
      try {
        const response = await api.uploadProjectAttachments(projectName, filesToUpload);
        uploaded = await response.json().catch(() => ({})) as UploadedAttachments;
        if (!response.ok) throw new Error(uploaded.error || '附件上传失败');
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : '附件上传失败');
        setUploading(false);
        submittingRef.current = false;
        return;
      }
    }
    const content = rawContent || '请查看附件。';
    const accepted = await onSubmit({
      content,
      mentionedMemberIds,
      mentionAll,
      ...(uploaded.images?.length ? { images: uploaded.images } : {}),
      ...(uploaded.files?.length ? { attachments: uploaded.files } : {}),
    });
    setUploading(false);
    submittingRef.current = false;
    if (!accepted) return;
    editor.replaceChildren();
    setHasContent(false);
    attachedFilesRef.current = [];
    setAttachedFiles([]);
    setAttachmentError('');
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
    const directFiles = Array.from(event.clipboardData.files || []);
    const itemFiles = Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === 'file')
      .flatMap((item) => item.getAsFile() || []);
    const files = directFiles.length > 0 ? directFiles : itemFiles;
    const text = event.clipboardData.getData('text/plain');
    if (files.length > 0) addFiles(files);
    event.preventDefault();
    if (text) document.execCommand('insertText', false, text);
    syncContent();
  };

  const canSubmit = hasContent || attachedFiles.length > 0;

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
      {attachedFiles.length > 0 ? (
        <div className="pd-composer-attachment-panel mb-2 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, index) => (
              <ImageAttachment
                key={`${file.name}-${file.size}-${index}`}
                file={file}
                onRemove={() => {
                  const next = attachedFilesRef.current.filter((_, candidateIndex) => candidateIndex !== index);
                  attachedFilesRef.current = next;
                  setAttachedFiles(next);
                }}
                uploadProgress={uploading ? 55 : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
      {attachmentError ? (
        <div role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {attachmentError}
        </div>
      ) : null}
      <div
        className="group rounded-xl border border-neutral-200 bg-white p-2 shadow-sm transition-colors focus-within:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files || []);
          if (files.length === 0) return;
          event.preventDefault();
          addFiles(files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="添加附件"
          onChange={(event) => {
            addFiles(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
        <div className="relative">
          {!hasContent ? <div className="pointer-events-none absolute inset-x-2 top-1.5 text-sm leading-6 text-neutral-400">{placeholder}</div> : null}
          <div
            ref={editorRef}
            role="textbox"
            aria-label="群组消息"
            aria-multiline="true"
            contentEditable={!disabled && !sending && !uploading}
            suppressContentEditableWarning
            onInput={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={captureMentionQuery}
            className="max-h-[40vh] min-h-[48px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 outline-none dark:text-neutral-100"
          />
        </div>
        <div className="pd-composer-control-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <button type="button" onClick={openMentionMenu} disabled={disabled || uploading} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800">
              <AtSign className="h-4 w-4" /> 提及成员
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading || attachedFiles.length >= MAX_ATTACHMENTS}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              aria-label="上传附件"
              title="上传附件"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            {uploading ? (
              <span className="ml-1 truncate text-xs text-blue-600 dark:text-blue-300">正在上传 {attachedFiles.length} 个附件…</span>
            ) : attachedFiles.length > 0 ? (
              <span className="ml-1 truncate text-xs text-neutral-500">已添加 {attachedFiles.length} 个附件，发送时一并上传</span>
            ) : statusText ? (
              <span className="ml-1 truncate text-xs text-amber-600 dark:text-amber-300">{statusText}</span>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="发送群组消息"
            onClick={() => void submit()}
            disabled={!canSubmit || disabled || sending || uploading}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-35 dark:bg-white dark:text-neutral-900"
          >
            {sending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
});
