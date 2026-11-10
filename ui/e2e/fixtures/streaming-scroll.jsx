import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import PermissionRequestsBanner from '../../src/components/chat/view/subcomponents/PermissionRequestsBanner';
import MessagesPane from '../../src/components/chat/view/MessagesPane';
import { useScrollFollow } from '../../src/components/chat/hooks/useScrollFollow';
import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages';
import { useSessionStore } from '../../src/stores/useSessionStore';
import '../../src/index.css';
import i18n from '../../src/i18n/config';
import { applyLightAppearance } from '../../src/lib/appearanceRuntime';
import { normalizeLightAppearance } from '../../src/lib/lightAppearance';

i18n.changeLanguage('en');

const sid = 'scroll-fixture';
const timestamp = '2026-09-05T00:00:00.000Z';
const base = { sessionId: sid, provider: 'pilotdeck', timestamp, runId: 'live' };
function Fixture() {
  const store = useSessionStore();
  const [working, setWorking] = useState(false);
  const [questions, setQuestions] = useState([]);
  const answerText = useRef('');
  const turnStartedAt = useRef(timestamp);
  const [inline, setInline] = useState(true);
  const [mode, setMode] = useState('agent');
  const [olderMessages, setOlderMessages] = useState([]);
  const ref = useRef(null);
  const messages = [...olderMessages, ...normalizedToChatMessages(store.getMessages(sid))];
  const activities = normalizedToChatMessages(store.getActivityMessages(sid));
  const follow = useScrollFollow({ containerRef: ref, enabled: true, scopeKey: sid, contentKey: messages.length > 0, contentSelector: '[data-chat-scroll-content]' });
  const askQuestions = (list, text = '') => {
    answerText.current = text;
    const input = { questions: list };
    store.finalizeStreamingThinking(sid, 'live');
    store.appendRealtime(sid, { ...base, id: 'question-tool', kind: 'tool_use', toolId: 'question-tool', toolName: 'AskUserQuestion', toolInput: input });
    setQuestions([{ requestId: 'question-1', toolName: 'AskUserQuestion', input }]);
    setWorking(true);
  };
  useEffect(() => {
    store.setActiveSession(sid);
    store.appendRealtimeBatch(sid, Array.from({ length: Number(new URLSearchParams(location.search).get('history') ?? 24) }, (_, index) => [
      { ...base, id: `user-${index}`, kind: 'text', role: 'user', content: `Question ${index}` },
      { ...base, id: `answer-${index}`, kind: 'text', role: 'assistant', content: `Answer ${index}: This is a historical response with enough text to read while a new response streams.\n\nSecond paragraph with a searchable needle ${index}.` },
    ]).flat());
  }, [store]);
  window.streamFixture = {
    mediaHistory(count = 100) {
      setOlderMessages(Array.from({ length: count }, (_, index) => {
        const turnId = `media-turn-${index}`;
        const video = index % 2 === 1;
        return [
          { id: `media-user-${index}`, turnId, type: 'user', content: `Media question ${index}`, timestamp },
          { id: `media-tool-${index}`, turnId, type: 'assistant', isToolUse: true, toolId: `media-tool-${index}`,
            toolName: video ? 'generate_video' : 'generate_image', toolInput: { purpose: 'deliverable' }, timestamp,
            toolResult: { content: 'Synthetic media', toolUseResult: video
              ? { videoGeneration: { videoId: `video-${index}`, sessionId: 'scroll-media', purpose: 'deliverable' } }
              : { imageGeneration: { imageId: `image-${index}`, sessionId: 'scroll-media', width: 320, height: 640, mimeType: 'image/svg+xml', purpose: 'deliverable' } } } },
          { id: `media-answer-${index}`, turnId, type: 'assistant', content: `Media answer ${index}.\n\n${'A readable paragraph beside delayed media.\n\n'.repeat(5)}`, timestamp },
        ];
      }).flat());
    },
    beginTurn(id = 'current-user', content = 'Inspect the implementation') {
      const at = new Date().toISOString();
      turnStartedAt.current = at;
      store.appendRealtime(sid, { ...base, id, kind: 'text', role: 'user', content, timestamp: at });
      setWorking(true);
    },
    prepareFile(id, receivedBytes, filePath) {
      store.finalizeStreaming(sid, 'live'); store.finalizeStreamingThinking(sid, 'live');
      store.upsertActivity(sid, { ...base, id: `preparing-${id}`, kind: 'agent_activity', activityId: `preparing-${id}`,
        phase: 'file_input', state: 'running', toolId: id, toolName: 'write_file', fileInputProgress: { receivedBytes, filePath } });
      setWorking(true);
    },
    askQuestion(text = '') {
      askQuestions([{ header: 'Next step', question: 'How should we continue?', options: [
        { label: 'Continue', description: 'Keep working on the current task.' },
        { label: 'Review', description: 'Review the work before continuing.' },
      ] }], text);
    },
    askQuestions,
    getMessages: () => store.getMessages(sid),
    refresh: () => store.refreshFromServer(sid, { provider: 'pilotdeck' }),
    prepend(count) {
      setOlderMessages((previous) => [
        ...Array.from({ length: count }, (_, index) => ({
          id: `older-${previous.length + index}`, type: index % 2 ? 'assistant' : 'user',
          content: `Earlier message ${previous.length + index}: additional history.`, timestamp,
        })), ...previous,
      ]);
    },
    think(text) {
      store.finalizeStreaming(sid, 'live');
      setWorking(true);
      store.updateStreamingThinking(sid, text, 'pilotdeck', 'live');
    },
    tool(id = 'fetch-1', toolName = 'web_fetch', toolInput = { url: `https://example.com/${id}` }) {
      store.finalizeStreaming(sid, 'live');
      store.finalizeStreamingThinking(sid, 'live');
      store.appendRealtime(sid, { ...base, id, kind: 'tool_use', toolId: id, toolName, toolInput });
      setWorking(true);
    },
    finishTool(id = 'fetch-1', content = '', toolUseResult) {
      store.appendRealtime(sid, { ...base, id: `${id}-result`, kind: 'tool_result', toolId: id, content, isError: false, toolUseResult });
    },
    files(status = 'complete') {
      store.appendRealtime(sid, { ...base, id: 'file-results', kind: 'file_artifacts', artifacts: [{
        id: 'report', name: 'report.txt', path: 'report.txt', operation: 'created', source: 'workspace_diff',
        status, size: 42, sha256: 'a'.repeat(64), createdAt: timestamp,
      }] });
    },
    text(text) { setWorking(true); store.finalizeStreamingThinking(sid, 'live'); store.updateStreaming(sid, text, 'pilotdeck', 'live'); },
    stop(withTiming = true) {
      store.finalizeStreamingThinking(sid, 'live'); store.finalizeStreaming(sid, 'live');
      const endedAt = new Date().toISOString();
      store.appendRealtime(sid, { ...base, id: 'stopped-completion', kind: 'complete', timestamp: endedAt, finishReason: 'aborted',
        ...(withTiming ? { turnTiming: { startedAt: turnStartedAt.current, completedAt: endedAt, finishReason: 'aborted' } } : {}) });
      setWorking(false);
    },
    complete(durationMs) {
      store.finalizeStreamingThinking(sid, 'live'); store.finalizeStreaming(sid, 'live');
      if (typeof durationMs === 'number') store.appendRealtime(sid, {
        sessionId: sid, provider: 'pilotdeck', id: 'completed-summary', kind: 'agent_activity_summary',
        timestamp: new Date().toISOString(), status: 'completed', durationMs,
        startedAt: new Date(Date.now() - durationMs).toISOString(), endedAt: new Date().toISOString(),
      });
      setWorking(false);
    },
    setInline, setMode,
    setLanguage: (language) => i18n.changeLanguage(language),
    setAppearance(preset, dark = false) {
      document.documentElement.classList.toggle('dark', dark);
      applyLightAppearance(normalizeLightAppearance({ preset, custom: { accent: '#256c57', background: '#e9f4ef' } }), dark);
    },
    restoreThinking(durationMs) {
      store.applyTimelineMessage(sid, { ...base, id: 'restored-thought', kind: 'thinking', content: 'A measured thought restored from history.',
        isFinal: true, streamState: 'closed', timeline: { version: 1, turnId: 'restored', id: 'thought', order: 0, revision: 2,
          startedAt: '2026-01-01T00:00:00Z', durationMs } });
    },
  };
  const diff = useMemo(() => () => [], []);
  return <FindShortcutProvider activeScope="chat"><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <MessagesPane
      scrollContainerRef={ref}
      showReturnToLatest={follow.canReturnToLatest}
      onResumeScroll={follow.scrollToBottom}
      onPauseScroll={follow.pauseAt}
      chatMessages={messages} visibleMessages={messages} activityMessages={activities} visibleMessageCount={100}
      isLoadingSessionMessages={false} isLoadingMoreMessages={false}
      hasMoreMessages={false} totalMessages={messages.length}
      loadEarlierMessages={() => {}} loadAllMessages={() => {}}
      allMessagesLoaded={false} isLoadingAllMessages={false}
      provider="pilotdeck" selectedProject={null} selectedSession={null}
      createDiff={diff} showThinking inlineThinking={inline} setInput={() => {}}
      pendingPermissionRequests={questions}
      isAssistantWorking={working} sessionRuntimeState={working ? 'running' : 'inactive'}
      activeRunId="live" runMode={mode} planModeActive={mode === 'plan'}
    />
    <div className="mx-auto w-full max-w-[860px] px-6">
      <PermissionRequestsBanner pendingPermissionRequests={questions} handleGrantToolPermission={() => ({ success: true })}
        handlePermissionDecision={(_id, decision) => {
          store.appendRealtime(sid, { ...base, id: 'question-result', kind: 'tool_result', toolId: 'question-tool',
            content: 'Answered', toolUseResult: { answers: decision.updatedInput.answers } });
          setQuestions([]);
          if (answerText.current) {
            store.updateStreaming(sid, answerText.current, 'pilotdeck', 'live');
            store.finalizeStreaming(sid, 'live'); setWorking(false);
          }
        }} />
    </div>
  </div></FindShortcutProvider>;
}
createRoot(document.getElementById('root')).render(<ThemeProvider><Fixture /></ThemeProvider>);
