import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, Check, ChevronRight, Copy, FileText, GitBranch, Loader2 } from 'lucide-react';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useTypewriter } from './useTypewriter';
import type { Project, SessionProvider } from '../../types/app';
import type {
  ChatMessage,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import MessageComponent from '../chat/view/subcomponents/MessageComponent';
import ImageLightbox, { type LightboxImage } from '../chat/view/subcomponents/ImageLightbox';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { formatUsageLimitText } from '../chat/utils/chatFormatting';
import { ProcessTrace } from './ProcessTrace';
import { processSummaryToTrace, type ProcessAttachment } from './processGrouping';
import SubagentCard from './SubagentCard';

type DiffLine = { type: string; content: string; lineNum: number };

const MIME_FRIENDLY_LABELS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/msword': 'DOC',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
  'application/json': 'JSON',
};

const getAttachmentTypeLabel = (name?: string, mimeType?: string): string => {
  const ext = String(name || '').split('.').pop()?.toUpperCase();
  if (ext && ext !== String(name || '').toUpperCase()) return ext;
  if (mimeType) {
    const friendly = MIME_FRIENDLY_LABELS[mimeType.toLowerCase()];
    if (friendly) return friendly;
    if (mimeType.includes('/')) {
      const sub = mimeType.split('/').pop() || '';
      if (sub.length <= 10 && !sub.includes('.')) return sub.toUpperCase();
    }
  }
  return 'FILE';
};

const getAttachmentAccent = (name?: string, mimeType?: string): string => {
  const label = getAttachmentTypeLabel(name, mimeType).toLowerCase();
  if (label === 'pdf') return 'bg-red-500 text-white';
  if (label === 'doc' || label === 'docx') return 'bg-blue-500 text-white';
  if (label === 'xls' || label === 'xlsx' || label === 'csv') return 'bg-emerald-500 text-white';
  if (label === 'ppt' || label === 'pptx') return 'bg-orange-500 text-white';
  return 'bg-neutral-500 text-white';
};

type MessageRowV2Props = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  nextMessage?: ChatMessage | null;
  beforeProcessAttachments?: ProcessAttachment[];
  afterProcessAttachments?: ProcessAttachment[];
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: PilotDeckPermissionSuggestion,
  ) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  onOpenSubagentDetail?: (subagentId: string) => void;
  activeSessionId?: string;
  subagentActivityById?: Map<string, ChatMessage>;
  subagentThinkingById?: Map<string, string>;
  isSessionRunning?: boolean;
  onFork?: (params: { projectName: string; sessionId: string }) => void;
  // sessionId for the currently active session — the parent (MessagesPaneV2)
  // passes this in because ChatMessage doesn't carry it.
  activeSessionId?: string;
};

// Fall back to the heavy legacy renderer for anything that isn't a vanilla
// user/assistant markdown message — tool invocations, diffs, permission
// prompts, task notifications, subagent containers, etc. live there and we
// don't want to re-implement them all.
const shouldDelegate = (message: ChatMessage): boolean => {
  if (message.isSubagentContainer) return false;
  if (message.isToolUse) return true;
  if (message.isInteractivePrompt) return true;
  if (message.isTaskNotification) return true;
  const t = message.type;
  if (t !== 'user' && t !== 'assistant' && t !== 'error') return true;
  return false;
};

function MessageRowV2({
  message,
  prevMessage,
  nextMessage,
  beforeProcessAttachments = [],
  afterProcessAttachments = [],
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantSessionToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  isProcessExpanded,
  onProcessExpandedChange,
  onOpenSubagentDetail,
  subagentActivityById,
  subagentThinkingById,
  isSessionRunning,
  onFork,
  activeSessionId,
}: MessageRowV2Props) {
  const { t } = useTranslation('chat');
  const delegate = useMemo(() => shouldDelegate(message), [message]);

  const formattedContent = useMemo(
    () => formatUsageLimitText(String(message.content ?? '')),
    [message.content],
  );
  const thinkingDisplayText = useTypewriter(formattedContent, !!message.isStreaming && !!message.isThinking, 4);
  const contentDisplayText = useTypewriter(formattedContent, !!message.isStreaming && !message.isThinking, 6);
  const messageImages = useMemo(
    () =>
      Array.isArray(message.images)
        ? message.images.filter((image) => image && typeof image.data === 'string')
        : [],
    [message.images],
  );
  const messageAttachments = useMemo(
    () =>
      Array.isArray(message.attachments)
        ? message.attachments.filter((attachment) => attachment && typeof attachment.name === 'string')
        : [],
    [message.attachments],
  );

  if (message.isAgentActivitySummary) {
    return (
      <ProcessSummaryRow
        message={message}
        processKey={message.id || message.runId || message.activityId}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={onProcessExpandedChange}
        t={t}
      />
    );
  }

  const renderProcessAttachment = (attachment: ProcessAttachment) => (
    <ProcessAttachmentRow
      key={attachment.id}
      attachment={attachment}
      renderDetail={(detailMessage, index) => (
        <MessageRowV2
          key={detailMessage.id || detailMessage.toolId || `${attachment.id || 'process-detail'}-${index}`}
          message={detailMessage}
          prevMessage={index > 0 ? attachment.processDetailMessages[index - 1] : null}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={onGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          isProcessExpanded={isProcessExpanded}
          onProcessExpandedChange={onProcessExpandedChange}
          onOpenSubagentDetail={onOpenSubagentDetail}
          subagentActivityById={subagentActivityById}
        />
      )}
      isProcessExpanded={isProcessExpanded}
      onProcessExpandedChange={onProcessExpandedChange}
      t={t}
    />
  );

  const withProcessRows = (content: ReactNode) => {
    if (beforeProcessAttachments.length === 0 && afterProcessAttachments.length === 0) {
      return content;
    }

    return (
      <div className="flex min-w-0 flex-col gap-2">
        {beforeProcessAttachments.map(renderProcessAttachment)}
        {content}
        {afterProcessAttachments.map(renderProcessAttachment)}
      </div>
    );
  };

  if (message.isSubagentContainer) {
    const subagentId = typeof message.subagentId === 'string' ? message.subagentId : '';
    const liveActivity = subagentId ? subagentActivityById?.get(subagentId) : undefined;
    const thinkingContent = subagentId ? subagentThinkingById?.get(subagentId) : undefined;
    return withProcessRows(
      <SubagentCard message={message} liveActivity={liveActivity} onOpenDetail={onOpenSubagentDetail} thinkingContent={thinkingContent} isSessionRunning={isSessionRunning} />,
    );
  }

  if (delegate) {
    return withProcessRows(
      <div className="ui-v2-legacy-row">
        <MessageComponent
          message={message}
          prevMessage={prevMessage}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantSessionToolPermission={onGrantSessionToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject ?? null}
          provider={provider}
          hideHeader
        />
      </div>,
    );
  }

  const isUser = message.type === 'user';
  const isError = message.type === 'error';
  const [userImageLightbox, setUserImageLightbox] = useState<number | null>(null);

  // User: right-aligned grey bubble.
  if (isUser) {
    const lightboxImages: LightboxImage[] = messageImages.map((image) => ({
      data: image.data,
      name: image.name,
      mimeType: image.mimeType,
    }));
    return withProcessRows(
      <div className="flex w-full justify-end">
        <div className="min-w-0 max-w-[78%] overflow-hidden rounded-[22px] bg-neutral-100 px-4 py-2.5 text-[14px] leading-relaxed text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
          {message.isStreaming && !formattedContent ? (
            <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
          ) : (
            <>
              {messageAttachments.length > 0 ? (
                <div className={formattedContent ? 'mb-2 grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-2'}>
                  {messageAttachments.map((attachment, index) => (
                    <div
                      key={`${attachment.name || 'attachment'}-${index}`}
                      className="flex min-w-0 items-center gap-3 rounded-2xl bg-white/85 p-2.5 pr-3 dark:bg-neutral-900/45"
                    >
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${getAttachmentAccent(
                          attachment.name,
                          attachment.mimeType,
                        )}`}
                      >
                        <FileText className="h-5 w-5" strokeWidth={2} />
                      </div>
                      <div className="min-w-0 text-left">
                        <div className="truncate text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                          {attachment.name}
                        </div>
                        <div className="mt-0.5 text-[11px] font-medium uppercase text-neutral-500 dark:text-neutral-400">
                          {getAttachmentTypeLabel(attachment.name, attachment.mimeType)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {messageImages.length > 0 ? (
                <div className={formattedContent ? 'mb-2 grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-2'}>
                  {messageImages.map((image, index) => (
                    <button
                      type="button"
                      key={`${image.name || 'image'}-${index}`}
                      onClick={() => setUserImageLightbox(index)}
                      className="block w-72 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900/40"
                      aria-label={image.name ? `Preview ${image.name}` : 'Preview image'}
                    >
                      <img
                        src={image.data}
                        alt={image.name || 'Uploaded image'}
                        className="block h-auto max-h-64 w-full cursor-zoom-in object-contain transition-opacity hover:opacity-90"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
              {formattedContent ? (
                <Markdown className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-p:my-1 prose-ol:my-1 prose-ul:my-1 prose-li:my-0 min-w-0 break-words [overflow-wrap:anywhere]" projectName={selectedProject?.name}>{formattedContent}</Markdown>
              ) : null}
              {formattedContent.trim() ? (
                <div className="mt-1.5 flex justify-end gap-1">
                  <ForkFromHereButton
                    messageType={message.type}
                    onFork={onFork}
                    projectName={selectedProject?.name ?? ''}
                    sessionId={activeSessionId ?? ''}
                    entryId={message.entryId ?? message.id ?? ''}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
        {userImageLightbox !== null && lightboxImages.length > 0 ? (
          <ImageLightbox
            images={lightboxImages}
            startIndex={userImageLightbox}
            onClose={() => setUserImageLightbox(null)}
          />
        ) : null}
      </div>,
    );
  }

  // Error: full-width red banner with warning glyph.
  if (isError) {
    return withProcessRows(
      <div className="flex gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
          <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-red-500">
          <Markdown projectName={selectedProject?.name}>{formattedContent}</Markdown>
        </div>
      </div>,
    );
  }

  if (message.isThinking) {
    if (!showThinking) return null;
    const isThinkingStreaming = !!message.isStreaming;

    if (inlineThinking) {
      // Inline mode: unified <details> with typewriter animation + blue theme
      return withProcessRows(
        <div className="min-w-0 text-[14px] leading-relaxed">
          <details className="group" open={(isThinkingStreaming ? thinkingDisplayText.length > 12 : false) || undefined}>
            <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-blue-600/70 hover:text-blue-700 dark:text-blue-400/70 dark:hover:text-blue-300">
              {isThinkingStreaming
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                : <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />}
              <span>
                {isThinkingStreaming
                  ? t('thinking.title', { defaultValue: 'Thinking...' })
                  : t('thinking.completed', { defaultValue: 'Thought process' })}
              </span>
            </summary>
            <div className={`mt-1.5 max-h-64 overflow-y-auto border-l-2 pl-3 text-[13px] ${
              isThinkingStreaming
                ? 'border-blue-400/50 text-neutral-600 dark:border-blue-500/40 dark:text-neutral-300'
                : 'border-blue-400/30 text-neutral-600 dark:border-blue-500/30 dark:text-neutral-400'
            }`}>
              <Markdown projectName={selectedProject?.name} isStreaming={isThinkingStreaming}>
                {isThinkingStreaming ? thinkingDisplayText : formattedContent}
              </Markdown>
            </div>
          </details>
        </div>,
      );
    }

    // Default (status-bar preview mode): simple collapsible accordion
    return withProcessRows(
      <div className="min-w-0 text-[14px] leading-relaxed">
        <details className="group">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
            <span>{t('thinking.completed', { defaultValue: 'Thought process' })}</span>
          </summary>
          <div className="mt-1.5 max-h-64 overflow-y-auto border-l-2 border-neutral-300 pl-3 text-[13px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            <Markdown projectName={selectedProject?.name}>{formattedContent}</Markdown>
          </div>
        </details>
      </div>,
    );
  }

  // Assistant: plain prose, no avatar and no bubble.
  return withProcessRows(
    <div className="min-w-0 text-[14px] leading-relaxed text-neutral-900 dark:text-neutral-100">
      {message.isStreaming && !contentDisplayText ? (
        <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
      ) : (
        <>
          <Markdown className="prose prose-sm prose-neutral max-w-none dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-pre:my-3 prose-ol:my-2 prose-ul:my-2 prose-table:my-0 prose-hr:my-4" projectName={selectedProject?.name} isStreaming={message.isStreaming}>{contentDisplayText}</Markdown>
          {formattedContent.trim() &&
           (!nextMessage || nextMessage.type === 'user' || nextMessage.type === 'error') ? (
            <div className="mt-1.5 flex justify-end gap-1">
              <CopyMarkdownButton content={formattedContent} />
              <ForkFromHereButton
                messageType={message.type}
                onFork={onFork}
                projectName={selectedProject?.name ?? ''}
                sessionId={activeSessionId ?? ''}
                entryId={message.entryId ?? message.id ?? ''}
              />
            </div>
          ) : null}
        </>
      )}
    </div>,
  );
}

function ForkFromHereButton({
  messageType,
  onFork,
  projectName,
  sessionId,
  entryId,
}: {
  messageType: string;
  onFork?: (params: { projectName: string; sessionId: string; entryId: string }) => void;
  projectName: string;
  sessionId: string;
  entryId: string;
}) {
  // Disabled when project / session / entryId / callback is missing.
  // Without an entryId the server would default to copying the whole
  // conversation, which is the bug we're fixing here.
  const disabled = !onFork || !projectName || !sessionId || !entryId;
  const tooltip = disabled
    ? 'Fork not available here'
    : 'Fork this conversation from this turn';

  // aria-label stays short ("Fork this conversation") so existing E2E
  // selectors match verbatim. Tooltip above gives the more descriptive
  // copy on hover.
  const ariaLabel = 'Fork this conversation';

  const handleClick = () => {
    if (disabled || !onFork) return;
    onFork({ projectName, sessionId, entryId });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 disabled:opacity-50"
      aria-label={ariaLabel}
      title={tooltip}
    >
      <GitBranch className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  );
}

function CopyMarkdownButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = async () => {
    const ok = await copyTextToClipboard(content);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
      aria-label={copied ? 'Copied' : 'Copy'}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
    </button>
  );
}

export default memo(MessageRowV2);

function ProcessSummaryRow({
  message,
  processKey,
  detailMessages = [],
  renderDetailMessage,
  isProcessExpanded,
  onProcessExpandedChange,
  t,
}: {
  message: ChatMessage;
  processKey?: string;
  detailMessages?: ChatMessage[];
  renderDetailMessage?: (message: ChatMessage, index: number) => ReactNode;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  t: TFunction<'chat'>;
}) {
  const trace = useMemo(() => processSummaryToTrace(message, t), [message, t]);
  const detailSteps = detailMessages.length > 0 && renderDetailMessage ? [] : trace.steps;
  const resolvedProcessKey = processKey || message.id || message.runId || message.activityId;
  const expanded = resolvedProcessKey
    ? isProcessExpanded?.(resolvedProcessKey, false)
    : undefined;

  return (
    <ProcessTrace
      label={trace.label}
      collapsedDetail={trace.collapsedDetail}
      statusLabel={trace.statusLabel}
      status={trace.status}
      metrics={trace.metrics}
      steps={detailSteps}
      expanded={expanded}
      onExpandedChange={resolvedProcessKey
        ? (nextExpanded) => onProcessExpandedChange?.(resolvedProcessKey, nextExpanded)
        : undefined}
    >
      {detailMessages.length > 0 && renderDetailMessage
        ? detailMessages.map((detailMessage, index) =>
            renderDetailMessage(detailMessage, index),
          )
        : null}
    </ProcessTrace>
  );
}

function ProcessAttachmentRow({
  attachment,
  renderDetail,
  isProcessExpanded,
  onProcessExpandedChange,
  t,
}: {
  attachment: ProcessAttachment;
  renderDetail: (message: ChatMessage, index: number) => ReactNode;
  isProcessExpanded?: (processKey: string, defaultExpanded?: boolean) => boolean;
  onProcessExpandedChange?: (processKey: string, expanded: boolean) => void;
  t: TFunction<'chat'>;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxImages: LightboxImage[] = useMemo(
    () =>
      attachment.inlineImages.map((image) => ({
        data: image.data,
        name: image.name,
        mimeType: image.mimeType,
      })),
    [attachment.inlineImages],
  );

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <ProcessSummaryRow
        message={attachment.processSummary}
        processKey={attachment.id}
        detailMessages={attachment.processDetailMessages}
        renderDetailMessage={renderDetail}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={onProcessExpandedChange}
        t={t}
      />
      {lightboxImages.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-2">
          {lightboxImages.map((image, idx) => (
            <button
              type="button"
              key={`${attachment.inlineImages[idx].toolId || 'tool-image'}-${idx}`}
              onClick={() => setLightboxIndex(idx)}
              className="block overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
              aria-label={image.name ? `Preview ${image.name}` : 'Preview image'}
            >
              <img
                src={image.data}
                alt={image.name || 'Tool result image'}
                className="block h-auto max-h-72 max-w-xs cursor-zoom-in object-contain"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
      {lightboxIndex !== null && lightboxImages.length > 0 ? (
        <ImageLightbox
          images={lightboxImages}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </div>
  );
}
