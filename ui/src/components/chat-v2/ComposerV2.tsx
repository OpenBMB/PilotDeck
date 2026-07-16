import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
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
  Brain,
  Bot,
  Check,
  ChevronDown,
  CircleGauge,
  CircleHelp,
  Hand,
  ListChecks,
  Loader2,
  Paperclip,
  ShieldAlert,
  Square,
  type LucideIcon,
} from 'lucide-react';
import type { ChatRunMode, PendingPermissionRequest, PermissionMode } from '../chat/types/types';
import { MAX_ATTACHMENTS_ERROR_KEY } from '../chat/hooks/useChatComposerState';
import { thinkingModes, type ThinkingModeId } from '../chat/constants/thinkingModes';
import { getEffectiveThinkingMode, type ThinkingModeAvailability } from '../chat/constants/thinkingModeAvailability';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import CommandMenu from '../chat/view/subcomponents/CommandMenu';
import { cn } from '../../lib/utils.js';
import {
  type DocumentSelectionReference,
} from '../../types/documentSelection';
import DocumentReferenceChip from './DocumentReferenceChip';

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
  documentReferences: DocumentSelectionReference[];
  onRemoveDocumentReference: (id: string) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;

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
  isBusySendQueued?: boolean;
  isBusySendConfirmed?: boolean;
  onCancelBusySendQueue?: () => void;
  isSubmitPending?: boolean;
  tokenBudget?: Record<string, unknown> | null;
  thinkingMode: ThinkingModeId;
  thinkingModeAvailability: ThinkingModeAvailability;
  onThinkingModeChange: (mode: ThinkingModeId) => void;

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
  displayTotal: number;
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
  {
    mode: 'ask',
    Icon: CircleHelp,
    labelKey: 'input.runModes.ask',
    defaultLabel: 'Ask',
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
  const used = readNumber(tokenBudget?.displayUsed) ?? readNumber(tokenBudget?.used) ?? 0;
  const budgetUsed = readNumber(tokenBudget?.budgetUsed) ?? readNumber(tokenBudget?.used) ?? used;
  const total = readNumber(tokenBudget?.total) ?? 0;
  const effectiveTotal = readNumber(tokenBudget?.effectiveTotal);
  const displayTotal = effectiveTotal && effectiveTotal > 0 ? effectiveTotal : total;
  if (displayTotal <= 0) {
    return {
      known: false,
      used: 0,
      total: 0,
      displayTotal: 0,
      percent: 0,
      usedLabel: '--',
      totalLabel: '--',
      tone: 'unknown',
    };
  }

  const percent = Math.max(0, Math.min(999, Math.round((budgetUsed / displayTotal) * 100)));
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
    displayTotal,
    percent,
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(displayTotal),
    tone,
  };
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
  documentReferences,
  onRemoveDocumentReference,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
  onInsertMention,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  isAbortPending = false,
  isBusySendQueued = false,
  isBusySendConfirmed = false,
  onCancelBusySendQueue,
  isSubmitPending = false,
  tokenBudget,
  thinkingMode,
  thinkingModeAvailability,
  onThinkingModeChange,
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
  const [isThinkingModeMenuOpen, setIsThinkingModeMenuOpen] = useState(false);
  const [isRunModeMenuOpen, setIsRunModeMenuOpen] = useState(false);
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);
  const permissionSelectorDisabled = runMode === 'plan';

  useEffect(() => {
    if (permissionSelectorDisabled) {
      setIsPermissionMenuOpen(false);
    }
  }, [permissionSelectorDisabled]);

  const hasBlockingPermissionPanel = pendingPermissionRequests.some(
    (request) => BLOCKING_PERMISSION_TOOLS.has(request.toolName),
  );

  const hasDraftContent = input.trim().length > 0 || attachedImages.length > 0 || documentReferences.length > 0;
  const hasUploadingImages = uploadingImages.size > 0;
  const attachmentLimitError = imageErrors.get(MAX_ATTACHMENTS_ERROR_KEY);
  const disabled = !hasDraftContent || isSubmitPending || hasUploadingImages;
  const showAbortButton = isLoading && canAbortSession && !hasDraftContent;
  const sendTitle = isSubmitPending || hasUploadingImages
    ? (t('input.sending', { defaultValue: 'Sending...' }) as string)
    : isBusySendConfirmed
      ? (t('input.queuedSendConfirmed', { defaultValue: 'Stopping current turn — sending next message' }) as string)
      : isBusySendQueued
        ? (t('input.queuedSendConfirm', { defaultValue: 'Queued — click send again to stop this turn and send now' }) as string)
      : isLoading
        ? (t('input.queueSend', { defaultValue: 'Queue message' }) as string)
        : (t('input.send', { defaultValue: 'Send' }) as string);
  const contextStatus = getContextStatus(tokenBudget);
  const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
  const selectedThinkingMode = thinkingModes.find((option) => option.id === effectiveThinkingMode) || thinkingModes[0];
  const SelectedThinkingIcon = selectedThinkingMode.icon || Brain;
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

  return (
    <div
      className={cn(
        'min-w-0 shrink-0',
        chromeless ? '' : 'bg-white px-6 pb-6 pt-3 dark:bg-neutral-950',
      )}
    >
      <div className={cn('min-w-0', chromeless ? '' : 'mx-auto max-w-[720px]')}>
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
            onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
            className="pd-composer-container relative"
          >
            {attachedImages.length > 0 || documentReferences.length > 0 ? (
              <div className="pd-composer-attachment-panel mb-2 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex flex-wrap gap-2">
                  {documentReferences.map((reference) => (
                    <DocumentReferenceChip
                      key={reference.id}
                      reference={reference}
                      className="pd-composer-reference-chip sm:max-w-[520px]"
                      removeLabel={t('documentReferences.remove', { defaultValue: 'Remove reference' }) as string}
                      onRemove={() => onRemoveDocumentReference(reference.id)}
                    />
                  ))}
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
                {attachmentLimitError ? (
                  <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">
                    {attachmentLimitError}
                  </div>
                ) : null}
              </div>
            ) : null}

            {showFileDropdown && filteredFiles.length > 0 ? (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                {filteredFiles.map((file, index) => (
                  <div
                    key={file.path}
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
                ))}
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
                  <div className="block w-full whitespace-pre-wrap break-words px-2 pt-1.5 text-[14px] leading-6 text-transparent">
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
                  rows={2}
                  className="relative z-10 block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
                />
              </div>

                <div className="pd-composer-control-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1">
                  <div className="pd-composer-toolbar-left flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                    <div
                      className="relative mr-1"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsRunModeMenuOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setIsRunModeMenuOpen((open) => !open)}
                        className={cn(
                          'pd-composer-icon-button inline-flex h-7 max-w-[108px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]',
                          'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                        )}
                        title={t('input.runModes.change', {
                          defaultValue: 'Select run mode',
                        }) as string}
                        aria-haspopup="menu"
                        aria-expanded={isRunModeMenuOpen}
                      >
                        <SelectedRunModeIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="pd-composer-run-label truncate">{selectedRunModeLabel}</span>
                        <ChevronDown
                          className={cn(
                            'pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform',
                            isRunModeMenuOpen && 'rotate-180',
                          )}
                          strokeWidth={2}
                        />
                      </button>
                      {isRunModeMenuOpen ? (
                        <div
                          role="menu"
                          className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          {RUN_MODE_OPTIONS.map((option) => {
                            const Icon = option.Icon;
                            const isSelected = runMode === option.mode;
                            const isPlan = option.mode === 'plan';
                            const isAsk = option.mode === 'ask';
                            const optionDisabled = isPlan && !planModeAvailable;
                            const label = t(option.labelKey, {
                              defaultValue: option.defaultLabel,
                            }) as string;
                            const description = isPlan
                              ? (t('input.runModes.planDescription', {
                                  defaultValue: 'Generate a plan first, then execute after confirmation',
                                }) as string)
                              : isAsk
                                ? (t('input.runModes.askDescription', {
                                    defaultValue: 'Only answers questions without modifying files',
                                  }) as string)
                              : (t('input.runModes.agentDescription', {
                                  defaultValue: 'Directly process and execute the task',
                                }) as string);

                            return (
                              <button
                                key={option.mode}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isSelected}
                                disabled={optionDisabled}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  if (optionDisabled) return;
                                  onRunModeChange(option.mode);
                                  setIsRunModeMenuOpen(false);
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
                                  className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400"
                                  strokeWidth={1.9}
                                />
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={cn(
                                      'block truncate text-[13px]',
                                      isSelected
                                        ? 'font-bold text-neutral-900 dark:text-neutral-100'
                                        : 'font-medium text-neutral-700 dark:text-neutral-300',
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
                      onClick={openImagePicker}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.attachFiles', { defaultValue: 'Attach photos or files' }) as string}
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onInsertMention}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.mentionFile', { defaultValue: 'Mention a file' }) as string}
                  >
                    <AtSign className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                    <div
                      className="relative"
                    onBlur={(event) => {
                      const nextTarget = event.relatedTarget as Node | null;
                      if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                        setIsPermissionMenuOpen(false);
                      }
                    }}
                  >
                    <button
                      type="button"
                      disabled={permissionSelectorDisabled}
                      onClick={() => {
                        if (permissionSelectorDisabled) return;
                        setIsPermissionMenuOpen((open) => !open);
                      }}
                      className={cn(
                        'pd-composer-icon-button inline-flex h-7 max-w-[132px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[190px]',
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
                    >
                      <SelectedPermissionIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                      <span className="pd-composer-permission-label truncate">{selectedPermissionLabel}</span>
                      <ChevronDown
                        className={cn(
                          'pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform',
                          isPermissionMenuOpen && 'rotate-180',
                        )}
                        strokeWidth={2}
                      />
                    </button>
                    {isPermissionMenuOpen ? (
                      <div
                        role="menu"
                        className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                      >
                        {PERMISSION_MODE_OPTIONS.map((option) => {
                          const Icon = option.Icon;
                          const isSelected = permissionMode === option.mode;
                          const isDangerous = option.mode === 'bypassPermissions';
                          const label = t(option.labelKey, {
                            defaultValue: option.defaultLabel,
                          }) as string;
                          const description = t(option.descriptionKey, {
                            defaultValue: option.defaultDescription,
                          }) as string;

                          return (
                            <button
                              key={option.mode}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                onPermissionModeChange(option.mode);
                                setIsPermissionMenuOpen(false);
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

                  {isBusySendQueued ? (
                    <div className="hidden min-w-0 flex-1 items-center justify-end gap-1 px-2 text-[12px] text-amber-700 dark:text-amber-300 sm:flex">
                      <span className="truncate rounded-full bg-amber-50 px-2 py-1 dark:bg-amber-950/30">
                        {isBusySendConfirmed
                          ? t('input.queuedSendConfirmedInline', { defaultValue: 'Stopping current turn; sending next' })
                          : t('input.queuedSendConfirmInline', { defaultValue: 'Queued; click again to stop this turn and send now' })}
                      </span>
                      <button
                        type="button"
                        onClick={onCancelBusySendQueue}
                        className="rounded-full px-2 py-1 text-amber-700 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
                        title={t('input.cancelQueuedSend', { defaultValue: 'Cancel queued message' }) as string}
                      >
                        {t('input.cancelQueuedSendShort', { defaultValue: 'Cancel' })}
                      </button>
                    </div>
                  ) : null}

                  <div className="pd-composer-toolbar-right ml-auto flex shrink-0 items-center gap-1">
                    <div
                      className="relative"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsContextPopoverOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setIsContextPopoverOpen((open) => !open)}
                        className={cn(
                          'pd-composer-icon-button inline-flex h-7 min-w-[44px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition',
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
                      >
                        <CircleGauge className="h-4 w-4" strokeWidth={1.75} />
                        <span className="pd-composer-context-label">{contextStatus.known ? `${contextStatus.percent}%` : '--'}</span>
                      </button>
                      {isContextPopoverOpen ? (
                        <div
                          role="status"
                          className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-lg border border-neutral-200 bg-white p-3 text-left text-[12px] leading-5 text-neutral-700 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-medium text-neutral-900 dark:text-neutral-100">
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
                                  total: contextStatus.displayTotal.toLocaleString(),
                                  defaultValue:
                                    `${contextStatus.used.toLocaleString()} tokens used out of ${contextStatus.displayTotal.toLocaleString()}.`,
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

                    <div
                      className="relative"
                      onBlur={(event) => {
                        const nextTarget = event.relatedTarget as Node | null;
                        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                          setIsThinkingModeMenuOpen(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setIsThinkingModeMenuOpen((open) => !open)}
                        className={cn(
                          'pd-composer-icon-button inline-flex h-7 max-w-[116px] items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition sm:max-w-[140px]',
                          effectiveThinkingMode === 'default'
                            ? 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                            : 'text-purple-600 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950/30',
                        )}
                        title={t('input.thinking.change', { defaultValue: 'Select thinking strength' }) as string}
                        aria-haspopup="menu"
                        aria-expanded={isThinkingModeMenuOpen}
                      >
                        <SelectedThinkingIcon className="h-4 w-4 shrink-0" strokeWidth={1.9} />
                        <span className="pd-composer-thinking-label truncate">{selectedThinkingMode.name}</span>
                        <ChevronDown
                          className={cn(
                            'pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform',
                            isThinkingModeMenuOpen && 'rotate-180',
                          )}
                          strokeWidth={2}
                        />
                      </button>
                      {isThinkingModeMenuOpen ? (
                        <div
                          role="menu"
                          className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-neutral-200 bg-white p-1.5 text-left shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          {thinkingModes.map((option) => {
                            const Icon = option.icon || Brain;
                            const isSelected = option.id === thinkingMode;
                            const unavailableReason = thinkingModeAvailability[option.id];
                            return (
                              <button
                                key={option.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isSelected}
                                disabled={Boolean(unavailableReason)}
                                onClick={() => {
                                  if (unavailableReason) return;
                                  onThinkingModeChange(option.id);
                                  setIsThinkingModeMenuOpen(false);
                                }}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
                                  isSelected
                                    ? 'bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-50'
                                    : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800/70',
                                  unavailableReason && 'cursor-not-allowed opacity-45 hover:bg-transparent dark:hover:bg-transparent',
                                )}
                                title={option.name}
                              >
                                <Icon className={cn('h-4 w-4 shrink-0', option.color)} strokeWidth={1.9} />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[13px] font-medium">{option.name}</span>
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

                    {showAbortButton ? (
                      <button
                        type="button"
                        onClick={onAbortSession}
                        disabled={isAbortPending}
                        className={cn(
                          'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600',
                          isAbortPending && 'cursor-wait opacity-70 hover:bg-red-500',
                        )}
                        title={
                          isAbortPending
                            ? (t('input.stopping', { defaultValue: 'Stopping...' }) as string)
                            : (t('input.stop', { defaultValue: 'Stop' }) as string)
                        }
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
                      aria-busy={isSubmitPending || hasUploadingImages || isBusySendConfirmed}
                      className={cn(
                        'inline-flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900',
                        isBusySendQueued && 'bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-400 dark:text-neutral-950 dark:hover:bg-amber-300',
                        isBusySendConfirmed && 'cursor-wait',
                        (isSubmitPending || hasUploadingImages) && 'cursor-wait',
                      )}
                      title={sendTitle}
                    >
                      {isSubmitPending || hasUploadingImages ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : isBusySendConfirmed ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : isBusySendQueued ? (
                        <Check className="h-4 w-4" strokeWidth={2.25} />
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
