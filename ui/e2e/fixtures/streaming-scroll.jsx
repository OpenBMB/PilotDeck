import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import MessagesPane from '../../src/components/chat-v2/MessagesPaneV2';
import { useScrollFollow } from '../../src/components/chat/hooks/useScrollFollow';
import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages';
import { useSessionStore } from '../../src/stores/useSessionStore';
import '../../src/index.css';

const sid = 'scroll-fixture';
const timestamp = '2026-09-05T00:00:00.000Z';
const base = { sessionId: sid, provider: 'pilotdeck', timestamp, runId: 'live' };
function Fixture() {
  const store = useSessionStore();
  const [working, setWorking] = useState(false);
  const [inline, setInline] = useState(true);
  const [mode, setMode] = useState('agent');
  const [olderMessages, setOlderMessages] = useState([]);
  const ref = useRef(null);
  const messages = [...olderMessages, ...normalizedToChatMessages(store.getMessages(sid))];
  const follow = useScrollFollow({ containerRef: ref, enabled: true, scopeKey: sid, contentKey: messages.length > 0, contentSelector: '[data-chat-scroll-content]' });
  useEffect(() => {
    store.setActiveSession(sid);
    store.appendRealtimeBatch(sid, Array.from({ length: 24 }, (_, index) => [
      { ...base, id: `user-${index}`, kind: 'text', role: 'user', content: `Question ${index}` },
      { ...base, id: `answer-${index}`, kind: 'text', role: 'assistant', content: `Answer ${index}: This is a historical response with enough text to read while a new response streams.\n\nSecond paragraph with a searchable needle ${index}.` },
    ]).flat());
  }, [store]);
  window.streamFixture = {
    prepend(count) {
      setOlderMessages((previous) => [
        ...Array.from({ length: count }, (_, index) => ({
          id: `older-${previous.length + index}`, type: index % 2 ? 'assistant' : 'user',
          content: `Earlier message ${previous.length + index}: additional history.`, timestamp,
        })), ...previous,
      ]);
    },
    think(text) {
      setWorking(true);
      store.updateStreamingThinking(sid, text, 'pilotdeck', 'live');
    },
    tool(id = 'fetch-1') {
      store.finalizeStreamingThinking(sid, 'live');
      store.appendRealtime(sid, { ...base, id, kind: 'tool_use', toolId: id, toolName: 'web_fetch', toolInput: { url: `https://example.com/${id}` } });
      setWorking(true);
    },
    finishTool(id = 'fetch-1', content = '') {
      store.appendRealtime(sid, { ...base, id: `${id}-result`, kind: 'tool_result', toolId: id, content, isError: false });
    },
    text(text) { setWorking(true); store.finalizeStreamingThinking(sid, 'live'); store.updateStreaming(sid, text, 'pilotdeck', 'live'); },
    complete() { store.finalizeStreamingThinking(sid, 'live'); store.finalizeStreaming(sid, 'live'); setWorking(false); },
    setInline, setMode,
  };
  const diff = useMemo(() => () => [], []);
  return <FindShortcutProvider activeScope="chat"><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <MessagesPane
      scrollContainerRef={ref}
      isScrollPaused={follow.isPaused}
      onResumeScroll={follow.scrollToBottom}
      onPauseScroll={() => follow.setPaused(true)}
      chatMessages={messages} visibleMessages={messages} visibleMessageCount={100}
      isLoadingSessionMessages={false} isLoadingMoreMessages={false}
      hasMoreMessages={false} totalMessages={messages.length}
      loadEarlierMessages={() => {}} loadAllMessages={() => {}}
      allMessagesLoaded={false} isLoadingAllMessages={false}
      provider="pilotdeck" selectedProject={null} selectedSession={null}
      createDiff={diff} showThinking inlineThinking={inline} setInput={() => {}}
      isAssistantWorking={working} sessionRuntimeState={working ? 'running' : 'inactive'}
      activeRunId="live" runMode={mode} planModeActive={mode === 'plan'}
    />
  </div></FindShortcutProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
