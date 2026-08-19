import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  File,
  Folder,
  Plus,
  Search,
  ShieldAlert,
  Square,
  type LucideIcon,
} from "lucide-react";
import type {
  ChatRunMode,
  PendingPermissionRequest,
  PermissionMode,
} from "../chat/types/types";
import { MAX_ATTACHMENTS_ERROR_KEY } from "../chat/hooks/useChatComposerState";
import PermissionRequestsBanner from "../chat/view/subcomponents/PermissionRequestsBanner";
import ImageAttachment from "../chat/view/subcomponents/ImageAttachment";
import CommandMenu from "../chat/view/subcomponents/CommandMenu";
import { cn } from "../../lib/utils.js";
import type { ContentReference } from "../../types/contentReference";
import { authenticatedFetch } from "../../utils/api";
import type {
  ChatModelCatalogItem,
  ChatModelSelection,
  ModelNumericCapability,
} from "../chat/hooks/useChatProviderState";
import DocumentReferenceChip from "./DocumentReferenceChip";

interface MentionableFile {
  id?: string;
  name: string;
  path: string;
  relativePath?: string;
  kind?: "file" | "directory";
  size?: number;
  matches?: Array<{ field: string; start: number; end: number }>;
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

type ComposerSkill = {
  slug: string;
  name: string;
  description?: string;
  command?: string;
};

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
  onAddAttachmentFiles: (files: File[]) => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  onRetryImage: (file: File) => void;
  documentReferences: ContentReference[];
  onRemoveDocumentReference: (id: string) => void;
  onOpenDocumentReference?: (filePath: string) => void;
  uploadingImages: Map<File, number>;
  imageErrors: Map<File | string, string>;

  showFileDropdown: boolean;
  fileMentionQuery: string;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  isLoadingFiles: boolean;
  fileListError: string | null;
  hasMoreFiles: boolean;
  onLoadMoreFiles: () => void;
  onSelectFile: (file: MentionableFile) => void;
  selectedFileMentions: MentionableFile[];
  onRemoveFileMention: (path: string) => void;
  selectedSkills: ComposerSkill[];
  onSelectSkill: (skill: ComposerSkill) => void;
  onRemoveSkill: (slug: string, command?: string) => void;
  selectedCommands: SlashCommand[];
  onRemoveCommand: (name: string) => void;

  filteredCommands: SlashCommand[];
  commandQuery: string;
  selectedCommandIndex: number;
  onCommandSelect: (
    command: SlashCommand,
    index: number,
    isHover: boolean,
  ) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
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
  modelCatalog: ChatModelCatalogItem[];
  modelSelection: ChatModelSelection | null;
  isModelCatalogLoading?: boolean;
  modelCatalogError?: string | null;
  projectKey: string;
  onModelSelectionChange: (selection: ChatModelSelection) => void;

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
  percentLabel: string;
  usedLabel: string;
  totalLabel: string;
  state: "ok" | "warning" | "blocking" | "unknown";
  tone: "normal" | "amber" | "red" | "unknown";
};

type PermissionModeOption = {
  mode: PermissionMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
};

function DefaultPermissionIcon({
  className,
  strokeWidth = 1.8,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      <path d="M4 17h16" />
      <path d="M6 17V9a6 6 0 0 1 12 0v8" />
      <path d="M9 21h6" />
    </svg>
  );
}

const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: "default",
    Icon: DefaultPermissionIcon as LucideIcon,
    labelKey: "input.permissions.default",
    defaultLabel: "Default Permissions",
    descriptionKey: "input.permissions.defaultDescription",
    defaultDescription: "Ask before risky operations",
  },
  {
    mode: "bypassPermissions",
    Icon: ShieldAlert,
    labelKey: "input.permissions.bypassPermissions",
    defaultLabel: "Full Access",
    descriptionKey: "input.permissions.bypassPermissionsDescription",
    defaultDescription: "Skip confirmations and allow full access",
  },
];

const BLOCKING_PERMISSION_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "ExitPlanModeV2",
  "exit_plan_mode",
]);

const REASONING_LABELS = new Map<number, string>([
  [0, "关闭"],
  [0.2, "轻度"],
  [0.4, "低"],
  [0.6, "中"],
  [0.8, "高"],
  [0.9, "极高"],
  [1, "最高"],
]);

function capabilityValues(capability?: ModelNumericCapability): number[] {
  if (!capability) return [];
  if (Array.isArray(capability.values)) {
    return capability.values.filter(Number.isFinite);
  }
  if (
    capability.type !== "range" ||
    !Number.isFinite(capability.min) ||
    !Number.isFinite(capability.max) ||
    !Number.isFinite(capability.step) ||
    (capability.step ?? 0) <= 0
  ) {
    return [];
  }

  const min = capability.min as number;
  const max = capability.max as number;
  const step = capability.step as number;
  const values: number[] = [];
  for (
    let value = min;
    value <= max + step / 2 && values.length < 101;
    value += step
  ) {
    values.push(Number(value.toFixed(10)));
  }
  return values;
}

function renderMatchHighlights(text: string, query: string): ReactNode {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;

  const source = text.toLocaleLowerCase();
  const needle = normalizedQuery.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = source.indexOf(needle);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const matchEnd = matchIndex + normalizedQuery.length;
    parts.push(
      <mark
        key={`${matchIndex}-${matchEnd}`}
        className="rounded-[3px] bg-[#e6e1ff] px-0.5 py-px font-[750] text-[#4e46b7]"
      >
        {text.slice(matchIndex, matchEnd)}
      </mark>,
    );
    cursor = matchEnd;
    matchIndex = source.indexOf(needle, cursor);
  }

  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function modelSelectionId(selection: ChatModelSelection | null): string {
  return selection?.mode === "auto"
    ? "router/auto"
    : selection?.mode === "model"
      ? `${selection.provider}/${selection.model}`
      : "";
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
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

function formatContextPercentLabel(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) {
    return "0%";
  }
  if (percent > 100) {
    return "100%+";
  }
  return `${percent}%`;
}

export function getContextStatus(tokenBudget?: Record<string, unknown> | null): ContextStatus {
  // `used` is the resolved provider/calibrated count that drives compaction.
  // Keep displayUsed only as a fallback for older persisted gateway events.
  const used = readNumber(tokenBudget?.used) ?? readNumber(tokenBudget?.displayUsed) ?? 0;
  const total = readNumber(tokenBudget?.total) ?? 0;
  const effectiveTotal = readNumber(tokenBudget?.effectiveTotal);
  const displayTotal =
    effectiveTotal && effectiveTotal > 0 ? effectiveTotal : total;
  if (displayTotal <= 0) {
    return {
      known: false,
      used: 0,
      total: 0,
      displayTotal: 0,
      percent: 0,
      percentLabel: "0%",
      usedLabel: "--",
      totalLabel: "--",
      state: "unknown",
      tone: "unknown",
    };
  }

  // The visible count and percent must describe the resolved request budget.
  const percent = Math.max(0, Math.round((used / displayTotal) * 100));
  const snapshotState =
    typeof tokenBudget?.state === "string" ? tokenBudget.state : null;
  const tone =
    snapshotState === "blocking"
      ? "red"
      : snapshotState === "warning"
        ? "amber"
        : percent >= 95
          ? "red"
          : percent >= 80
            ? "amber"
            : "normal";
  return {
    known: true,
    used,
    total,
    displayTotal,
    percent,
    percentLabel: formatContextPercentLabel(percent),
    usedLabel: formatTokenCount(used),
    totalLabel: formatTokenCount(displayTotal),
    state:
      snapshotState === "blocking" || snapshotState === "warning"
        ? snapshotState
        : "ok",
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
  onAddAttachmentFiles,
  attachedImages,
  onRemoveImage,
  onRetryImage,
  documentReferences,
  onRemoveDocumentReference,
  onOpenDocumentReference,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  fileMentionQuery,
  filteredFiles,
  selectedFileIndex,
  isLoadingFiles,
  fileListError,
  hasMoreFiles,
  onLoadMoreFiles,
  onSelectFile,
  selectedFileMentions,
  onRemoveFileMention,
  selectedSkills,
  onSelectSkill,
  onRemoveSkill,
  selectedCommands,
  onRemoveCommand,
  filteredCommands,
  commandQuery,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
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
  modelCatalog,
  modelSelection,
  isModelCatalogLoading = false,
  modelCatalogError,
  projectKey,
  onModelSelectionChange,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  permissionMode,
  onPermissionModeChange,
  runMode,
  onPlanExecutionApproved,
  chromeless = false,
}: ComposerV2Props) {
  const { t } = useTranslation("chat");
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [advancedModelId, setAdvancedModelId] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [skills, setSkills] = useState<ComposerSkill[]>([]);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const permissionSelectorDisabled = runMode === "plan";

  useEffect(() => {
    if (permissionSelectorDisabled) {
      setIsPermissionMenuOpen(false);
    }
  }, [permissionSelectorDisabled]);

  useEffect(() => {
    if (!isAddMenuOpen || !projectKey) return;
    const abortController = new AbortController();
    setIsSkillsLoading(true);
    authenticatedFetch("/api/skills/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectKey,
        query: skillQuery || undefined,
        scope: "all",
        limit: 50,
      }),
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load skills");
        const data = await response.json();
        setSkills(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((error) => {
        if ((error as { name?: string })?.name !== "AbortError") setSkills([]);
      })
      .finally(() => {
        if (!abortController.signal.aborted) setIsSkillsLoading(false);
      });
    return () => abortController.abort();
  }, [isAddMenuOpen, projectKey, skillQuery]);

  const hasBlockingPermissionPanel = pendingPermissionRequests.some((request) =>
    BLOCKING_PERMISSION_TOOLS.has(request.toolName),
  );

  const hasDraftContent =
    input.trim().length > 0 ||
    attachedImages.length > 0 ||
    documentReferences.length > 0 ||
    selectedFileMentions.length > 0 ||
    selectedSkills.length > 0 ||
    selectedCommands.length > 0;
  const selectedFileMentionPaths = useMemo(
    () => new Set(selectedFileMentions.map((mention) => mention.path)),
    [selectedFileMentions],
  );
  const selectedSkillKeys = useMemo(
    () =>
      new Set(
        selectedSkills.map(
          (skill) => `${skill.slug}\u0000${skill.command || ""}`,
        ),
      ),
    [selectedSkills],
  );
  const hasUploadingImages = uploadingImages.size > 0;
  const attachmentLimitError = imageErrors.get(MAX_ATTACHMENTS_ERROR_KEY);
  const disabled = !hasDraftContent || isSubmitPending || hasUploadingImages;
  const showAbortButton = isLoading && canAbortSession && !hasDraftContent;
  const sendTitle =
    isSubmitPending || hasUploadingImages
      ? (t("input.sending", { defaultValue: "Sending..." }) as string)
      : isBusySendConfirmed
        ? (t("input.queuedSendConfirmed", {
            defaultValue: "Stopping current turn — sending next message",
          }) as string)
        : isBusySendQueued
          ? (t("input.queuedSendConfirm", {
              defaultValue:
                "Queued — click send again to stop this turn and send now",
            }) as string)
          : isLoading
            ? (t("input.queueSend", {
                defaultValue: "Queue message",
              }) as string)
            : (t("input.send", { defaultValue: "Send" }) as string);
  const selectedPermissionOption =
    PERMISSION_MODE_OPTIONS.find((option) => option.mode === permissionMode) ||
    PERMISSION_MODE_OPTIONS[0];
  const SelectedPermissionIcon = selectedPermissionOption.Icon;
  const selectedPermissionLabel = t(selectedPermissionOption.labelKey, {
    defaultValue: selectedPermissionOption.defaultLabel,
  }) as string;
  const selectedModelId = modelSelectionId(modelSelection);
  const selectedModel = modelCatalog.find(
    (item) => item.id === selectedModelId,
  );
  const selectedModelLabel =
    modelSelection?.mode === "auto"
      ? "Auto"
      : selectedModel?.displayName ||
        selectedModel?.model ||
        (t("input.models.select", {
          defaultValue: "选择模型",
        }) as string);
  const normalizedModelQuery = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = useMemo(
    () =>
      modelCatalog.filter(
        (item) =>
          !normalizedModelQuery ||
          `${item.displayName} ${item.provider} ${item.model}`
            .toLocaleLowerCase()
            .includes(normalizedModelQuery),
      ),
    [modelCatalog, normalizedModelQuery],
  );
  const advancedModel =
    modelCatalog.find((item) => item.id === advancedModelId) || null;

  return (
    <div
      className={cn(
        "min-w-0 shrink-0",
        chromeless ? "" : "bg-white px-6 pb-6 pt-3 dark:bg-neutral-950",
      )}
    >
      <div className={cn("min-w-0", chromeless ? "" : "mx-auto max-w-[720px]")}>
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
                      removeLabel={
                        t("documentReferences.remove", {
                          defaultValue: "Remove reference",
                        }) as string
                      }
                      openLabel={
                        t("documentReferences.open", {
                          defaultValue: `Open ${reference.source.fileName}`,
                        }) as string
                      }
                      onOpen={
                        onOpenDocumentReference
                          ? () =>
                              onOpenDocumentReference(
                                reference.source.relativePath,
                              )
                          : undefined
                      }
                      onRemove={() => onRemoveDocumentReference(reference.id)}
                    />
                  ))}
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      onRetry={() => onRetryImage(file)}
                      uploadProgress={uploadingImages.get(file)}
                      error={imageErrors.get(file)}
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

            {showFileDropdown ? (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-violet-200 bg-white p-2 shadow-xl shadow-violet-950/10 dark:border-violet-900/70 dark:bg-neutral-900">
                <div className="flex items-center justify-between px-2 pb-2 pt-1">
                  <span className="text-[12px] font-bold text-neutral-900 dark:text-neutral-100">
                    {t("input.projectFiles", { defaultValue: "引用项目内容" })}
                  </span>
                  <span className="text-[11px] text-[#777987] dark:text-[#a9aab4]">
                    {`${filteredFiles.length} 项可引用内容`}
                  </span>
                </div>
                <div
                  role="listbox"
                  aria-label={
                    t("input.projectFilesAriaLabel", {
                      defaultValue: "可引用的项目内容",
                    }) as string
                  }
                  className="grid max-h-[238px] gap-px overflow-y-auto [scrollbar-color:#c8c5d5_transparent] [scrollbar-width:thin]"
                  onScroll={(event) => {
                    const target = event.currentTarget;
                    if (
                      hasMoreFiles &&
                      !isLoadingFiles &&
                      target.scrollHeight -
                        target.scrollTop -
                        target.clientHeight <
                        40
                    ) {
                      onLoadMoreFiles();
                    }
                  }}
                >
                  {fileListError ? (
                    <div className="px-4 py-6 text-center text-[12px] text-red-500">
                      {fileListError}
                    </div>
                  ) : isLoadingFiles && filteredFiles.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 px-4 py-6 text-[12px] text-neutral-400">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("input.projectFilesLoading", {
                        defaultValue: "正在加载项目文件…",
                      })}
                    </div>
                  ) : filteredFiles.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12px] text-neutral-400">
                      {t("input.projectFilesEmpty", {
                        defaultValue: "没有匹配的项目内容",
                      })}
                    </div>
                  ) : (
                    <>
                      {filteredFiles.map((file, index) => {
                        const EntryIcon =
                          file.kind === "directory" ? Folder : File;
                        const isSelectedMention = selectedFileMentionPaths.has(
                          file.path,
                        );
                        const isActive =
                          isSelectedMention || index === selectedFileIndex;
                        return (
                          <button
                            key={file.id || file.path}
                            type="button"
                            role="option"
                            aria-selected={isSelectedMention}
                            className={cn(
                              "grid min-h-12 w-full cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg border-0 bg-transparent px-2.5 py-[5px] text-left text-neutral-700 transition-colors hover:bg-[#f7f6ff] hover:text-[#393393] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                              isActive
                                ? "bg-[#eeecff] text-[#393393] hover:bg-[#eeecff] dark:bg-violet-950/70 dark:text-violet-200 dark:hover:bg-violet-950/70"
                                : "",
                            )}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onSelectFile(file)}
                          >
                            <EntryIcon
                              className="h-4 w-4 shrink-0 text-current"
                              strokeWidth={1.8}
                            />
                            <strong className="min-w-0 truncate text-[12px] font-medium leading-[1.4] text-inherit">
                              {renderMatchHighlights(
                                file.name,
                                fileMentionQuery,
                              )}
                            </strong>
                          </button>
                        );
                      })}
                      {isLoadingFiles ? (
                        <div className="flex items-center justify-center gap-2 px-3 py-2 text-[11px] text-neutral-400">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("input.projectFilesLoadingMore", {
                            defaultValue: "加载更多…",
                          })}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}

            <div
              {...getRootProps()}
              className={cn(
                "group rounded-xl border bg-white p-2 shadow-sm transition-colors",
                "border-neutral-200 focus-within:border-neutral-300",
                "dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700",
                isDragActive &&
                  "border-dashed border-neutral-400 dark:border-neutral-500",
              )}
            >
              <input {...getInputProps()} />
              <input
                ref={directoryInputRef}
                type="file"
                multiple
                hidden
                {...({ webkitdirectory: "", directory: "" } as Record<
                  string,
                  string
                >)}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files || []);
                  if (files.length > 0) onAddAttachmentFiles(files);
                  event.currentTarget.value = "";
                }}
              />

              {selectedFileMentions.length > 0 ||
              selectedSkills.length > 0 ||
              selectedCommands.length > 0 ? (
                <div
                  className="-mt-0.5 mb-1.5 flex min-h-[26px] flex-wrap items-center gap-1.5 px-1"
                  aria-label={
                    t("input.selectedFilesAndSkills", {
                      defaultValue: "已选文件、技能与命令",
                    }) as string
                  }
                >
                  {selectedFileMentions.map((mention) => (
                    <span
                      key={mention.id || mention.path}
                      className="group/chip inline-flex min-h-7 max-w-full items-center gap-0 rounded-lg border border-[#d7d2fb] bg-[#f0edff] px-2.5 text-[12px] font-[650] leading-none text-[#544dbd] transition-colors duration-[120ms] hover:border-[#bdb5f2] hover:bg-[#e9e5ff] hover:text-[#433ba8] dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-200"
                    >
                      <span className="min-w-0 truncate">{mention.name}</span>
                      <button
                        type="button"
                        className="pointer-events-none ml-0 grid h-[18px] w-0 flex-[0_0_0] place-items-center overflow-hidden border-0 bg-transparent p-0 text-[18px] font-normal leading-none text-current opacity-0 outline-none transition-[width,flex-basis,margin-left,opacity] duration-[140ms] group-focus-within/chip:pointer-events-auto group-focus-within/chip:ml-1 group-focus-within/chip:w-[18px] group-focus-within/chip:flex-[0_0_18px] group-focus-within/chip:opacity-100 group-hover/chip:pointer-events-auto group-hover/chip:ml-1 group-hover/chip:w-[18px] group-hover/chip:flex-[0_0_18px] group-hover/chip:opacity-100"
                        aria-label={
                          t("input.removeSelectedFile", {
                            defaultValue: `删除 ${mention.name}`,
                          }) as string
                        }
                        title={
                          t("common.remove", { defaultValue: "删除" }) as string
                        }
                        onClick={() => onRemoveFileMention(mention.path)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {selectedSkills.map((skill) => (
                    <span
                      key={`${skill.slug}-${skill.command || ""}`}
                      className="group/chip inline-flex min-h-7 max-w-full items-center gap-0 rounded-lg border border-[#d7d2fb] bg-[#f0edff] px-2.5 text-[12px] font-[650] leading-none text-[#544dbd] transition-colors duration-[120ms] hover:border-[#bdb5f2] hover:bg-[#e9e5ff] hover:text-[#433ba8] dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-200"
                    >
                      <span className="min-w-0 truncate">
                        {skill.name || skill.slug}
                      </span>
                      <button
                        type="button"
                        className="pointer-events-none ml-0 grid h-[18px] w-0 flex-[0_0_0] place-items-center overflow-hidden border-0 bg-transparent p-0 text-[18px] font-normal leading-none text-current opacity-0 outline-none transition-[width,flex-basis,margin-left,opacity] duration-[140ms] group-focus-within/chip:pointer-events-auto group-focus-within/chip:ml-1 group-focus-within/chip:w-[18px] group-focus-within/chip:flex-[0_0_18px] group-focus-within/chip:opacity-100 group-hover/chip:pointer-events-auto group-hover/chip:ml-1 group-hover/chip:w-[18px] group-hover/chip:flex-[0_0_18px] group-hover/chip:opacity-100"
                        aria-label={
                          t("input.removeSelectedSkill", {
                            defaultValue: `删除 ${skill.name || skill.slug}`,
                          }) as string
                        }
                        title={
                          t("common.remove", { defaultValue: "删除" }) as string
                        }
                        onClick={() => onRemoveSkill(skill.slug, skill.command)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {selectedCommands.map((command) => (
                    <span
                      key={command.name}
                      className="group/chip inline-flex min-h-7 max-w-full items-center gap-0 rounded-lg border border-[#d7d2fb] bg-[#f0edff] px-2.5 text-[12px] font-[650] leading-none text-[#544dbd] transition-colors duration-[120ms] hover:border-[#bdb5f2] hover:bg-[#e9e5ff] hover:text-[#433ba8] dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-200"
                    >
                      <span className="min-w-0 truncate">{command.name}</span>
                      <button
                        type="button"
                        className="pointer-events-none ml-0 grid h-[18px] w-0 flex-[0_0_0] place-items-center overflow-hidden border-0 bg-transparent p-0 text-[18px] font-normal leading-none text-current opacity-0 outline-none transition-[width,flex-basis,margin-left,opacity] duration-[140ms] group-focus-within/chip:pointer-events-auto group-focus-within/chip:ml-1 group-focus-within/chip:w-[18px] group-focus-within/chip:flex-[0_0_18px] group-focus-within/chip:opacity-100 group-hover/chip:pointer-events-auto group-hover/chip:ml-1 group-hover/chip:w-[18px] group-hover/chip:flex-[0_0_18px] group-hover/chip:opacity-100"
                        aria-label={
                          t("input.removeSelectedCommand", {
                            defaultValue: `删除 ${command.name}`,
                          }) as string
                        }
                        title={
                          t("common.remove", { defaultValue: "删除" }) as string
                        }
                        onClick={() => onRemoveCommand(command.name)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <CommandMenu
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={onCommandSelect}
                onClose={onCloseCommandMenu}
                isOpen={isCommandMenuOpen}
                frequentCommands={frequentCommands}
                query={commandQuery}
                selectedCommands={selectedCommands}
                position={(() => {
                  const ta = textareaRef?.current;
                  if (!ta) return { top: 0, left: 0, bottom: 90 };
                  const rect = ta.getBoundingClientRect();
                  return {
                    top: rect.top - 8,
                    left: rect.left,
                    bottom: window.innerHeight - rect.top + 8,
                    width: rect.width,
                  };
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
                <div className="pd-composer-toolbar-left flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <div
                    onBlur={(event) => {
                      const nextTarget = event.relatedTarget as Node | null;
                      if (
                        !nextTarget ||
                        !event.currentTarget.contains(nextTarget)
                      ) {
                        setIsAddMenuOpen(false);
                      }
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsAddMenuOpen((open) => !open)}
                      className={cn(
                        "grid h-8 w-8 place-items-center rounded-full border border-[#b6b1e8] bg-[#faf9ff] p-0 text-[#5d57c5] transition-colors hover:border-[#7770da] hover:bg-[#efedff] hover:text-[#4943b6] dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
                        isAddMenuOpen &&
                          "border-[#7770da] bg-[#efedff] text-[#4943b6] dark:border-violet-500 dark:bg-violet-950/70 dark:text-violet-200",
                      )}
                      title={
                        t("input.addContext", {
                          defaultValue: "添加文件或技能",
                        }) as string
                      }
                      aria-label={
                        t("input.addContext", {
                          defaultValue: "添加文件或技能",
                        }) as string
                      }
                      aria-haspopup="menu"
                      aria-expanded={isAddMenuOpen}
                    >
                      <Plus className="h-[15px] w-[15px]" strokeWidth={1.8} />
                    </button>
                    {isAddMenuOpen ? (
                      <div
                        role="menu"
                        className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-xl border border-violet-200 bg-white p-2 text-left shadow-xl shadow-violet-950/10 dark:border-violet-900/70 dark:bg-neutral-900"
                      >
                        <div className="px-2 pb-1 text-[11px] font-medium text-neutral-400">
                          {t("input.add", { defaultValue: "添加" })}
                        </div>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setIsAddMenuOpen(false);
                            openImagePicker();
                          }}
                          className="grid w-full grid-cols-[minmax(90px,0.6fr)_minmax(0,1.4fr)] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[#343640] transition-colors hover:bg-[#f2f1f6] hover:text-[#302b8f] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200"
                        >
                          <span className="truncate text-[13px] font-medium text-inherit">
                            {t("input.files", { defaultValue: "文件" })}
                          </span>
                          <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                            {t("input.filesAndFoldersDescription", {
                              defaultValue: "添加本地内容作为任务上下文",
                            })}
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setIsAddMenuOpen(false);
                            directoryInputRef.current?.click();
                          }}
                          className="grid w-full grid-cols-[minmax(90px,0.6fr)_minmax(0,1.4fr)] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[#343640] transition-colors hover:bg-[#f2f1f6] hover:text-[#302b8f] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200"
                        >
                          <span className="truncate text-[13px] font-medium text-inherit">
                            {t("input.folders", { defaultValue: "文件夹" })}
                          </span>
                          <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                            {t("input.foldersDescription", {
                              defaultValue: "保留目录层级并上传全部内容",
                            })}
                          </span>
                        </button>
                        <div className="mt-1 px-2 py-1 text-[11px] font-medium text-neutral-400">
                          {t("input.skills", { defaultValue: "技能" })}
                        </div>
                        <div className="grid max-h-[172px] gap-0.5 overflow-y-auto [scrollbar-color:#cbc9d5_transparent] [scrollbar-width:thin]">
                          {isSkillsLoading ? (
                            <div className="flex items-center justify-center py-5 text-neutral-400">
                              <Loader2 className="h-4 w-4 animate-spin" />
                            </div>
                          ) : skills.length > 0 ? (
                            skills.map((skill) => {
                              const isSelected = selectedSkillKeys.has(
                                `${skill.slug}\u0000${skill.command || ""}`,
                              );
                              return (
                                <button
                                  key={`${skill.slug}-${skill.command || ""}`}
                                  type="button"
                                  role="menuitemcheckbox"
                                  aria-checked={isSelected}
                                  onClick={() => {
                                    onSelectSkill(skill);
                                    setIsAddMenuOpen(false);
                                  }}
                                  className={cn(
                                    "grid w-full grid-cols-[minmax(90px,0.6fr)_minmax(0,1.4fr)] gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[#343640] transition-colors hover:bg-[#f2f1f6] hover:text-[#302b8f] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                                    isSelected
                                      ? "bg-[#eeecff] text-[#393393] hover:bg-[#eeecff] dark:bg-violet-950/70 dark:text-violet-200 dark:hover:bg-violet-950/70"
                                      : "",
                                  )}
                                >
                                  <span className="truncate font-medium text-inherit">
                                    {renderMatchHighlights(
                                      skill.name || skill.slug,
                                      skillQuery,
                                    )}
                                  </span>
                                  <span className="truncate text-neutral-500">
                                    {renderMatchHighlights(
                                      skill.description || "",
                                      skillQuery,
                                    )}
                                  </span>
                                </button>
                              );
                            })
                          ) : (
                            <div className="px-3 py-4 text-center text-[12px] text-neutral-400">
                              {t("input.noSkills", {
                                defaultValue: "暂无可用技能",
                              })}
                            </div>
                          )}
                        </div>
                        <div className="relative mt-1">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
                          <input
                            type="search"
                            value={skillQuery}
                            onChange={(event) =>
                              setSkillQuery(event.target.value)
                            }
                            placeholder={
                              t("input.searchSkills", {
                                defaultValue: "检索技能",
                              }) as string
                            }
                            className="h-8 w-full rounded-lg border border-neutral-200 bg-[#f8f7fa] pl-8 pr-2 text-[12px] outline-none focus:border-violet-300 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-violet-700"
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div
                    className="relative"
                    onBlur={(event) => {
                      const nextTarget = event.relatedTarget as Node | null;
                      if (
                        !nextTarget ||
                        !event.currentTarget.contains(nextTarget)
                      ) {
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
                        "pd-composer-icon-button inline-flex h-8 min-w-28 max-w-[132px] items-center justify-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors sm:max-w-[190px]",
                        permissionSelectorDisabled
                          ? "cursor-not-allowed border-transparent text-neutral-400 opacity-45 dark:text-neutral-500"
                          : permissionMode === "bypassPermissions"
                            ? cn(
                                "border-[#efd39f] bg-[#fff8e8] text-[#ad620b] hover:border-[#e5b968] hover:bg-[#fff2d3]",
                                isPermissionMenuOpen &&
                                  "border-[#e5b968] bg-[#fff2d3]",
                                "dark:text-amber-300 dark:hover:border-amber-700 dark:hover:bg-amber-950/50",
                              )
                            : "border-[#ddd9f3] bg-[#f8f7ff] text-[#5d58b6] dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
                      )}
                      title={
                        t("input.permissions.change", {
                          defaultValue: "Select permission mode",
                        }) as string
                      }
                      aria-haspopup="menu"
                      aria-expanded={
                        permissionSelectorDisabled
                          ? false
                          : isPermissionMenuOpen
                      }
                    >
                      <SelectedPermissionIcon
                        className="block h-3 w-3 shrink-0"
                        strokeWidth={1.8}
                      />
                      <span className="pd-composer-permission-label truncate">
                        {selectedPermissionLabel}
                      </span>
                      <ChevronDown
                        className={cn(
                          "pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform",
                          isPermissionMenuOpen && "rotate-180",
                        )}
                        strokeWidth={2}
                      />
                    </button>
                    {isPermissionMenuOpen ? (
                      <div
                        role="menu"
                        className="absolute bottom-[44px] left-12 z-[80] w-[184px] rounded-[10px] border border-violet-200 bg-[rgba(255,255,255,.995)] p-[5px] text-left font-sans tracking-normal shadow-xl shadow-violet-950/10 [font-synthesis:none] dark:border-violet-900/70 dark:bg-neutral-900"
                      >
                        {PERMISSION_MODE_OPTIONS.map((option) => {
                          const Icon = option.Icon;
                          const isSelected = permissionMode === option.mode;
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
                                "relative grid min-h-10 w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center gap-[5px] rounded-[7px] border-0 bg-transparent px-2 py-1 text-left text-[#343640] transition-colors hover:bg-[#f7f6ff] dark:text-neutral-200 dark:hover:bg-violet-950/40",
                                isSelected &&
                                  option.mode === "bypassPermissions"
                                  ? "bg-[#fff2d8] text-[#b96708] hover:bg-[#fff2d8] dark:bg-amber-950/50 dark:text-amber-300 dark:hover:bg-amber-950/50"
                                  : isSelected
                                    ? "bg-[#eeecff] text-[#393393] hover:bg-[#eeecff] dark:bg-violet-950/70 dark:text-violet-200 dark:hover:bg-violet-950/70"
                                    : "",
                              )}
                            >
                              <Icon
                                className="h-3 w-3 shrink-0 text-current"
                                strokeWidth={1.8}
                              />
                              <span className="min-w-0">
                                <span className="block truncate text-[12px] font-semibold text-inherit">
                                  {label}
                                </span>
                                <span className="mt-0.5 block truncate text-[10px] text-[#9294a0] dark:text-neutral-400">
                                  {description}
                                </span>
                              </span>
                              {isSelected ? (
                                <Check
                                  className="h-3 w-3 shrink-0 text-current"
                                  strokeWidth={2}
                                />
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
                        ? t("input.queuedSendConfirmedInline", {
                            defaultValue: "Stopping current turn; sending next",
                          })
                        : t("input.queuedSendConfirmInline", {
                            defaultValue:
                              "Queued; click again to stop this turn and send now",
                          })}
                    </span>
                    <button
                      type="button"
                      onClick={onCancelBusySendQueue}
                      className="rounded-full px-2 py-1 text-amber-700 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
                      title={
                        t("input.cancelQueuedSend", {
                          defaultValue: "Cancel queued message",
                        }) as string
                      }
                    >
                      {t("input.cancelQueuedSendShort", {
                        defaultValue: "Cancel",
                      })}
                    </button>
                  </div>
                ) : null}

                <div className="pd-composer-toolbar-right ml-auto flex shrink-0 items-center gap-3">
                  <div
                    className="relative"
                    onBlur={(event) => {
                      const nextTarget = event.relatedTarget as Node | null;
                      if (
                        !nextTarget ||
                        !event.currentTarget.contains(nextTarget)
                      ) {
                        setIsModelMenuOpen(false);
                        setAdvancedModelId(null);
                      }
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setIsModelMenuOpen((open) => !open)}
                      className={cn(
                        "pd-composer-icon-button inline-flex h-8 max-w-[220px] items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-[13px] font-medium text-neutral-700 transition-colors hover:border-[#ddd9f2] hover:bg-[#f7f6ff] hover:text-[#4440a8] dark:text-neutral-200 dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                        isModelMenuOpen &&
                          "border-[#ddd9f2] bg-[#f7f6ff] text-[#4440a8] dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
                      )}
                      title={
                        t("input.models.change", {
                          defaultValue: "选择模型",
                        }) as string
                      }
                      aria-haspopup="dialog"
                      aria-expanded={isModelMenuOpen}
                    >
                      <span className="truncate">{selectedModelLabel}</span>
                      <ChevronDown
                        className={cn(
                          "pd-composer-control-chevron h-3.5 w-3.5 shrink-0 transition-transform",
                          isModelMenuOpen && "rotate-180",
                        )}
                        strokeWidth={2}
                      />
                    </button>
                    {isModelMenuOpen ? (
                      <div
                        role="dialog"
                        aria-label={
                          t("input.models.change", {
                            defaultValue: "选择模型",
                          }) as string
                        }
                        className="absolute bottom-full left-1/2 z-50 mb-2 w-64 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-visible rounded-xl border border-violet-200 bg-white text-left shadow-xl shadow-violet-950/10 dark:border-violet-900/70 dark:bg-neutral-900"
                      >
                        <div className="min-w-0 p-2">
                          <div className="relative mb-1.5">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
                            <input
                              type="search"
                              value={modelQuery}
                              onChange={(event) =>
                                setModelQuery(event.target.value)
                              }
                              placeholder={
                                t("input.models.search", {
                                  defaultValue: "搜索模型",
                                }) as string
                              }
                              className="h-8 w-full rounded-lg border border-neutral-200 bg-neutral-50 pl-8 pr-2 text-[12px] outline-none focus:border-violet-300 focus:bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-violet-700"
                              autoFocus
                            />
                          </div>
                          <div className="max-h-64 overflow-y-auto">
                            {isModelCatalogLoading ? (
                              <div className="flex justify-center py-8 text-neutral-400">
                                <Loader2 className="h-4 w-4 animate-spin" />
                              </div>
                            ) : modelCatalogError ? (
                              <div className="px-3 py-6 text-center text-[12px] text-red-500">
                                {modelCatalogError}
                              </div>
                            ) : filteredModels.length === 0 ? (
                              <div className="px-3 py-6 text-center text-[12px] text-neutral-400">
                                {t("input.models.empty", {
                                  defaultValue: "没有匹配的模型",
                                })}
                              </div>
                            ) : (
                              filteredModels.map((item) => {
                                const isAuto = item.id === "router/auto";
                                const isSelected = item.id === selectedModelId;
                                const hasAdvanced = Boolean(
                                  item.capabilities.reasoning ||
                                  item.capabilities.temperature,
                                );
                                return (
                                  <div
                                    key={item.id}
                                    className={cn(
                                      "group flex items-center rounded-lg text-[#343640] transition-colors hover:bg-[#f7f6ff] hover:text-[#373390] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                                      isSelected
                                        ? "bg-[#eeecff] font-[650] text-[#393393] hover:bg-[#eeecff] dark:bg-violet-950/70 dark:text-violet-200 dark:hover:bg-violet-950/70"
                                        : "",
                                      !item.available &&
                                        !isAuto &&
                                        "opacity-45",
                                    )}
                                  >
                                    <button
                                      type="button"
                                      disabled={!item.available}
                                      onClick={() => {
                                        onModelSelectionChange(
                                          isAuto
                                            ? { mode: "auto" }
                                            : {
                                                mode: "model",
                                                provider: item.provider,
                                                model: item.model,
                                              },
                                        );
                                        setIsModelMenuOpen(false);
                                        setAdvancedModelId(null);
                                      }}
                                      className="flex h-[27px] min-w-0 flex-1 items-center truncate border-0 bg-transparent pl-[9px] pr-0 text-left text-[12px] text-inherit"
                                      title={`${item.displayName} · ${item.provider}`}
                                    >
                                      {item.displayName}
                                    </button>
                                    {hasAdvanced ? (
                                      <button
                                        type="button"
                                        onMouseDown={(event) =>
                                          event.preventDefault()
                                        }
                                        onClick={() =>
                                          setAdvancedModelId((current) =>
                                            current === item.id
                                              ? null
                                              : item.id,
                                          )
                                        }
                                        className={cn(
                                          "mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-violet-100 hover:text-violet-700 dark:hover:bg-violet-950/60 dark:hover:text-violet-200",
                                          advancedModelId === item.id &&
                                            "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-200",
                                        )}
                                        title={
                                          t("input.models.advanced", {
                                            defaultValue: "高级设置",
                                          }) as string
                                        }
                                        aria-expanded={
                                          advancedModelId === item.id
                                        }
                                      >
                                        <ChevronRight
                                          className="h-3.5 w-3.5"
                                          strokeWidth={2}
                                        />
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                        {advancedModel ? (
                          <aside
                            aria-label={
                              t("input.models.advanced", {
                                defaultValue: "模型高级设置",
                              }) as string
                            }
                            className="absolute left-[calc(100%+8px)] top-6 w-[212px] min-w-[212px] overflow-hidden rounded-[10px] border border-violet-300 bg-white p-[9px] text-[#505260] shadow-xl shadow-violet-950/10 dark:border-violet-800 dark:bg-neutral-900 dark:text-neutral-300"
                          >
                            {advancedModel.capabilities.reasoning ? (
                              <div>
                                <h2 className="mb-1 text-[12px] font-bold text-[#454650] dark:text-neutral-100">
                                  {t("input.models.reasoning", {
                                    defaultValue: "推理强度",
                                  })}
                                </h2>
                                <div className="grid">
                                  {capabilityValues(
                                    advancedModel.capabilities.reasoning,
                                  ).map((value) => {
                                    const currentValue =
                                      modelSelection?.mode === "model" &&
                                      selectedModelId === advancedModel.id &&
                                      typeof modelSelection.reasoning ===
                                        "number"
                                        ? modelSelection.reasoning
                                        : undefined;
                                    return (
                                      <button
                                        key={value}
                                        type="button"
                                        onMouseDown={(event) =>
                                          event.preventDefault()
                                        }
                                        onClick={() =>
                                          onModelSelectionChange({
                                            mode: "model",
                                            provider: advancedModel.provider,
                                            model: advancedModel.model,
                                            reasoning: value,
                                            ...(modelSelection?.mode ===
                                              "model" &&
                                            selectedModelId ===
                                              advancedModel.id &&
                                            typeof modelSelection.temperature ===
                                              "number"
                                              ? {
                                                  temperature:
                                                    modelSelection.temperature,
                                                }
                                              : {}),
                                          })
                                        }
                                        className={cn(
                                          "grid h-[22px] grid-cols-[1fr_14px] items-center rounded-md border border-transparent px-[7px] text-left text-[11px] text-[#595b67] transition-colors hover:border-[#e4e0fb] hover:bg-[#f7f6ff] hover:text-[#4742a9] dark:text-neutral-300 dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                                          currentValue === value
                                            ? "border-[#d6d1ff] bg-[#eeecff] font-[650] text-[#393393] hover:border-[#d6d1ff] hover:bg-[#eeecff] dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-200"
                                            : "",
                                        )}
                                      >
                                        <span>
                                          {REASONING_LABELS.get(value) || value}
                                        </span>
                                        {currentValue === value ? (
                                          <Check
                                            className="h-[9px] w-[9px]"
                                            strokeWidth={2}
                                          />
                                        ) : null}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null}
                            {advancedModel.capabilities.temperature
                              ? (() => {
                                  const capability =
                                    advancedModel.capabilities.temperature;
                                  const values = capabilityValues(capability);
                                  const savedValue =
                                    modelSelection?.mode === "model" &&
                                    selectedModelId === advancedModel.id &&
                                    typeof modelSelection.temperature ===
                                      "number"
                                      ? modelSelection.temperature
                                      : undefined;
                                  const currentValue = savedValue ?? values[0];
                                  const rangeMin = capability.min ?? 0;
                                  const rangeMax = capability.max ?? 1;
                                  const temperaturePercent =
                                    currentValue !== undefined &&
                                    rangeMax > rangeMin
                                      ? Math.min(
                                          100,
                                          Math.max(
                                            0,
                                            ((currentValue - rangeMin) /
                                              (rangeMax - rangeMin)) *
                                              100,
                                          ),
                                        )
                                      : 0;
                                  const updateTemperature = (
                                    temperature: number,
                                  ) =>
                                    onModelSelectionChange({
                                      mode: "model",
                                      provider: advancedModel.provider,
                                      model: advancedModel.model,
                                      ...(modelSelection?.mode === "model" &&
                                      selectedModelId === advancedModel.id &&
                                      typeof modelSelection.reasoning ===
                                        "number"
                                        ? {
                                            reasoning: modelSelection.reasoning,
                                          }
                                        : {}),
                                      temperature,
                                    });

                                  return (
                                    <div
                                      className={cn(
                                        advancedModel.capabilities.reasoning
                                          ? "mt-2 border-t border-[#e7e4f1] pt-2 dark:border-neutral-800"
                                          : "",
                                      )}
                                    >
                                      <h2 className="mb-2 text-[12px] font-bold text-[#454650] dark:text-neutral-100">
                                        {t("input.models.temperature", {
                                          defaultValue: "温度",
                                        })}
                                      </h2>
                                      {capability.type === "enum" ? (
                                        <div className="grid">
                                          {values.map((value) => (
                                            <button
                                              key={value}
                                              type="button"
                                              onMouseDown={(event) =>
                                                event.preventDefault()
                                              }
                                              onClick={() =>
                                                updateTemperature(value)
                                              }
                                              className={cn(
                                                "grid h-[22px] grid-cols-[1fr_14px] items-center rounded-md border border-transparent px-[7px] text-left text-[11px] text-[#595b67] transition-colors hover:border-[#e4e0fb] hover:bg-[#f7f6ff] hover:text-[#4742a9] dark:text-neutral-300 dark:hover:border-violet-800 dark:hover:bg-violet-950/40 dark:hover:text-violet-200",
                                                currentValue === value
                                                  ? "border-[#d6d1ff] bg-[#eeecff] font-[650] text-[#393393] hover:border-[#d6d1ff] hover:bg-[#eeecff] dark:border-violet-700 dark:bg-violet-950/70 dark:text-violet-200"
                                                  : "",
                                              )}
                                            >
                                              <span>{value}</span>
                                              {currentValue === value ? (
                                                <Check
                                                  className="h-[9px] w-[9px]"
                                                  strokeWidth={2}
                                                />
                                              ) : null}
                                            </button>
                                          ))}
                                        </div>
                                      ) : currentValue !== undefined ? (
                                        <div className="grid grid-cols-[minmax(0,1fr)_28px] items-center gap-[7px] px-[7px] pb-[3px] pt-0.5">
                                          <input
                                            type="range"
                                            min={capability.min}
                                            max={capability.max}
                                            step={capability.step}
                                            value={currentValue}
                                            aria-label={
                                              t("input.models.temperature", {
                                                defaultValue: "温度",
                                              }) as string
                                            }
                                            onChange={(event) =>
                                              updateTemperature(
                                                Number(event.target.value),
                                              )
                                            }
                                            style={
                                              {
                                                "--temperature": `${temperaturePercent}%`,
                                              } as CSSProperties
                                            }
                                            className="temperature-range m-0 h-4 w-full min-w-0 appearance-none bg-transparent [--temperature:30%] [&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[#665ee8] [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[#dedbea] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,#665ee8_0%,#665ee8_var(--temperature),#dedbea_var(--temperature),#dedbea_100%)]"
                                          />
                                          <output className="text-right text-[9.5px] font-semibold tabular-nums text-[#686b7b]">
                                            {currentValue.toFixed(1)}
                                          </output>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })()
                              : null}
                          </aside>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {showAbortButton ? (
                    <button
                      type="button"
                      onClick={onAbortSession}
                      disabled={isAbortPending}
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600",
                        isAbortPending &&
                          "cursor-wait opacity-70 hover:bg-red-500",
                      )}
                      title={
                        isAbortPending
                          ? (t("input.stopping", {
                              defaultValue: "Stopping...",
                            }) as string)
                          : (t("input.stop", {
                              defaultValue: "Stop",
                            }) as string)
                      }
                    >
                      {isAbortPending ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          strokeWidth={2.25}
                        />
                      ) : (
                        <Square
                          className="h-3.5 w-3.5"
                          strokeWidth={2.5}
                          fill="currentColor"
                        />
                      )}
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    disabled={disabled}
                    aria-label={sendTitle}
                    aria-busy={
                      isSubmitPending ||
                      hasUploadingImages ||
                      isBusySendConfirmed
                    }
                    className={cn(
                      "home-send-button disabled:opacity-40",
                      isBusySendQueued &&
                        "bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-400 dark:text-neutral-950 dark:hover:bg-amber-300",
                      isBusySendConfirmed && "cursor-wait",
                      (isSubmitPending || hasUploadingImages) && "cursor-wait",
                    )}
                    title={sendTitle}
                  >
                    {isSubmitPending || hasUploadingImages ? (
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        strokeWidth={2.25}
                      />
                    ) : isBusySendConfirmed ? (
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        strokeWidth={2.25}
                      />
                    ) : isBusySendQueued ? (
                      <Check className="h-4 w-4" strokeWidth={2.25} />
                    ) : (
                      <svg
                        aria-hidden="true"
                        className="icon"
                        fill="none"
                        height="18"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.8"
                        viewBox="0 0 24 24"
                        width="18"
                      >
                        <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
                        <path d="m21.854 2.147-10.94 10.939" />
                      </svg>
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
