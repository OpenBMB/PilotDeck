import { useTranslation } from 'react-i18next';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleGauge,
  Hand,
  ListChecks,
  Loader2,
  Paperclip,
  ShieldAlert,
  Slash,
  Square,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ChatRunMode, PendingPermissionRequest, PermissionMode, QueuedChatInput } from '../chat/types/types';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import CommandMenu from '../chat/view/subcomponents/CommandMenu';
import { cn } from '../../lib/utils.js';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComposerV2Props = {
  input: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAbortSession: () => void;
  openImagePicker: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  onHighlightFile: (index: number) => void;

  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
  onInsertMention: () => void;
  onInsertSlash: () => void;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  isDragActive: boolean;

  isLoading: boolean;
  canAbortSession: boolean;
  isAbortPending?: boolean;
  isSubmitPending?: boolean;
  queuedInputs: QueuedChatInput[];
  onUpdateQueuedInput: (id: string, content: string) => void;
  onRemoveQueuedInput: (id: string) => void;
  onMoveQueuedInputUp: (id: string) => void;
  onMoveQueuedInputDown: (id: string) => void;
  tokenBudget?: Record<string, unknown> | null;

  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
    },
  ) => void;
  handleGrantToolPermission: (suggestion: {
    entry: string;
    toolName: string;
  }) => { success: boolean };
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  runMode: ChatRunMode;
  onRunModeChange: (mode: ChatRunMode) => void;
  planModeAvailable?: boolean;
  onPlanExecutionApproved?: () => void;

  sendByCtrlEnter?: boolean;

  chromeless?: boolean;
};

type ContextStatus = {
  known: boolean;
  used: number;
  total: number;
  percent: number;
  usedLabel: string;
  totalLabel: string;
  tone: 'normal' | 'amber' | 'red' | 'unknown';
};

type PermissionModeOption = {
  mode: PermissionMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
};

const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: 'default',
    Icon: Hand,
    labelKey: 'input.permissions.default',
    defaultLabel: 'Default Permissions',
    descriptionKey: 'input.permissions.defaultDescription',
    defaultDescription: 'Ask before risky operations',
  },
  {
    mode: 'bypassPermissions',
    Icon: ShieldAlert,
    labelKey: 'input.permissions.bypassPermissions',
    defaultLabel: 'Full Access',
    descriptionKey: 'input.permissions.bypassPermissionsDescription',
    defaultDescription: 'Skip confirmations and allow full access',
  },
];

type RunModeOption = {
  mode: ChatRunMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
};

const RUN_MODE_OPTIONS: RunModeOption[] = [
  {
    mode: 'agent',
    Icon: Bot,
    labelKey: 'input.runModes.agent',
    defaultLabel: 'Agent',
  },
  {
    mode: 'plan',
    Icon: ListChecks,
    labelKey: 'input.runModes.plan',
    defaultLabel: 'Plan',
  },
];

const BLOCKING_PERMISSION_TOOLS = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'exit_plan_mode',
]);


function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function getContextStatus(tokenBudget?: Record<string, unknown> | null): ContextStatus {
  const used = readNumber(tokenBudget?.used) ?? 0;
  const total = readNumber(tokenBudget?.total) ?? 0;
  if (total <= 0) {
    return {
      known: false,
      used: 0,
      total: 0,
      percent: 0,
      usedLabel: '--',
      totalLabel: '--',
      tone: 'unknown',
    };
  }

  const percent = Math.max(0, Math.min(999, Math.round((used / total) * 100)));
  const snapshotState = typeof tokenBudget?.state === 'string' ? tokenBudget.state : null;
  const tone = snapshotState === 'blocking'
    ? 'red'
    : snapshotState === 'warning'
      ? 'amber'
      : percent >= 95
        ? 'red'
        : percent >= 80
          ? 'amber'
          : 'normal';
  return {
    known: true,
    used,
    total,
    percent,
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(total),
    tone,
  };
}

export function getQueuedInputRowsForTest(content: string): number {
  const visualLines = content.split(/\r\n|\r|\n/).reduce((count, line) => {
    return count + Math.max(1, Math.ceil(line.length / 72));
  }, 0);
  return Math.max(1, Math.min(4, visualLines));
}

export default function ComposerV2({
  input,
  placeholder,
  textareaRef,
  inputHighlightRef,
  renderInputWithMentions,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  onSubmit,
  onAbortSession,
  openImagePicker,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  onHighlightFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
  onInsertMention,
  onInsertSlash,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  isAbortPending = false,
  isSubmitPending = false,
  queuedInputs,
  onUpdateQueuedInput,
  onRemoveQueuedInput,
  onMoveQueuedInputUp,
  onMoveQueuedInputDown,
  tokenBudget,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  permissionMode,
  onPermissionModeChange,
  runMode,
  onRunModeChange,
  planModeAvailable = true,
  onPlanExecutionApproved,
  chromeless = false,
}: ComposerV2Props) {
  const { t } = useTranslation('chat');
  const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
  const [isRunModeMenuOpen, setIsRunModeMenuOpen] = useState(false);
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);
  const suppressSlashToolbarClickRef = useRef(false);
  const selectedFileSuggestionRef = useRef<HTMLDivElement | null>(null);
  const runModeButtonRef = useRef<HTMLButtonElement | null>(null);
  const permissionButtonRef = useRef<HTMLButtonElement | null>(null);
  const contextButtonRef = useRef<HTMLButtonElement | null>(null);
  const queueAttachmentBlockId = useId();
  const fileSuggestionsId = useId();
  const commandMenuId = useId();
  const runModeMenuId = useId();
  const permissionMenuId = useId();
  const contextPopoverId = useId();
  const contextPopoverTitleId = useId();
  const permissionSelectorDisabled = runMode === 'plan';

  useEffect(() => {
    if (permissionSelectorDisabled) {
      setIsPermissionMenuOpen(false);
    }
  }, [permissionSelectorDisabled]);

  const hasBlockingPermissionPanel = pendingPermissionRequests.some(
    (request) => BLOCKING_PERMISSION_TOOLS.has(request.toolName),
  );

  const hasDraftContent = input.trim().length > 0 || attachedImages.length > 0;
  const hasUploadingImages = uploadingImages.size > 0;
  const queueBlockedByAttachments = isLoading && attachedImages.length > 0;
  const firstQueuedInput = queuedInputs[0] ?? null;
  const firstQueuedInputBlocked = Boolean(
    firstQueuedInput &&
    !isLoading &&
    (firstQueuedInput.content.trim().length === 0 || firstQueuedInput.files.length > 0),
  );
  const queueAttachmentBlockMessage = t('queue.attachmentsDisabledInline', {
    count: attachedImages.length,
    defaultValue:
      'Attachments cannot be queued. Wait for the current run to finish, then send this message.',
  }) as string;
  const disabled = !hasDraftContent || isSubmitPending || hasUploadingImages || queueBlockedByAttachments;
  const contextStatus = getContextStatus(tokenBudget);
  const selectedPermissionOption =
    PERMISSION_MODE_OPTIONS.find((option) => option.mode === permissionMode) ||
    PERMISSION_MODE_OPTIONS[0];
  const selectedRunModeOption =
    RUN_MODE_OPTIONS.find((option) => option.mode === runMode) ||
    RUN_MODE_OPTIONS[0];
  const SelectedRunModeIcon = selectedRunModeOption.Icon;
  const selectedRunModeLabel = t(selectedRunModeOption.labelKey, {
    defaultValue: selectedRunModeOption.defaultLabel,
  }) as string;
  const SelectedPermissionIcon = selectedPermissionOption.Icon;
  const selectedPermissionLabel = t(selectedPermissionOption.labelKey, {
    defaultValue: selectedPermissionOption.defaultLabel,
  }) as string;
  const contextStatusTitle = contextStatus.known
    ? (t('input.contextStatus', {
        percent: contextStatus.percent,
        used: contextStatus.usedLabel,
        total: contextStatus.totalLabel,
        defaultValue:
          `${contextStatus.percent}% used. ${contextStatus.usedLabel} tokens used out of ${contextStatus.totalLabel}. Auto compact runs near the limit.`,
      }) as string)
    : (t('input.contextStatusUnknown', {
        defaultValue: 'Context usage unknown. It will appear after the next model response.',
      }) as string);
  const attachFilesLabel = t('input.attachFiles', {
    defaultValue: 'Attach photos or files',
  }) as string;
  const mentionFileLabel = t('input.mentionFile', {
    defaultValue: 'Mention a file',
  }) as string;
  const slashCommandLabel = t('input.slashCommand', {
    defaultValue: 'Run a slash command',
  }) as string;
  const stopLabel = isAbortPending
    ? (t('input.stopping', { defaultValue: 'Stopping...' }) as string)
    : (t('input.stop', { defaultValue: 'Stop' }) as string);
  const submitLabel = isSubmitPending || hasUploadingImages
    ? (t('input.sending', { defaultValue: 'Sending...' }) as string)
    : queueBlockedByAttachments
      ? queueAttachmentBlockMessage
      : isLoading
        ? (t('queue.add', { defaultValue: 'Add to queue' }) as string)
        : (t('input.send', { defaultValue: 'Send' }) as string);
  const queueStatusLabel = isLoading
    ? (t('queue.waiting', { defaultValue: 'Will send after this run' }) as string)
    : firstQueuedInputBlocked
      ? (t('queue.paused', { defaultValue: 'Fix first item to continue' }) as string)
      : (t('queue.ready', { defaultValue: 'Sending next' }) as string);
  const fileSuggestionsOpen = showFileDropdown;
  const fileSuggestionsHaveOptions = filteredFiles.length > 0;
  const selectedFileOptionId = fileSuggestionsOpen && fileSuggestionsHaveOptions && selectedFileIndex >= 0
    ? `${fileSuggestionsId}-option-${selectedFileIndex}`
    : undefined;
  const commandMenuOpen = isCommandMenuOpen;
  const selectedCommandOptionId = commandMenuOpen && filteredCommands.length > 0 && selectedCommandIndex >= 0
    ? `${commandMenuId}-option-${selectedCommandIndex}`
    : undefined;
  const activeAutocompleteId = fileSuggestionsOpen
    ? fileSuggestionsId
    : commandMenuOpen
      ? commandMenuId
      : undefined;
  const activeAutocompleteOptionId = selectedFileOptionId ?? selectedCommandOptionId;
  useEffect(() => {
    if (!fileSuggestionsOpen || !fileSuggestionsHaveOptions || selectedFileIndex < 0) {
      return;
    }
    const selectedSuggestion = selectedFileSuggestionRef.current;
    if (typeof selectedSuggestion?.scrollIntoView === 'function') {
      selectedSuggestion.scrollIntoView({ block: 'nearest' });
    }
  }, [fileSuggestionsHaveOptions, fileSuggestionsOpen, selectedFileIndex]);

  const focusElement = (element: HTMLElement | null) => {
    requestAnimationFrame(() => element?.focus());
  };
  const closeComposerPopovers = (returnFocusTo?: 'runMode' | 'permission' | 'context') => {
    setIsRunModeMenuOpen(false);
    setIsPermissionMenuOpen(false);
    setIsContextPopoverOpen(false);
    if (returnFocusTo === 'runMode') {
      focusElement(runModeButtonRef.current);
    } else if (returnFocusTo === 'permission') {
      focusElement(permissionButtonRef.current);
    } else if (returnFocusTo === 'context') {
      focusElement(contextButtonRef.current);
    }
  };
  const focusMenuItemById = (id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });
  };
  const handleMenuItemRovingFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    optionIds: string[],
    currentIndex: number,
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const lastIndex = optionIds.length - 1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? lastIndex
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % optionIds.length
          : (currentIndex - 1 + optionIds.length) % optionIds.length;
    focusMenuItemById(optionIds[nextIndex]);
  };
  const handleComposerPopoverEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== 'Escape' ||
      (!isRunModeMenuOpen && !isPermissionMenuOpen && !isContextPopoverOpen)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeComposerPopovers(
      isRunModeMenuOpen ? 'runMode' : isPermissionMenuOpen ? 'permission' : 'context',
    );
  };
  const handleRunModeButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    handleComposerPopoverEscape(event);
    if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
      return;
    }

    event.preventDefault();
    setIsRunModeMenuOpen(true);
    setIsPermissionMenuOpen(false);
    setIsContextPopoverOpen(false);

    const focusOption = RUN_MODE_OPTIONS.find(
      (option) => option.mode === runMode && !(option.mode === 'plan' && !planModeAvailable),
    ) || RUN_MODE_OPTIONS.find((option) => !(option.mode === 'plan' && !planModeAvailable));
    if (focusOption) {
      focusMenuItemById(`${runModeMenuId}-option-${focusOption.mode}`);
    }
  };
  const handlePermissionButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    handleComposerPopoverEscape(event);
    if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
      return;
    }

    event.preventDefault();
    setIsRunModeMenuOpen(false);
    setIsPermissionMenuOpen(true);
    setIsContextPopoverOpen(false);
    focusMenuItemById(`${permissionMenuId}-option-${permissionMode}`);
  };
  const toggleRunModeMenu = () => {
    setIsRunModeMenuOpen((open) => {
      const next = !open;
      if (next) {
        setIsPermissionMenuOpen(false);
        setIsContextPopoverOpen(false);
      }
      return next;
    });
  };
  const togglePermissionMenu = () => {
    if (permissionSelectorDisabled) return;
    setIsPermissionMenuOpen((open) => {
      const next = !open;
      if (next) {
        setIsRunModeMenuOpen(false);
        setIsContextPopoverOpen(false);
      }
      return next;
    });
  };
  const toggleContextPopover = () => {
    setIsContextPopoverOpen((open) => {
      const next = !open;
      if (next) {
        setIsRunModeMenuOpen(false);
        setIsPermissionMenuOpen(false);
      }
      return next;
    });
  };
  const handleComposerSubmit = (event: FormEvent<HTMLFormElement>) => {
    closeComposerPopovers();
    onSubmit(event);
  };

  return (
    <div
      className={cn(
        'shrink-0',
        chromeless
          ? ''
          : 'bg-white px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-2 dark:bg-neutral-950 md:px-6 md:pb-6 md:pt-3',
      )}
    >
      <div className={cn(chromeless ? '' : 'mx-auto max-w-[720px]')}>
        {pendingPermissionRequests.length > 0 ? (
          <div className="mb-3">
            <PermissionRequestsBanner
              pendingPermissionRequests={pendingPermissionRequests}
              handlePermissionDecision={handlePermissionDecision}
              handleGrantToolPermission={handleGrantToolPermission}
              onPlanExecutionApproved={onPlanExecutionApproved}
            />
          </div>
        ) : null}

        {!hasBlockingPermissionPanel ? (
          <form
            onSubmit={handleComposerSubmit}
            className="relative"
          >
            {attachedImages.length > 0 ? (
              <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {queueBlockedByAttachments ? (
              <div
                id={queueAttachmentBlockId}
                role="status"
                className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
              >
                {queueAttachmentBlockMessage}
              </div>
            ) : null}

            {queuedInputs.length > 0 ? (
              <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
                  <div className="min-w-0 text-[12px] font-medium text-neutral-700 dark:text-neutral-200">
                    {t('queue.title', {
                      count: queuedInputs.length,
                      defaultValue: `${queuedInputs.length} queued`,
                    })}
                  </div>
                  <div
                    aria-live="polite"
                    className={cn(
                      'text-[11px] text-neutral-500 dark:text-neutral-400',
                      firstQueuedInputBlocked && 'font-medium text-red-600 dark:text-red-300',
                    )}
                  >
                    {queueStatusLabel}
                  </div>
                </div>
                <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                  {queuedInputs.map((item, index) => {
                    const hasFiles = item.files.length > 0;
                    const isBlank = item.content.trim().length === 0;
                    const itemBlocked = isBlank || hasFiles;
                    const itemErrorId = `${queueAttachmentBlockId}-queued-${item.id}-error`;
                    const itemBlockMessage = isBlank
                      ? t('queue.emptyItem', {
                          defaultValue: 'Empty queued messages will not send. Edit or remove this item.',
                        })
                      : t('queue.attachmentItem', {
                          count: item.files.length,
                          defaultValue:
                            `${item.files.length} queued attachment${item.files.length === 1 ? '' : 's'} will not send. Remove this item and send it after the current run.`,
                        });
                    const moveUpLabel = t('queue.moveItemUp', {
                      index: index + 1,
                      defaultValue: `Move queued message ${index + 1} up`,
                    }) as string;
                    const moveDownLabel = t('queue.moveItemDown', {
                      index: index + 1,
                      defaultValue: `Move queued message ${index + 1} down`,
                    }) as string;
                    const removeLabel = t('queue.removeItem', {
                      index: index + 1,
                      defaultValue: `Remove queued message ${index + 1}`,
                    }) as string;
                    return (
                      <div
                        key={item.id}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950"
                      >
                        <div className="flex h-7 min-w-7 items-center justify-center rounded bg-neutral-100 text-[11px] font-medium tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {index + 1}
                        </div>
                        <div className="min-w-0">
                          <textarea
                            value={item.content}
                            rows={getQueuedInputRowsForTest(item.content)}
                            onChange={(event) => onUpdateQueuedInput(item.id, event.target.value)}
                            aria-invalid={itemBlocked}
                            aria-describedby={itemBlocked ? itemErrorId : undefined}
                            className={cn(
                              'block max-h-24 min-h-7 w-full resize-y rounded bg-transparent px-1 text-[13px] leading-5 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100',
                              itemBlocked && 'bg-red-50 text-red-900 ring-1 ring-red-200 dark:bg-red-950/30 dark:text-red-100 dark:ring-red-900/60',
                            )}
                            aria-label={t('queue.editItem', {
                              index: index + 1,
                              defaultValue: `Edit queued message ${index + 1}`,
                            }) as string}
                          />
                          {itemBlocked ? (
                            <div
                              id={itemErrorId}
                              role="status"
                              className="mt-1 text-[11px] leading-4 text-red-600 dark:text-red-300"
                            >
                              {itemBlockMessage}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => onMoveQueuedInputUp(item.id)}
                            disabled={index === 0}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                            aria-label={moveUpLabel}
                            title={t('queue.moveUp', { defaultValue: 'Move up' }) as string}
                          >
                            <ChevronUp className="h-4 w-4" strokeWidth={1.8} />
                          </button>
                          <button
                            type="button"
                            onClick={() => onMoveQueuedInputDown(item.id)}
                            disabled={index === queuedInputs.length - 1}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                            aria-label={moveDownLabel}
                            title={t('queue.moveDown', { defaultValue: 'Move down' }) as string}
                          >
                            <ChevronDown className="h-4 w-4" strokeWidth={1.8} />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveQueuedInput(item.id)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-50 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                            aria-label={removeLabel}
                            title={t('queue.remove', { defaultValue: 'Remove from queue' }) as string}
                          >
                            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {fileSuggestionsOpen ? (
              <div
                id={fileSuggestionsId}
                role="listbox"
                aria-label={t('input.fileSuggestions', {
                  defaultValue: 'File suggestions',
                }) as string}
                className={cn(
                  'absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900',
                  !fileSuggestionsHaveOptions && 'px-3 py-4 text-center text-[13px] text-neutral-500 dark:text-neutral-400',
                )}
              >
                {fileSuggestionsHaveOptions ? (
                  filteredFiles.map((file, index) => (
                    <div
                      key={file.path}
                      id={`${fileSuggestionsId}-option-${index}`}
                      ref={index === selectedFileIndex ? selectedFileSuggestionRef : null}
                      role="option"
                      aria-selected={index === selectedFileIndex}
                      className={cn(
                        'cursor-pointer border-b border-neutral-100 px-3 py-2 text-[13px] last:border-b-0 dark:border-neutral-800',
                        index === selectedFileIndex
                          ? 'bg-neutral-100 dark:bg-neutral-800'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                      )}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onMouseEnter={() => onHighlightFile(index)}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onSelectFile(file);
                      }}
                    >
                      <div className="font-medium">{file.name}</div>
                      <div className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                        {file.path}
                      </div>
                    </div>
                  ))
                ) : (
                  t('input.noFileSuggestions', { defaultValue: 'No matching files' })
                )}
              </div>
            ) : null}

            <div
              {...getRootProps()}
              className={cn(
                'group rounded-xl border bg-white p-2 shadow-sm transition-colors',
                'border-neutral-200 focus-within:border-neutral-300',
                'dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700',
                isDragActive && 'border-dashed border-neutral-400 dark:border-neutral-500',
              )}
            >
              <input {...getInputProps()} />

              <CommandMenu
                id={commandMenuId}
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={onCommandSelect}
                onClose={onCloseCommandMenu}
                isOpen={isCommandMenuOpen}
                frequentCommands={frequentCommands}
                position={(() => {
                  const ta = textareaRef?.current;
                  if (!ta) return { top: 0, left: 0, bottom: 90 };
                  const rect = ta.getBoundingClientRect();
                  return { top: rect.top - 8, left: rect.left, bottom: window.innerHeight - rect.top + 8 };
                })()}
              />

              <div className="relative">
                <div
                  ref={inputHighlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <div className="block w-full whitespace-pre-wrap break-words px-2 pt-2 text-[16px] leading-6 text-transparent md:pt-1.5 md:text-[14px]">
                    {renderInputWithMentions(input)}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={onInputChange}
                  onClick={onTextareaClick}
                  onKeyDown={onTextareaKeyDown}
                  onPaste={onTextareaPaste}
                  onScroll={(event) =>
                    onTextareaScrollSync(event.target as HTMLTextAreaElement)
                  }
                  onFocus={() => onInputFocusChange?.(true)}
                  onBlur={() => onInputFocusChange?.(false)}
                  onInput={onTextareaInput}
                  placeholder={placeholder}
                  aria-autocomplete="list"
                  aria-controls={activeAutocompleteId}
                  aria-expanded={Boolean(activeAutocompleteId)}
                  aria-activedescendant={activeAutocompleteOptionId}
                  rows={2}
                  className="relative z-10 block max-h-[34vh] min-h-[56px] w-full resize-none bg-transparent px-2 pt-2 text-[16px] leading-6 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100 dark:placeholder-neutral-500 md:max-h-[40vh] md:min-h-[48px] md:pt-1.5 md:text-[14px]"
                />
              </div>

                <div className="flex items-end justify-between gap-2 px-1 pt-2 md:items-center md:pt-1">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 md:flex-nowrap md:gap-0.5">
                    <div
                      data-composer-popover-scope="true"
                      className="relative mr-1"
                      onKeyDown={handleComposerPopoverEscape}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsRunModeMenuOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        ref={runModeButtonRef}
                        onClick={toggleRunModeMenu}
                        onKeyDown={handleRunModeButtonKeyDown}
                        className={cn(
                          'inline-flex h-9 max-w-[112px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px] md:h-7',
                          runMode === 'plan'
                            ? 'text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30'
                            : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        title={t('input.runModes.change', {
                          defaultValue: 'Select run mode',
                        }) as string}
                        aria-haspopup="menu"
                        aria-expanded={isRunModeMenuOpen}
                        aria-controls={isRunModeMenuOpen ? runModeMenuId : undefined}
                      >
                        <SelectedRunModeIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="truncate">{selectedRunModeLabel}</span>
                        <ChevronDown
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 transition-transform',
                            isRunModeMenuOpen && 'rotate-180',
                          )}
                          strokeWidth={2}
                        />
                      </button>
                      {isRunModeMenuOpen ? (
                        <div
                          id={runModeMenuId}
                          role="menu"
                          className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          {RUN_MODE_OPTIONS.map((option) => {
                            const Icon = option.Icon;
                            const isSelected = runMode === option.mode;
                            const isPlan = option.mode === 'plan';
                            const optionDisabled = isPlan && !planModeAvailable;
                            const optionId = `${runModeMenuId}-option-${option.mode}`;
                            const focusableRunModeIds = RUN_MODE_OPTIONS
                              .filter((runOption) => !(runOption.mode === 'plan' && !planModeAvailable))
                              .map((runOption) => `${runModeMenuId}-option-${runOption.mode}`);
                            const label = t(option.labelKey, {
                              defaultValue: option.defaultLabel,
                            }) as string;
                            const description = isPlan
                              ? (t('input.runModes.planDescription', {
                                  defaultValue: 'Generate a plan first, then execute after confirmation',
                                }) as string)
                              : (t('input.runModes.agentDescription', {
                                  defaultValue: 'Directly process and execute the task',
                                }) as string);

                            return (
                              <button
                                id={optionId}
                                key={option.mode}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isSelected}
                                disabled={optionDisabled}
                                onMouseDown={(event) => event.preventDefault()}
                                onKeyDown={(event) =>
                                  handleMenuItemRovingFocus(
                                    event,
                                    focusableRunModeIds,
                                    focusableRunModeIds.indexOf(optionId),
                                  )
                                }
                                onClick={() => {
                                  if (optionDisabled) return;
                                  onRunModeChange(option.mode);
                                  closeComposerPopovers('runMode');
                                }}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                  isSelected
                                    ? 'bg-neutral-100 dark:bg-neutral-800'
                                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                                  optionDisabled && 'cursor-not-allowed opacity-45',
                                )}
                              >
                                <Icon
                                  className={cn(
                                    'h-4 w-4 shrink-0',
                                    isPlan
                                      ? 'text-blue-600 dark:text-blue-300'
                                      : 'text-neutral-500 dark:text-neutral-400',
                                  )}
                                  strokeWidth={1.9}
                                />
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={cn(
                                      'block truncate text-[13px] font-medium',
                                      isPlan
                                        ? 'text-blue-700 dark:text-blue-300'
                                        : 'text-neutral-900 dark:text-neutral-100',
                                    )}
                                  >
                                    {label}
                                  </span>
                                  <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                                    {optionDisabled
                                      ? t('input.runModes.planUnavailable', {
                                          defaultValue: 'Plan mode is only available for Anthropic models.',
                                        })
                                      : description}
                                  </span>
                                </span>
                                {isSelected ? (
                                  <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        closeComposerPopovers();
                        openImagePicker();
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 md:h-7 md:w-7"
                      title={attachFilesLabel}
                      aria-label={attachFilesLabel}
                    >
                      <Paperclip className="h-[18px] w-[18px] md:h-4 md:w-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeComposerPopovers();
                        onInsertMention();
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 md:h-7 md:w-7"
                      title={mentionFileLabel}
                      aria-label={mentionFileLabel}
                    >
                      <AtSign className="h-[18px] w-[18px] md:h-4 md:w-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        if (isCommandMenuOpen) {
                          event.preventDefault();
                          event.stopPropagation();
                          suppressSlashToolbarClickRef.current = true;
                          closeComposerPopovers();
                          onCloseCommandMenu();
                        }
                      }}
                      onClick={(event) => {
                        if (suppressSlashToolbarClickRef.current) {
                          suppressSlashToolbarClickRef.current = false;
                          event.preventDefault();
                          return;
                        }
                        if (isCommandMenuOpen) {
                          event.preventDefault();
                          closeComposerPopovers();
                          onCloseCommandMenu();
                          return;
                        }
                        closeComposerPopovers();
                        onInsertSlash();
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 md:h-7 md:w-7"
                      title={slashCommandLabel}
                      aria-label={slashCommandLabel}
                    >
                      <Slash className="h-[18px] w-[18px] md:h-4 md:w-4" strokeWidth={1.75} />
                    </button>
                    <div
                      data-composer-popover-scope="true"
                      className="relative"
                      onKeyDown={handleComposerPopoverEscape}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsPermissionMenuOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        ref={permissionButtonRef}
                        disabled={permissionSelectorDisabled}
                        onClick={togglePermissionMenu}
                        onKeyDown={handlePermissionButtonKeyDown}
                        className={cn(
                          'inline-flex h-9 max-w-[136px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[190px] md:h-7',
                          permissionSelectorDisabled
                            ? 'cursor-not-allowed text-neutral-400 opacity-45 dark:text-neutral-500'
                            : permissionMode === 'bypassPermissions'
                              ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
                              : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        title={t('input.permissions.change', {
                          defaultValue: 'Select permission mode',
                        }) as string}
                        aria-haspopup="menu"
                        aria-expanded={permissionSelectorDisabled ? false : isPermissionMenuOpen}
                        aria-controls={!permissionSelectorDisabled && isPermissionMenuOpen ? permissionMenuId : undefined}
                      >
                        <SelectedPermissionIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="truncate">{selectedPermissionLabel}</span>
                        <ChevronDown
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 transition-transform',
                            isPermissionMenuOpen && 'rotate-180',
                          )}
                          strokeWidth={2}
                        />
                      </button>
                    {isPermissionMenuOpen ? (
                      <div
                        id={permissionMenuId}
                        role="menu"
                        className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                      >
                        {PERMISSION_MODE_OPTIONS.map((option) => {
                          const Icon = option.Icon;
                          const isSelected = permissionMode === option.mode;
                          const isDangerous = option.mode === 'bypassPermissions';
                          const optionId = `${permissionMenuId}-option-${option.mode}`;
                          const permissionOptionIds = PERMISSION_MODE_OPTIONS.map(
                            (permissionOption) => `${permissionMenuId}-option-${permissionOption.mode}`,
                          );
                          const label = t(option.labelKey, {
                            defaultValue: option.defaultLabel,
                          }) as string;
                          const description = t(option.descriptionKey, {
                            defaultValue: option.defaultDescription,
                          }) as string;

                          return (
                            <button
                              id={optionId}
                              key={option.mode}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onMouseDown={(event) => event.preventDefault()}
                              onKeyDown={(event) =>
                                handleMenuItemRovingFocus(
                                  event,
                                  permissionOptionIds,
                                  permissionOptionIds.indexOf(optionId),
                                )
                              }
                              onClick={() => {
                                onPermissionModeChange(option.mode);
                                closeComposerPopovers('permission');
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                isSelected
                                  ? 'bg-neutral-100 dark:bg-neutral-800'
                                  : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                              )}
                            >
                              <Icon
                                className={cn(
                                  'h-4 w-4 shrink-0',
                                  isDangerous
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-neutral-500 dark:text-neutral-400',
                                )}
                                strokeWidth={1.9}
                              />
                              <span className="min-w-0 flex-1">
                                <span
                                  className={cn(
                                    'block truncate text-[13px] font-medium',
                                    isDangerous
                                      ? 'text-amber-700 dark:text-amber-300'
                                      : 'text-neutral-900 dark:text-neutral-100',
                                  )}
                                >
                                  {label}
                                </span>
                                <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                                  {description}
                                </span>
                              </span>
                              {isSelected ? (
                                <Check className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" strokeWidth={2} />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  </div>

                  <div className="ml-1 flex shrink-0 items-center gap-1 md:ml-2">
                    <div
                      data-composer-popover-scope="true"
                      className="relative"
                      onKeyDown={handleComposerPopoverEscape}
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsContextPopoverOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        ref={contextButtonRef}
                        onClick={toggleContextPopover}
                        className={cn(
                          'inline-flex h-9 min-w-10 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition md:h-7 md:min-w-[44px]',
                          contextStatus.tone === 'red'
                            ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
                            : contextStatus.tone === 'amber'
                              ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
                              : contextStatus.tone === 'normal'
                                ? 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                                : 'text-neutral-400 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:bg-neutral-800',
                        )}
                        title={contextStatusTitle}
                        aria-label={contextStatusTitle}
                        aria-expanded={isContextPopoverOpen}
                        aria-controls={isContextPopoverOpen ? contextPopoverId : undefined}
                      >
                        <CircleGauge className="h-4 w-4" strokeWidth={1.75} />
                        <span>{contextStatus.known ? `${contextStatus.percent}%` : '--'}</span>
                      </button>
                      {isContextPopoverOpen ? (
                        <div
                          id={contextPopoverId}
                          role="region"
                          aria-labelledby={contextPopoverTitleId}
                          className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-neutral-200 bg-white p-3 text-left text-[12px] leading-5 text-neutral-700 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span id={contextPopoverTitleId} className="font-medium text-neutral-900 dark:text-neutral-100">
                              {t('input.contextStatusTitle', { defaultValue: 'Context window' })}
                            </span>
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                                contextStatus.tone === 'red'
                                  ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                  : contextStatus.tone === 'amber'
                                    ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                                    : contextStatus.tone === 'normal'
                                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
                              )}
                            >
                              {contextStatus.known ? `${contextStatus.percent}%` : '--'}
                            </span>
                          </div>
                          {contextStatus.known ? (
                            <>
                              <div className="text-neutral-500 dark:text-neutral-400">
                                {t('input.contextStatusUsed', {
                                  used: contextStatus.used.toLocaleString(),
                                  total: contextStatus.total.toLocaleString(),
                                  defaultValue:
                                    `${contextStatus.used.toLocaleString()} tokens used out of ${contextStatus.total.toLocaleString()}.`,
                                })}
                              </div>
                              <div className="mt-2 text-neutral-500 dark:text-neutral-400">
                                {t('input.contextStatusAutoCompact', {
                                  defaultValue:
                                    'Auto compact runs when the conversation approaches the configured limit.',
                                })}
                              </div>
                            </>
                          ) : (
                            <div className="text-neutral-500 dark:text-neutral-400">
                              {t('input.contextStatusUnknownBody', {
                                defaultValue:
                                  'No token budget has been reported yet. It will appear after the next model response.',
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {isLoading && canAbortSession ? (
                      <button
                        type="button"
                        onClick={() => {
                          closeComposerPopovers();
                          onAbortSession();
                        }}
                        disabled={isAbortPending}
                        className={cn(
                          'inline-flex h-10 w-10 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600 md:h-8 md:w-8',
                          isAbortPending && 'cursor-wait opacity-70 hover:bg-red-500',
                        )}
                        title={stopLabel}
                        aria-label={stopLabel}
                      >
                        {isAbortPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                        ) : (
                          <Square className="h-3.5 w-3.5" strokeWidth={2.5} fill="currentColor" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      disabled={disabled}
                      onClick={closeComposerPopovers}
                      aria-label={submitLabel}
                      aria-busy={isSubmitPending || hasUploadingImages}
                      aria-describedby={queueBlockedByAttachments ? queueAttachmentBlockId : undefined}
                      className={cn(
                        'inline-flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-900 text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900 md:h-8 md:w-8',
                        isLoading && 'bg-neutral-700 dark:bg-neutral-200',
                        (isSubmitPending || hasUploadingImages) && 'cursor-wait',
                      )}
                      title={submitLabel}
                    >
                      {isSubmitPending || hasUploadingImages ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : (
                        <ArrowUp className="h-4 w-4" strokeWidth={2} />
                      )}
                    </button>
                  </div>
                </div>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
