import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useTasksSettings } from '../../contexts/TasksSettingsContext';
import { useToast } from '../../contexts/ToastContext';
import { api } from '../../utils/api';
import type { ChatInterfaceProps, ChatMessage, ChatRunMode, Provider } from '../chat/types/types';
import {
  getSessionRequestParams,
  isReadOnlySession,
} from '../../types/app';
import { isGeneralProject } from '../app-shell/appShellSelection';
import { projectDisplayName, useCustomNamesVersion } from '../../lib/customNames';
import { useChatProviderState } from '../chat/hooks/useChatProviderState';
import { useChatSessionState } from '../chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../chat/hooks/useChatComposerState';
import { useSessionInputQueue } from '../chat/hooks/useSessionInputQueue';
import {
  getEffectiveThinkingMode,
  getThinkingModeAvailability,
} from '../chat/constants/thinkingModeAvailability';
import { thinkingModeToConfig } from '../chat/constants/thinkingModes';
import { useSessionStore } from '../../stores/useSessionStore';
import { getDraftInputStorageKey, getPilotDeckSettings, safeLocalStorage } from '../chat/utils/chatStorage';
import { buildAttachmentPathNote } from '../chat/utils/attachmentNotes';
import {
  createUserTurnRunId,
  getNotificationSessionSummary,
  regenerateLastSessionCommand,
} from '../chat/utils/sessionLauncher';
import {
  formatContentReferencePromptBlock,
  normalizeContentReference,
  type ContentReference,
} from '../../types/contentReference';
import { useSessionWatch } from '../../hooks/useSessionWatch';
import { useWebSocket } from '../../contexts/WebSocketContext';
import MessagesPaneV2 from './MessagesPaneV2';
import ComposerV2 from './ComposerV2';
import QueuedMessagesTray from './QueuedMessagesTray';
import { buildReconnectStatusMessage, refreshSessionAfterReconnect, shouldRefreshSessionOnReconnect } from './reconnectRecovery';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

const EDIT_RECONCILIATION_HINT = [
  'The user replaced their immediately previous request with this edited request.',
  'The conversation transcript no longer contains the replaced turn, but its tool actions may already have changed the current workspace.',
  'Treat the current workspace as the source of truth: inspect existing changes, do not assume earlier work is correct, and reconcile or revise it to satisfy the edited request.',
].join(' ');

// V2 chat wrapper. Reuses all business-logic hooks from legacy
// `ChatInterface` so streaming, file-mentions, slash commands, permissions,
// ccr_output, task notifications, subagent containers, etc. all keep working
// unchanged. The difference is purely in the rendered UI:
//   · MessagesPaneV2 — markdown row layout, GPT-like reading width
//   · ComposerV2     — card textarea + paperclip/at + arrow-up send
//   · NO provider picker empty state, NO pill bar, NO gradient bubbles
function ChatInterfaceV2({
  selectedProject: selectedProjectFromShell,
  selectedSession,
  ws,
  sendMessage,
  subscribe,
  // latestMessage is intentionally not consumed here — useChatRealtimeHandlers
  // now subscribes to the WebSocket directly so React 18 state batching can't
  // drop intermediate stream_delta events.
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onSessionActivityBump,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  inlineThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  forceWelcome,
  onExitWelcome,
  compact = false,
  projects = [],
  onStartNewSession: _onStartNewSession,
  onSelectWorkspace,
  workspaceBinding = null,
  onCreateProject,
}: ChatInterfaceProps) {
  useCustomNamesVersion();
  const selectedProject = selectedSession
    ? selectedProjectFromShell
    : (workspaceBinding ?? selectedProjectFromShell);
  const { t } = useTranslation('chat');
  const { subscribe: contextSubscribe } = useWebSocket();
  const { tasksEnabled: _tasksEnabled, isTaskMasterInstalled: _isTaskMasterInstalled } =
    useTasksSettings();
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const sessionRequestParams = React.useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );

  const sessionStore = useSessionStore();
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const [isAbortPending, setIsAbortPending] = useState(false);
  const [runMode, setRunMode] = useState<ChatRunMode>('agent');
  const [isForkPending, setIsForkPending] = useState(false);
  const regenerateRequestsRef = useRef(new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>());
  const { addToast } = useToast();

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
    accumulatedStreamRef.current = '';
  }, []);

  const {
    model,
    modelCatalog,
    modelSelection,
    setModelSelection,
    isModelCatalogLoading,
    modelCatalogError,
    thinkingModelContext,
    permissionMode,
    setPermissionMode: setPermissionModeRaw,
    pendingPermissionRequests,
    setPendingPermissionRequests,
  } = useChatProviderState({ selectedProject, selectedSession });

  const thinkingModeAvailability = React.useMemo(
    () => getThinkingModeAvailability(thinkingModelContext),
    [thinkingModelContext],
  );

  const cycleRunMode = useCallback(() => {
    setRunMode((currentMode) => {
      if (currentMode === 'agent') return 'plan';
      if (currentMode === 'plan') return 'ask';
      return 'agent';
    });
  }, []);

  const selectPermissionMode = useCallback((mode: typeof permissionMode) => {
    setPermissionModeRaw(mode);
    localStorage.setItem('permissionMode-default', mode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, mode);
    }
  }, [setPermissionModeRaw, selectedSession?.id]);

  const effectivePermissionMode =
    runMode === 'plan' ? 'plan' : permissionMode;

  const {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    sessionRuntimeState,
    setSessionRuntimeState,
    activeRunId,
    setActiveRunId,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting: _isAborting,
    setIsAborting,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    claudeStatus,
    pilotDeckStatus,
    setClaudeStatus,
    setPilotDeckStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
  });

  const watchedSessionId = selectedSession?.id || currentSessionId || null;
  useSessionWatch({ sessionId: watchedSessionId, ws, sendMessage });
  const inputQueue = useSessionInputQueue({
    sessionId: watchedSessionId,
    projectPath: selectedProject?.fullPath || selectedProject?.path,
    ws,
    sendMessage,
    subscribe: subscribe || contextSubscribe,
  });

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded: _isTextareaExpanded,
    thinkingMode,
    slashCommandsCount: _slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState: _resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    fileMentionQuery,
    filteredFiles,
    selectedFileIndex,
    isLoadingFiles,
    fileListError,
    hasMoreFiles,
    loadMoreFiles,
    selectedFileMentions,
    removeFileMention,
    selectedSkills,
    selectSkill,
    removeSkill,
    selectedCommands,
    removeSelectedCommand,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    removeAttachedImage,
    retryAttachmentUpload,
    documentReferences,
    removeDocumentReference,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    addAttachmentFiles,
    handleSubmit,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handleInputFocusChange,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    model,
    modelSelection,
    runMode,
    permissionMode: effectivePermissionMode,
    basePermissionMode: permissionMode,
    cycleRunMode,
    isLoading,
    canAbortSession,
    inputQueuePaused: inputQueue.queueState.paused,
    enqueuePreparedInput: inputQueue.enqueue,
    tokenBudget,
    sendMessage,
    subscribe,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setIsUserScrolledUp,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    referenceOnlyPrompt: t('documentReferences.defaultPrompt', {
      defaultValue: 'Please answer based on the document selection I quoted.',
    }) as string,
  });

  const handlePlanExecutionApproved = useCallback(() => {
    setRunMode('agent');
  }, []);

  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;

    // Reset streaming refs so stale accumulated text from the previous
    // connection doesn't merge with freshly-fetched server messages.
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
    streamBufferRef.current = '';

    if (shouldRefreshSessionOnReconnect({ isLoading, processingSessions, sessionId: selectedSession.id })) {
      await refreshSessionAfterReconnect(() =>
        sessionStore.refreshFromServer(selectedSession.id, {
          provider: 'pilotdeck',
          projectName: selectedProject.name,
          projectPath: selectedProject.fullPath || selectedProject.path || '',
          ...sessionRequestParams,
        }),
      );
    }

    // Ask the backend whether the session is still processing so the
    // loading indicator, Stop button, and active turn replay reflect reality
    // after reconnect. The session-status handler consumes activeTurnMessages
    // and dedupes replay chunks against existing realtime state.
    const statusMessage = buildReconnectStatusMessage(selectedSession.id, activeRunId);
    if (statusMessage) sendMessage(statusMessage);
  }, [
    activeRunId,
    isLoading,
    processingSessions,
    selectedProject,
    selectedSession,
    sessionRequestParams,
    sessionStore,
    streamTimerRef,
    accumulatedStreamRef,
    streamBufferRef,
    sendMessage,
  ]);

  useChatRealtimeHandlers({
    provider: 'pilotdeck',
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setSessionRuntimeState,
    activeRunId,
    setActiveRunId,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      setIsAbortPending(false);
    }
  }, [canAbortSession, isLoading]);

  useEffect(() => {
    setIsAbortPending(false);
  }, [currentSessionId, selectedSession?.id]);

  const handleAbortWithPending = useCallback(() => {
    if (!isLoading || !canAbortSession || isAbortPending) return;
    handleAbortSession();
    setIsAbortPending(true);
  }, [canAbortSession, handleAbortSession, isAbortPending, isLoading]);

  const handleResumeInputQueue = useCallback(() => {
    void inputQueue.resume().then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.resumeFailed', { defaultValue: 'Failed to resume the queue.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleSteerQueuedInput = useCallback((itemId: string) => {
    void inputQueue.steer(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.steerFailed', { defaultValue: 'The message remains queued.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleDeleteQueuedInput = useCallback((itemId: string) => {
    void inputQueue.remove(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.deleteFailed', { defaultValue: 'Failed to delete the queued message.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleMoveQueuedInputToFront = useCallback((itemId: string) => {
    void inputQueue.moveToFront(itemId).then((result) => {
      if (!result.ok) addToast('error', result.error || t('inputQueue.moveFailed', { defaultValue: 'Failed to reorder the queue.' }));
    });
  }, [addToast, inputQueue, t]);

  const handleFork = useCallback(async (message: ChatMessage, _carriedPreview: number) => {
    if (isForkPending || isLoading || sessionIsReadOnly) return;
    const sessionId = selectedSession?.id || currentSessionId;
    const fromEntryId = message.entryId;
    if (!sessionId || !fromEntryId || !selectedProject) {
      addToast('error', t('fork.missingTarget', { defaultValue: 'Cannot fork this message.' }));
      return;
    }

    const projectPath = selectedProject.fullPath || selectedProject.path || '';
    setIsForkPending(true);
    try {
      const response = await api.forkSession(sessionId, { projectPath, fromEntryId });
      let result: { newSessionId?: string; prefillText?: string; runMode?: string; mode?: string; error?: string } = {};
      try {
        result = await response.json();
      } catch {
        result = {};
      }
      if (!response.ok) {
        throw new Error(result?.error || `Fork failed (${response.status})`);
      }
      const newSessionId = result?.newSessionId;
      if (!newSessionId) {
        throw new Error('Fork did not return a new session id');
      }
      setRunMode(result.runMode === 'ask' ? 'ask' : result.mode === 'plan' || result.runMode === 'plan' ? 'plan' : 'agent');

      if (typeof window.refreshProjects === 'function') {
        try {
          await window.refreshProjects();
        } catch {
          // Keep the fork usable even if the sidebar refresh races/fails.
        }
      }

      const forkDraft = typeof result.prefillText === 'string'
        ? result.prefillText
        : message.type === 'user'
          ? message.content || ''
          : '';
      const forkDraftStorageKey = getDraftInputStorageKey(selectedProject.name, newSessionId);
      if (forkDraft) {
        safeLocalStorage.setItem(forkDraftStorageKey, forkDraft);
      } else {
        safeLocalStorage.removeItem(forkDraftStorageKey);
      }

      onNavigateToSession?.(newSessionId);
      setInput(forkDraft);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        scrollToBottom?.();
      });
      // Messages load asynchronously after the session switch; scroll again
      // once the carried history has had a chance to render.
      setTimeout(() => scrollToBottom?.(), 400);
      addToast(
        'success',
        t('fork.ready', {
          defaultValue: 'Fork created — edit the prompt and send when ready.',
        }),
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      addToast('error', messageText || t('fork.failed', { defaultValue: 'Fork failed.' }));
    } finally {
      setIsForkPending(false);
    }
  }, [
    addToast,
    currentSessionId,
    isForkPending,
    isLoading,
    sessionIsReadOnly,
    onNavigateToSession,
    scrollToBottom,
    selectedProject,
    selectedSession?.id,
    setInput,
    t,
    textareaRef,
  ]);

  useEffect(() => {
    if (!subscribe) return undefined;
    const unsubscribe = subscribe((message: any) => {
      if (message?.type !== 'regenerate-last-message-result') return;
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const pending = regenerateRequestsRef.current.get(requestId);
      if (!pending) return;
      regenerateRequestsRef.current.delete(requestId);
      window.clearTimeout(pending.timeoutId);
      if (message.success) pending.resolve();
      else pending.reject(new Error(message.error || t('edit.failed', { defaultValue: 'Could not edit this message.' })));
    });
    return () => unsubscribe();
  }, [subscribe, t]);

  useEffect(() => () => {
    for (const pending of regenerateRequestsRef.current.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(t('edit.cancelled', { defaultValue: 'Message edit was cancelled.' })));
    }
    regenerateRequestsRef.current.clear();
  }, [t]);

  const handleRegenerate = useCallback(async (message: ChatMessage, editedText: string) => {
    const sessionId = selectedSession?.id || currentSessionId;
    const expectedTurnId = String(message.turnId || message.runId || '').trim();
    if (!sessionId || !expectedTurnId || !selectedProject || sessionIsReadOnly) {
      throw new Error(t('edit.missingTarget', { defaultValue: 'The last message can no longer be edited.' }));
    }

    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const references = attachments
      .map((attachment) => normalizeContentReference(attachment.contentReference ?? attachment))
      .filter((reference): reference is ContentReference => Boolean(reference));
    const regularFiles = attachments
      .filter((attachment) => !attachment.kind || attachment.kind === 'file')
      .flatMap((attachment) => {
        const path = attachment.path || attachment.filePath;
        return path ? [{ name: attachment.name, path }] : [];
      });
    const command = `${editedText}${buildAttachmentPathNote(regularFiles)}${formatContentReferencePromptBlock(references)}`;
    const requestId = createUserTurnRunId();
    const runId = createUserTurnRunId();
    const result = new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        regenerateRequestsRef.current.delete(requestId);
        reject(new Error(t('edit.timeout', { defaultValue: 'Editing timed out. Please try again.' })));
      }, 120_000);
      regenerateRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });

    const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
    regenerateLastSessionCommand({
      sendMessage,
      selectedProject,
      requestId,
      sessionId,
      expectedTurnId,
      command,
      runId,
      userVisibleInput: editedText,
      toolsSettings: getPilotDeckSettings(),
      runMode,
      permissionMode: effectivePermissionMode,
      basePermissionMode: permissionMode,
      model,
      thinking: thinkingModeToConfig(effectiveThinkingMode),
      sessionSummary: getNotificationSessionSummary(selectedSession, editedText),
      images: Array.isArray(message.images) ? message.images : [],
      attachments,
      syntheticMessages: [{
        text: EDIT_RECONCILIATION_HINT,
        purpose: 'edited_turn_workspace_reconciliation',
      }],
    });

    return result;
  }, [
    currentSessionId,
    effectivePermissionMode,
    model,
    permissionMode,
    runMode,
    selectedProject,
    selectedSession,
    sendMessage,
    sessionIsReadOnly,
    t,
    thinkingMode,
    thinkingModeAvailability,
  ]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) return;
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      if (
        event.target instanceof Element
        && event.target.closest('[data-file-search-input]')
      ) {
        return;
      }
      if (document.querySelector('[data-modal-overlay]')) return;
      event.preventDefault();
      handleAbortWithPending();
    };
    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortWithPending, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // ChatGPT-style empty state. Triggered explicitly via `forceWelcome` and
  // implicitly when nothing has been started yet (no session, no
  // messages, not in the middle of loading). The composer floats in the
  // middle with a welcome headline above it; once the user sends, we drop
  // into the normal layout (composer at bottom, messages on top) on the
  // next render.
  const isWelcomeMode =
    !!forceWelcome ||
    (!selectedSession && !currentSessionId && !isLoadingSessionMessages && chatMessages.length === 0);

  // Fire onExitWelcome the moment the user submits from welcome mode. Wraps
  // handleSubmit so we don't have to thread state through useChatComposerState.
  const wrappedSubmit = useCallback(
    (...args: unknown[]) => {
      if (isWelcomeMode && onExitWelcome) onExitWelcome();
      return (handleSubmit as (...a: unknown[]) => unknown)(...args);
    },
    [handleSubmit, isWelcomeMode, onExitWelcome],
  );

  // The composer is identical in welcome / normal mode — just rendered in a
  // different parent container. Pulled out so we don't drift between the two.
  const composer = sessionIsReadOnly ? (
    <div className="mx-auto w-full max-w-[860px] px-6 pb-6 pt-3">
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {t('session.readonlyTranscript', {
          defaultValue: 'This transcript is read-only.',
        })}
      </div>
    </div>
  ) : (
    <ComposerV2
      queueTray={(
        <QueuedMessagesTray
          state={inputQueue.queueState}
          isLoading={isLoading}
          onResume={handleResumeInputQueue}
          onSteer={handleSteerQueuedInput}
          onDelete={handleDeleteQueuedInput}
          onMoveToFront={handleMoveQueuedInputToFront}
        />
      )}
      input={input}
      placeholder="告诉PilotDeck你想完成什么。@引用项目内容，/调用技能与指令。"
      textareaRef={textareaRef}
      inputHighlightRef={inputHighlightRef}
      renderInputWithMentions={renderInputWithMentions}
      onInputChange={handleInputChange}
      onTextareaClick={handleTextareaClick}
      onTextareaKeyDown={handleKeyDown}
      onTextareaPaste={handlePaste}
      onTextareaScrollSync={syncInputOverlayScroll}
      onTextareaInput={handleTextareaInput}
      onInputFocusChange={handleInputFocusChange}
      onSubmit={wrappedSubmit as typeof handleSubmit}
      onAbortSession={handleAbortWithPending}
      openImagePicker={openImagePicker}
      onAddAttachmentFiles={addAttachmentFiles}
      attachedImages={attachedImages}
      onRemoveImage={removeAttachedImage}
      onRetryImage={retryAttachmentUpload}
      documentReferences={documentReferences}
      onRemoveDocumentReference={removeDocumentReference}
      onOpenDocumentReference={onFileOpen ? (filePath) => onFileOpen(filePath) : undefined}
      uploadingImages={uploadingImages}
      imageErrors={imageErrors}
      showFileDropdown={showFileDropdown}
      fileMentionQuery={fileMentionQuery}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      isLoadingFiles={isLoadingFiles}
      fileListError={fileListError}
      hasMoreFiles={hasMoreFiles}
      onLoadMoreFiles={loadMoreFiles}
      onSelectFile={selectFile}
      selectedFileMentions={selectedFileMentions}
      onRemoveFileMention={removeFileMention}
      selectedSkills={selectedSkills}
      onSelectSkill={selectSkill}
      onRemoveSkill={removeSkill}
      selectedCommands={selectedCommands}
      onRemoveCommand={removeSelectedCommand}
      filteredCommands={filteredCommands}
      commandQuery={commandQuery}
      selectedCommandIndex={selectedCommandIndex}
      onCommandSelect={handleCommandSelect}
      onCloseCommandMenu={dismissCommandMenu}
      isCommandMenuOpen={showCommandMenu}
      frequentCommands={commandQuery ? [] : frequentCommands}
      onToggleCommandMenu={handleToggleCommandMenu}
      onInsertSlash={() => insertAtCursor('/')}
      getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
      getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
      isDragActive={isDragActive}
      isLoading={isLoading}
      canAbortSession={canAbortSession}
      isAbortPending={isAbortPending}
      isInputQueuePaused={inputQueue.queueState.paused}
      onResumeInputQueue={handleResumeInputQueue}
      tokenBudget={tokenBudget}
      modelCatalog={modelCatalog}
      modelSelection={modelSelection}
      isModelCatalogLoading={isModelCatalogLoading}
      modelCatalogError={modelCatalogError}
      projectKey={selectedProject?.fullPath || selectedProject?.path || ''}
      onModelSelectionChange={(selection) => {
        void setModelSelection(selection).catch((error) => {
          addToast('error', error instanceof Error ? error.message : String(error));
        });
      }}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      permissionMode={permissionMode}
      onPermissionModeChange={selectPermissionMode}
      runMode={runMode}
      onRunModeChange={setRunMode}
      onPlanExecutionApproved={handlePlanExecutionApproved}
      sendByCtrlEnter={sendByCtrlEnter}
      chromeless={isWelcomeMode && !compact}
      compact={compact}
      showWorkspacePicker={isWelcomeMode && !compact}
      workspaceProjects={projects}
      workspaceSelectedProject={workspaceBinding ?? (!selectedSession ? selectedProjectFromShell : null)}
      onSelectWorkspaceProject={(project) => {
        onSelectWorkspace?.(project);
      }}
      onSelectWorkspaceNone={() => {
        const generalProject = projects.find(isGeneralProject);
        if (generalProject) onSelectWorkspace?.(generalProject);
      }}
      onCreateWorkspaceProject={onCreateProject}
    />
  );
  const composerSlot = (
    <div data-chat-composer-slot className="min-h-0 shrink-0">
      {composer}
    </div>
  );

  if (isWelcomeMode) {
    const projectName = selectedProject && !isGeneralProject(selectedProject)
      ? projectDisplayName(selectedProject)
      : '';
    if (compact) {
      return (
        <div className="flex h-full min-w-0 flex-col bg-white dark:bg-neutral-950">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
              <MessageSquare className="h-4 w-4" strokeWidth={1.8} />
            </div>
            <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              {t('workspace.emptyTitle', { defaultValue: 'Ask PilotDeck about this project' })}
            </p>
            <p className="mt-1 max-w-56 text-[12px] leading-5 text-neutral-400 dark:text-neutral-500">
              {t('workspace.emptyDescription', {
                defaultValue: 'Reference a workspace file with @ when you want it included.',
              })}
            </p>
          </div>
          {composerSlot}
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-[860px]">
            <h1 className="mb-8 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
              {projectName
                ? t('welcome.greetingWithProject', {
                  project: projectName,
                  defaultValue: `What do you want us to build in ${projectName}?`,
                })
                : t('welcome.noProject', {
                  defaultValue: `What's on the plan today?`,
                })}
            </h1>
            {composerSlot}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-white dark:bg-neutral-950">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
        isLoadingSessionMessages={isLoadingSessionMessages}
        sessionLoadError={sessionLoadError}
        onRetrySessionLoad={handleWebSocketReconnect}
        chatMessages={chatMessages}
        activityMessages={activityMessages}
        visibleMessages={visibleMessages}
        visibleMessageCount={visibleMessageCount}
        isLoadingMoreMessages={isLoadingMoreMessages}
        hasMoreMessages={hasMoreMessages}
        totalMessages={totalMessages}
        loadEarlierMessages={loadEarlierMessages}
        loadAllMessages={loadAllMessages}
        allMessagesLoaded={allMessagesLoaded}
        isLoadingAllMessages={isLoadingAllMessages}
        provider={'pilotdeck' as Provider}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantSessionToolPermission={handleGrantSessionToolPermission}
        autoExpandTools={autoExpandTools}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        inlineThinking={inlineThinking}
        setInput={setInput}
        isAssistantWorking={isLoading}
        sessionRuntimeState={sessionRuntimeState}
        activeRunId={activeRunId}
        workingStatus={claudeStatus || pilotDeckStatus}
        runMode={runMode}
        planModeActive={effectivePermissionMode === 'plan'}
        sessionStore={sessionStore}
        onFork={sessionIsReadOnly ? undefined : handleFork}
        onRegenerate={sessionIsReadOnly ? undefined : handleRegenerate}
        forkDisabled={isForkPending}
      />
      {composerSlot}
    </div>
  );
}

export default React.memo(ChatInterfaceV2);
