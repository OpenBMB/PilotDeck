import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTasksSettings } from '../../contexts/TasksSettingsContext';
import type { ChatInterfaceProps, ChatRunMode, Provider } from '../chat/types/types';
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
} from '../../types/app';
import { useChatProviderState } from '../chat/hooks/useChatProviderState';
import { useChatSessionState } from '../chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../chat/hooks/useChatComposerState';
import { useSessionStore } from '../../stores/useSessionStore';
import MessagesPaneV2 from './MessagesPaneV2';
import ComposerV2 from './ComposerV2';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

// V2 chat wrapper. Reuses all business-logic hooks from legacy
// `ChatInterface` so streaming, file-mentions, slash commands, permissions,
// ccr_output, task notifications, subagent containers, etc. all keep working
// unchanged. The difference is purely in the rendered UI:
//   · MessagesPaneV2 — markdown row layout, GPT-like reading width
//   · ComposerV2     — card textarea + paperclip/at + arrow-up send
//   · NO provider picker empty state, NO pill bar, NO gradient bubbles
function ChatInterfaceV2({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  // latestMessage is intentionally not consumed here — useChatRealtimeHandlers
  // now subscribes to the WebSocket directly so React 18 state batching can't
  // drop intermediate stream_delta events.
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  onLaunchAlwaysOnPlanExecution,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  forceWelcome,
  onExitWelcome,
}: ChatInterfaceProps) {
  const { t } = useTranslation('chat');
  const { tasksEnabled: _tasksEnabled, isTaskMasterInstalled: _isTaskMasterInstalled } =
    useTasksSettings();
  const isReadOnlyBackgroundSession = isBackgroundTaskSession(selectedSession);
  const sessionRequestParams = React.useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );

  const sessionStore = useSessionStore();
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const [runMode, setRunMode] = useState<ChatRunMode>('agent');

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
    permissionMode,
    setPermissionMode: setPermissionModeRaw,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({ selectedSession });

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
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting,
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
    setClaudeStatus,
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

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded: _isTextareaExpanded,
    thinkingMode: _thinkingMode,
    setThinkingMode: _setThinkingMode,
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
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
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
    permissionMode: effectivePermissionMode,
    cyclePermissionMode,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    onLaunchAlwaysOnPlanExecution,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setIsUserScrolledUp,
    pendingPermissionRequests,
    setPendingPermissionRequests,
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

    await sessionStore.refreshFromServer(selectedSession.id, {
      provider: 'pilotdeck',
      projectName: selectedProject.name,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
      ...sessionRequestParams,
    });

    // Ask the backend whether the session is still processing so the
    // loading indicator and Stop button reflect reality after reconnect.
    sendMessage({
      type: 'check-session-status',
      sessionId: selectedSession.id,
      provider: 'pilotdeck',
    });
  }, [
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
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
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
    if (!isLoading || !canAbortSession) return;
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      handleAbortSession();
    };
    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

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
  const composer = isReadOnlyBackgroundSession ? (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-6 pt-3">
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {t('session.readonlyBackground', {
          defaultValue: 'This background task transcript is read-only.',
        })}
      </div>
    </div>
  ) : (
    <ComposerV2
      input={input}
      placeholder={t('composer.placeholder', {
        defaultValue: 'Tell PilotDeck what you want to get done…',
      }) as string}
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
      onAbortSession={handleAbortSession}
      openImagePicker={openImagePicker}
      attachedImages={attachedImages}
      onRemoveImage={(index) =>
        setAttachedImages((previous) =>
          previous.filter((_, currentIndex) => currentIndex !== index),
        )
      }
      uploadingImages={uploadingImages}
      imageErrors={imageErrors}
      showFileDropdown={showFileDropdown}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      onSelectFile={selectFile}
      filteredCommands={filteredCommands}
      selectedCommandIndex={selectedCommandIndex}
      onCommandSelect={handleCommandSelect}
      onCloseCommandMenu={dismissCommandMenu}
      isCommandMenuOpen={showCommandMenu}
      frequentCommands={commandQuery ? [] : frequentCommands}
      onToggleCommandMenu={handleToggleCommandMenu}
      onInsertMention={() => insertAtCursor('@')}
      onInsertSlash={() => insertAtCursor('/')}
      getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
      getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
      isDragActive={isDragActive}
      isLoading={isLoading}
      canAbortSession={canAbortSession}
      isAborting={isAborting}
      tokenBudget={tokenBudget}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      sendByCtrlEnter={sendByCtrlEnter}
      permissionMode={permissionMode}
      onSelectPermissionMode={selectPermissionMode}
      runMode={runMode}
      onRunModeChange={setRunMode}
      planModeAvailable={true}
      onPlanExecutionApproved={handlePlanExecutionApproved}
      chromeless={isWelcomeMode}
    />
  );

  if (isWelcomeMode) {
    const projectName = selectedProject?.displayName || selectedProject?.name || '';
    return (
      <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-[720px]">
            <h1 className="mb-8 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
              {selectedProject
                ? t('welcome.greetingWithProject', {
                    project: projectName,
                    defaultValue: `What's on the plan today?`,
                  })
                : t('welcome.noProject', {
                    defaultValue: 'Pick a project from the sidebar to get started',
                  })}
            </h1>
            {composer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
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
        setInput={setInput}
        isAssistantWorking={isLoading}
        workingStatus={claudeStatus}
        runMode={runMode}
      />
      {composer}
    </div>
  );
}

export default React.memo(ChatInterfaceV2);
