import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import type {
  ChatMessage,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import MessageComponent from '../chat/view/subcomponents/MessageComponent';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { formatUsageLimitText } from '../chat/utils/chatFormatting';
import { ProcessTrace } from './ProcessTrace';
import { processSummaryToTrace, type ProcessAttachment } from './processGrouping';

type DiffLine = { type: string; content: string; lineNum: number };

type MessageRowV2Props = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
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
};

// Fall back to the heavy legacy renderer for anything that isn't a vanilla
// user/assistant markdown message — tool invocations, diffs, permission
// prompts, task notifications, subagent containers, etc. live there and we
// don't want to re-implement them all.
const shouldDelegate = (message: ChatMessage): boolean => {
  if (message.isToolUse) return true;
  if (message.isInteractivePrompt) return true;
  if (message.isSubagentContainer) return true;
  if (message.isTaskNotification) return true;
  const t = message.type;
  if (t !== 'user' && t !== 'assistant' && t !== 'error') return true;
  return false;
};

function MessageRowV2({
  message,
  prevMessage,
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
}: MessageRowV2Props) {
  const { t } = useTranslation('chat');
  const delegate = useMemo(() => shouldDelegate(message), [message]);

  const formattedContent = useMemo(
    () => formatUsageLimitText(String(message.content ?? '')),
    [message.content],
  );

  if (message.isAgentActivitySummary) {
    return (
      <ProcessSummaryRow
        message={message}
        t={t}
      />
    );
  }

  const renderProcessAttachment = (attachment: ProcessAttachment) => (
    <ProcessSummaryRow
      key={attachment.id}
      message={attachment.processSummary}
      detailMessages={attachment.processDetailMessages}
      renderDetailMessage={(detailMessage, index) => (
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
        />
      )}
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

  // User: right-aligned grey bubble.
  if (isUser) {
    const userImages = Array.isArray(message.images)
      ? message.images.filter((img) => img && typeof img.data === 'string')
      : [];
    return withProcessRows(
      <div className="flex w-full justify-end">
        <div className="min-w-0 max-w-[78%] overflow-hidden rounded-[22px] bg-neutral-100 px-4 py-2.5 text-[14px] leading-relaxed text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
          {userImages.length > 0 && (
            <div className="mb-2 grid grid-cols-2 gap-2">
              {userImages.map((img, idx) => (
                <img
                  key={img.name || idx}
                  src={img.data}
                  alt={img.name || ''}
                  className="h-auto max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                  onClick={() => window.open(img.data, '_blank')}
                />
              ))}
            </div>
          )}
          {message.isStreaming && !formattedContent ? (
            <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
          ) : formattedContent ? (
            <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {formattedContent}
            </div>
          ) : null}
        </div>
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
          <Markdown>{formattedContent}</Markdown>
        </div>
      </div>,
    );
  }

  // Thinking: collapsible accordion
  if (message.isThinking) {
    return withProcessRows(
      <div className="min-w-0 text-[14px] leading-relaxed">
        <details className="group">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
            <span>{t('thinking.title', { defaultValue: 'Thinking...' })}</span>
          </summary>
          <div className="mt-1.5 border-l-2 border-neutral-300 pl-3 text-[13px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            <Markdown>{formattedContent}</Markdown>
          </div>
        </details>
      </div>,
    );
  }

  // Assistant: plain prose, no avatar and no bubble.
  return withProcessRows(
    <div className="min-w-0 text-[14px] leading-relaxed text-neutral-900 dark:text-neutral-100">
      {message.isStreaming && !formattedContent ? (
        <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 dark:bg-neutral-500" />
      ) : (
        <Markdown>{formattedContent}</Markdown>
      )}
    </div>,
  );
}

export default memo(MessageRowV2);

function ProcessSummaryRow({
  message,
  detailMessages = [],
  renderDetailMessage,
  t,
}: {
  message: ChatMessage;
  detailMessages?: ChatMessage[];
  renderDetailMessage?: (message: ChatMessage, index: number) => ReactNode;
  t: TFunction<'chat'>;
}) {
  const trace = useMemo(() => processSummaryToTrace(message, t), [message, t]);
  const detailSteps = detailMessages.length > 0 && renderDetailMessage ? [] : trace.steps;

  return (
    <ProcessTrace
      label={trace.label}
      collapsedDetail={trace.collapsedDetail}
      statusLabel={trace.statusLabel}
      status={trace.status}
      metrics={trace.metrics}
      steps={detailSteps}
    >
      {detailMessages.length > 0 && renderDetailMessage
        ? detailMessages.map((detailMessage, index) =>
            renderDetailMessage(detailMessage, index),
          )
        : null}
    </ProcessTrace>
  );
}
