import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Search, Settings } from 'lucide-react';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type {
  ChatMessage,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
  Provider,
} from '../../types/types';
import { formatUsageLimitText } from '../../utils/chatFormatting';
import { getPilotDeckPermissionSuggestion } from '../../utils/chatPermissions';
import type { Project } from '../../../../types/app';
import { ToolRenderer, shouldHideToolResult } from '../../tools';
import { CollapsibleDisplay } from '../../tools/components';
import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (suggestion: PilotDeckPermissionSuggestion) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
  hideHeader?: boolean;
};

type InteractiveOption = {
  number: string;
  text: string;
  isSelected: boolean;
};

type PermissionGrantState = 'idle' | 'granted' | 'error';

const stringifyMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try {
    return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  } catch {
    return String(content);
  }
};

function cleanToolUseErrorContent(content: unknown): string {
  return stringifyMessageContent(content)
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/^InputValidationError:\s*/i, '')
    .trim();
}

function isRecoverableToolUseError(content: unknown): boolean {
  const text = stringifyMessageContent(content);
  if (!text.includes('<tool_use_error>')) return false;

  const lower = text.toLowerCase();
  const looksLikePermissionError =
    lower.includes('permission') &&
    (lower.includes('denied') || lower.includes('not allowed') || lower.includes('requires') || lower.includes('grant'));

  return !looksLikePermissionError;
}

function isWebSearchNotConfiguredError(toolName: string | undefined, content: unknown): boolean {
  const name = (toolName ?? '').toLowerCase();
  if (name !== 'web_search' && name !== 'websearch') return false;
  const text = stringifyMessageContent(content).toLowerCase();
  return (
    text.includes('not configured') ||
    text.includes('unsupported_tool') ||
    text.includes('token expired') ||
    text.includes('token invalid') ||
    text.includes('invalid api key') ||
    text.includes('invalid key') ||
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text)
  );
}

function getAttachmentTypeLabel(name?: string, mimeType?: string): string {
  const ext = String(name || '').split('.').pop()?.toUpperCase();
  if (ext && ext !== String(name || '').toUpperCase()) return ext;
  if (mimeType?.includes('/')) return mimeType.split('/').pop()?.toUpperCase() || 'FILE';
  return 'FILE';
}

function getAttachmentAccent(name?: string, mimeType?: string): string {
  const label = getAttachmentTypeLabel(name, mimeType).toLowerCase();
  if (label === 'pdf') return 'bg-red-500 text-white';
  if (label === 'doc' || label === 'docx') return 'bg-blue-500 text-white';
  if (label === 'xls' || label === 'xlsx' || label === 'csv') return 'bg-emerald-500 text-white';
  if (label === 'ppt' || label === 'pptx') return 'bg-orange-500 text-white';
  return 'bg-neutral-500 text-white';
}

const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, onShowSettings, onGrantSessionToolPermission, autoExpandTools, showRawParameters, showThinking, selectedProject, provider, hideHeader = false }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const permissionSuggestion = getPilotDeckPermissionSuggestion(message, provider);
  const [permissionGrantState, setPermissionGrantState] = useState<PermissionGrantState>('idle');
  const messageContent = stringifyMessageContent(message.content);
  const messageImages = Array.isArray(message.images)
    ? message.images.filter((image) => image && typeof image.data === 'string')
    : [];
  const messageAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment) => attachment && typeof attachment.name === 'string')
    : [];
  const toolResultImages: LightboxImage[] = useMemo(
    () => {
      const list = (message.toolResult?.images ?? []) as Array<{ data?: unknown; name?: unknown; mimeType?: unknown }>;
      return list
        .filter((image) => image && typeof image.data === 'string' && image.data.length > 0)
        .map((image) => ({
          data: image.data as string,
          name: typeof image.name === 'string' ? image.name : undefined,
          mimeType: typeof image.mimeType === 'string' ? image.mimeType : undefined,
        }));
    },
    [message.toolResult],
  );
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const openLightbox = (images: LightboxImage[], index: number) => setLightbox({ images, index });
  const closeLightbox = () => setLightbox(null);
  const userCopyContent = messageContent;
  const formattedMessageContent = useMemo(
    () => formatUsageLimitText(messageContent),
    [messageContent]
  );
  const assistantCopyContent = message.isToolUse
    ? stringifyMessageContent(message.displayText || message.content)
    : formattedMessageContent;
  const shouldShowUserCopyControl = message.type === 'user' && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !message.isToolUse;


  useEffect(() => {
    setPermissionGrantState('idle');
  }, [permissionSuggestion?.entry, message.toolId]);

  useEffect(() => {
    const node = messageRef.current;
    if (!autoExpandTools || !node || !message.isToolUse) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isExpanded) {
            setIsExpanded(true);
            const details = node.querySelectorAll<HTMLDetailsElement>('details:not([data-auto-expand="false"])');
            details.forEach((detail) => {
              detail.open = true;
            });
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(node);

    return () => {
      observer.unobserve(node);
    };
  }, [autoExpandTools, isExpanded, message.isToolUse]);

  const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);

  if (shouldHideThinkingMessage) {
    return null;
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${message.type === 'user' ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {message.type === 'user' ? (
        /* User message bubble on the right */
        <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className="group flex-1 rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4">
            {messageAttachments.length > 0 && (
              <div className="mb-2 grid grid-cols-1 gap-2">
                {messageAttachments.map((attachment, idx) => (
                  <div
                    key={`${attachment.name || 'attachment'}-${idx}`}
                    className="flex min-w-0 items-center gap-3 rounded-2xl bg-white/90 p-2.5 pr-3 text-neutral-900"
                  >
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${getAttachmentAccent(attachment.name, attachment.mimeType)}`}>
                      <FileText className="h-5 w-5" strokeWidth={2} />
                    </div>
                    <div className="min-w-0 text-left">
                      <div className="truncate text-[13px] font-semibold">{attachment.name}</div>
                      <div className="mt-0.5 text-[11px] font-medium uppercase text-neutral-500">
                        {getAttachmentTypeLabel(attachment.name, attachment.mimeType)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words text-sm">
              {messageContent}
            </div>
            {messageImages.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {messageImages.map((img, idx) => (
                  <button
                    type="button"
                    key={img.name || idx}
                    onClick={() => openLightbox(messageImages as LightboxImage[], idx)}
                    className="block overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    aria-label={img.name ? `Preview ${img.name}` : 'Preview image'}
                  >
                    <img
                      src={img.data}
                      alt={img.name}
                      className="h-auto max-w-full cursor-zoom-in rounded-lg transition-opacity hover:opacity-90"
                    />
                  </button>
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-blue-100">
              {shouldShowUserCopyControl && (
                <MessageCopyControl content={userCopyContent} messageType="user" />
              )}
              <span>{formattedTime}</span>
            </div>
          </div>
          {!hideHeader && !isGrouped && (
            <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm text-white sm:flex">
              U
            </div>
          )}
        </div>
      ) : message.isCompactBoundary ? (
        <div className="my-2 flex w-full items-center justify-center gap-2 px-3 sm:px-0">
          <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-900/50" />
          <span className="rounded-full border border-emerald-200/80 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300">
            {t('compact.label')}
          </span>
          {typeof message.preTokens === 'number' && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t('compact.tokens', { tokens: message.preTokens.toLocaleString() })}
            </span>
          )}
          <span className="text-[11px] tabular-nums text-muted-foreground">{formattedTime}</span>
          <span className="h-px flex-1 bg-emerald-200/70 dark:bg-emerald-900/50" />
        </div>
      ) : message.isInterruptedNotice ? (
        <div className="my-1 flex w-full items-center justify-center gap-2 px-3 sm:px-0">
          <span className="h-px flex-1 bg-border/60" />
          <span className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('interrupted.label')}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">{formattedTime}</span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
      ) : message.isTaskNotification ? (
        <div className="w-full">
          <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
            <div className="flex items-start gap-2">
              <span
                className={`mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  message.taskStatus === 'completed'
                    ? 'bg-green-500'
                    : message.taskStatus === 'failed' || message.taskStatus === 'error'
                      ? 'bg-red-500'
                    : 'bg-amber-500'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="break-words text-foreground">{messageContent}</div>
                {(message.taskStatus || message.taskId) && (
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                    {message.taskStatus && (
                      <span className="rounded bg-background/80 px-1.5 py-0.5">{message.taskStatus}</span>
                    )}
                    {message.taskId && (
                      <span className="rounded bg-background/80 px-1.5 py-0.5">{message.taskId}</span>
                    )}
                  </div>
                )}
              </div>
              <span className="flex-shrink-0 text-xs text-muted-foreground">{formattedTime}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full">
          {!hideHeader && !isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                  🔧
                </div>
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
                  <SessionProviderLogo provider={provider} className="h-full w-full" />
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error' ? t('messageTypes.error') : message.type === 'tool' ? t('messageTypes.tool') : (provider === 'cursor' ? t('messageTypes.cursor') : provider === 'codex' ? t('messageTypes.codex') : provider === 'gemini' ? t('messageTypes.gemini') : t('messageTypes.pilotdeck'))}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isToolUse ? (
              <>
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none dark:prose-invert" projectName={selectedProject?.name}>
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    autoExpandTools={autoExpandTools}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                )}

                {/* Tool-result inline images (read_file PNGs, rendered PDF pages, …).
                    Rendered outside the legacy `Read` config (which sets `hidden: true`)
                    so the picture appears on the assistant/tool side instead of leaking
                    into a stray user-side bubble. */}
                {toolResultImages.length > 0 && !message.toolResult?.isError && (
                  <div className="my-1 flex flex-wrap gap-2">
                    {toolResultImages.map((image, idx) => (
                      <button
                        type="button"
                        key={`${image.name || 'tool-image'}-${idx}`}
                        onClick={() => openLightbox(toolResultImages, idx)}
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
                )}

                {/* Tool Result Section */}
                {message.toolResult && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      {(() => {
                        if (isWebSearchNotConfiguredError(message.toolName, message.toolResult?.content)) {
                          return (
                            <div className="my-1.5 overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-950/20">
                              <div className="flex items-start gap-3 px-4 py-3">
                                <Search className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                                    {t('toolUseError.webSearchNotConfigured.title', { defaultValue: 'Web Search Not Configured' })}
                                  </div>
                                  <div className="mt-1 text-xs leading-5 text-amber-700/90 dark:text-amber-300/80">
                                    {t('toolUseError.webSearchNotConfigured.description', { defaultValue: 'The web search tool requires an API key to work. Please go to Settings → Config → Search to set up your search provider and API key.' })}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (typeof window !== 'undefined' && window.openSettings) {
                                        window.openSettings('config');
                                      } else if (onShowSettings) {
                                        onShowSettings();
                                      }
                                    }}
                                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white/80 px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-white dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
                                  >
                                    <Settings className="h-3 w-3" />
                                    {t('toolUseError.webSearchNotConfigured.openSettings', { defaultValue: 'Go to Settings' })}
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        }

                        const recoverableToolError = isRecoverableToolUseError(message.toolResult?.content);
                        const renderedErrorContent = recoverableToolError
                          ? cleanToolUseErrorContent(message.toolResult?.content)
                          : stringifyMessageContent(message.toolResult?.content);

                        if (!permissionSuggestion) {
                          return (
                            <CollapsibleDisplay
                              toolName={message.toolName || 'UnknownTool'}
                              toolId={message.toolId}
                              title={t('toolUseError.title', { defaultValue: 'Tool error' })}
                              defaultOpen={false}
                              toolCategory="default"
                              autoExpandable={false}
                            >
                              <Markdown className="prose prose-sm max-w-none dark:prose-invert" projectName={selectedProject?.name}>
                                {renderedErrorContent}
                              </Markdown>
                            </CollapsibleDisplay>
                          );
                        }

                        return (
                          <div className="my-1 border-l-2 border-l-red-500 py-0.5 pl-3 dark:border-l-red-400">
                            <details className="group/details relative">
                              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-red-600 transition-colors hover:text-red-700 dark:text-red-300 dark:hover:text-red-200 [&::-webkit-details-marker]:hidden">
                                <svg
                                  className="h-3.5 w-3.5 transition-transform group-open/details:rotate-90"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span>
                                  {recoverableToolError
                                    ? t('toolUseError.title', { defaultValue: 'Tool error' })
                                    : t('messageTypes.error', { defaultValue: 'Error' })}
                                </span>
                                {message.toolName ? (
                                  <>
                                    <span className="text-red-400/80 dark:text-red-300/60">/</span>
                                    <span className="font-normal text-red-500 dark:text-red-300/90">{message.toolName}</span>
                                  </>
                                ) : null}
                              </summary>
                              <div className="mt-1.5 pl-[18px] text-xs leading-5 text-gray-700 dark:text-gray-300">
                                <Markdown className="prose prose-sm prose-red max-w-none dark:prose-invert" projectName={selectedProject?.name}>
                                  {renderedErrorContent}
                                </Markdown>
                                <div className="mt-3 border-t border-red-200/60 pt-3 dark:border-red-800/60">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (!onGrantSessionToolPermission) return;
                                        const result = onGrantSessionToolPermission(permissionSuggestion);
                                        if (result?.success) {
                                          setPermissionGrantState('granted');
                                        } else {
                                          setPermissionGrantState('error');
                                        }
                                      }}
                                      disabled={permissionSuggestion.isAllowed || permissionGrantState === 'granted'}
                                      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                        ? 'cursor-default border-green-300/70 bg-green-100 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200'
                                        : 'border-red-300/70 bg-white/80 text-red-700 hover:bg-white dark:border-red-800/60 dark:bg-gray-900/40 dark:text-red-200 dark:hover:bg-gray-900/70'
                                        }`}
                                    >
                                      {permissionSuggestion.isAllowed || permissionGrantState === 'granted'
                                        ? t('permissions.added')
                                        : t('permissions.grant', { tool: permissionSuggestion.toolName })}
                                    </button>
                                    {onShowSettings && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          // Prefer the global helper when present so we
                                          // can land directly on the Permissions tab.
                                          // Falls back to the prop (which always
                                          // opens at 'appearance') if the shell isn't
                                          // mounted with `window.openSettings`.
                                          if (typeof window !== 'undefined' && window.openSettings) {
                                            window.openSettings('permissions');
                                          } else {
                                            onShowSettings();
                                          }
                                        }}
                                        className="text-xs text-red-700 underline hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                                      >
                                        {t('permissions.openSettings')}
                                      </button>
                                    )}
                                  </div>
                                  <div className="mt-2 text-xs text-red-700/90 dark:text-red-200/80">
                                    {t('permissions.addTo', { entry: permissionSuggestion.entry })}
                                  </div>
                                  {permissionGrantState === 'error' && (
                                    <div className="mt-2 text-xs text-red-700 dark:text-red-200">
                                      {t('permissions.error')}
                                    </div>
                                  )}
                                  {(permissionSuggestion.isAllowed || permissionGrantState === 'granted') && (
                                    <div className="mt-2 text-xs text-green-700 dark:text-green-200">
                                      {t('permissions.retry')}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </details>
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                        autoExpandTools={autoExpandTools}
                        isSubagentContainer={message.isSubagentContainer}
                        subagentState={message.subagentState}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isInteractivePrompt ? (
              // Special handling for interactive prompts
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500">
                    <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h4 className="mb-3 text-base font-semibold text-amber-900 dark:text-amber-100">
                      {t('interactive.title')}
                    </h4>
                    {(() => {
                      const lines = messageContent.split('\n').filter((line) => line.trim());
                      const questionLine = lines.find((line) => line.includes('?')) || lines[0] || '';
                      const options: InteractiveOption[] = [];

                      // Parse the menu options
                      lines.forEach((line) => {
                        // Match lines like "❯ 1. Yes" or "  2. No"
                        const optionMatch = line.match(/[❯\s]*(\d+)\.\s+(.+)/);
                        if (optionMatch) {
                          const isSelected = line.includes('❯');
                          options.push({
                            number: optionMatch[1],
                            text: optionMatch[2].trim(),
                            isSelected
                          });
                        }
                      });

                      return (
                        <>
                          <p className="mb-4 text-sm text-amber-800 dark:text-amber-200">
                            {questionLine}
                          </p>

                          {/* Option buttons */}
                          <div className="mb-4 space-y-2">
                            {options.map((option) => (
                              <button
                                key={option.number}
                                className={`w-full rounded-lg border-2 px-4 py-3 text-left transition-all ${option.isSelected
                                  ? 'border-amber-600 bg-amber-600 text-white shadow-md dark:border-amber-700 dark:bg-amber-700'
                                  : 'border-amber-300 bg-white text-amber-900 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-100'
                                  } cursor-not-allowed opacity-75`}
                                disabled
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${option.isSelected
                                    ? 'bg-white/20'
                                    : 'bg-amber-100 dark:bg-amber-800/50'
                                    }`}>
                                    {option.number}
                                  </span>
                                  <span className="flex-1 text-sm font-medium sm:text-base">
                                    {option.text}
                                  </span>
                                  {option.isSelected && (
                                    <span className="text-lg">❯</span>
                                  )}
                                </div>
                              </button>
                            ))}
                          </div>

                          <div className="rounded-lg bg-amber-100 p-3 dark:bg-amber-800/30">
                            <p className="mb-1 text-sm font-medium text-amber-900 dark:text-amber-100">
                              {t('interactive.waiting')}
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200">
                              {t('interactive.instruction')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            ) : message.isThinking ? (
              /* Thinking messages - collapsible by default */
              <div className="text-sm text-gray-700 dark:text-gray-300">
                <details className="group">
                  <summary className="flex cursor-pointer items-center gap-2 font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                    <svg className="h-3 w-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span>{t('thinking.emoji')}</span>
                  </summary>
                  <div className="mt-2 border-l-2 border-gray-300 pl-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400">
                    <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert" projectName={selectedProject?.name}>
                      {messageContent}
                    </Markdown>
                  </div>
                </details>
              </div>
            ) : (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                {/* Thinking accordion for reasoning */}
                {showThinking && message.reasoning && (
                  <details className="mb-3">
                    <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
                      {t('thinking.emoji')}
                    </summary>
                    <div className="mt-2 border-l-2 border-gray-300 pl-4 text-sm italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
                      <div className="whitespace-pre-wrap">
                        {stringifyMessageContent(message.reasoning)}
                      </div>
                    </div>
                  </details>
                )}

                {(() => {
                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-gray-100 dark:text-gray-200">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  return message.type === 'assistant' ? (
                    <Markdown className="prose prose-sm prose-gray max-w-none dark:prose-invert" projectName={selectedProject?.name}>
                      {content}
                    </Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}
              </div>
            )}

            {(shouldShowAssistantCopyControl || !isGrouped) && (
              <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {!isGrouped && <span>{formattedTime}</span>}
              </div>
            )}
          </div>
        </div>
      )}
      {lightbox ? (
        <ImageLightbox
          images={lightbox.images}
          startIndex={lightbox.index}
          onClose={closeLightbox}
        />
      ) : null}
    </div>
  );
});

export default MessageComponent;
