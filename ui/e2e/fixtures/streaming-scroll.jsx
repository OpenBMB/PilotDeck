import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import PermissionRequestsBanner from '../../src/components/chat/view/subcomponents/PermissionRequestsBanner';
import MessagesPane from '../../src/components/chat-v2/MessagesPaneV2';
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
  const [inline, setInline] = useState(true);
  const [mode, setMode] = useState('agent');
  const [olderMessages, setOlderMessages] = useState([]);
  const ref = useRef(null);
  const messages = [...olderMessages, ...normalizedToChatMessages(store.getMessages(sid))];
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
    beginTurn(id = 'current-user') {
      const at = new Date().toISOString();
      store.appendRealtime(sid, { ...base, id, kind: 'text', role: 'user', content: 'Inspect the implementation', timestamp: at });
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
    finishTool(id = 'fetch-1', content = '') {
      store.appendRealtime(sid, { ...base, id: `${id}-result`, kind: 'tool_result', toolId: id, content, isError: false });
    },
    text(text) { setWorking(true); store.finalizeStreamingThinking(sid, 'live'); store.updateStreaming(sid, text, 'pilotdeck', 'live'); },
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
      onPauseScroll={() => follow.setPaused(true)}
      chatMessages={messages} visibleMessages={messages} visibleMessageCount={100}
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
createRoot(document.getElementById('root')).render(<Fixture />);
