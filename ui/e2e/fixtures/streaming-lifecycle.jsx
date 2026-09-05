import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import MessagesPane from '../../src/components/chat-v2/MessagesPaneV2';
import SubagentModal from '../../src/components/chat-v2/SubagentDetailModal';
import SubagentFlow from '../../src/components/chat-v2/SubagentDetailMessageFlow';
import { normalizedToChatMessages } from '../../src/components/chat/hooks/useChatMessages';
import { useSubagentMessages } from '../../src/components/chat-v2/useSubagentMessages';
import { useChatSessionState } from '../../src/components/chat/hooks/useChatSessionState';
import { useSessionStore } from '../../src/stores/useSessionStore';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const project = { name: 'fixture', path: '/fixture' };
const sessions = [{ id: 'a', isReadOnly: true }, { id: 'b', isReadOnly: true }];
const noop = () => {};
const diff = () => [];
const normalized = (sid, index) => ({
  id: `${sid}-${index}`, sessionId: sid, timestamp: '2026-09-05T00:00:00Z',
  provider: 'pilotdeck', kind: 'text', role: index % 2 ? 'assistant' : 'user',
  content: `Session ${sid} message ${index}.\n\nA paragraph for reading.`,
});
const count = Number(params.get('count') || 240);
const data = Object.fromEntries(sessions.map((session) => [
  session.id, Array.from({ length: count }, (_, i) => normalized(session.id, i)),
]));
const mockStore = {
  setActiveSession: noop,
  getMessages: (id) => data[id] || [],
  has: () => true,
  isStale: () => false,
  fetchFromServer: async (id) => ({
    status: 'idle', hasMore: false, total: data[id].length, serverMessages: data[id],
  }),
};

function SessionFixture() {
  const [session, setSession] = useState(sessions[0]);
  const [auto, setAuto] = useState(params.get('auto') !== 'false');
  const [, tick] = useState(0);
  const pending = useRef(null);
  const chat = useChatSessionState({
    selectedProject: project, selectedSession: session, ws: null, sendMessage: noop,
    autoScrollToBottom: auto, resetStreamingState: noop, pendingViewSessionRef: pending, sessionStore: mockStore,
  });
  window.streamLifecycle = {
    chat, setSession: (index) => setSession(sessions[index]), setAuto,
    append: (n = 1) => {
      data[session.id] = [...data[session.id], ...Array.from({ length: n }, (_, i) => normalized(session.id, data[session.id].length + i))];
      tick((value) => value + 1);
    },
  };
  return <FindShortcutProvider activeScope="chat">
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MessagesPane {...chat} provider="pilotdeck" selectedProject={project} selectedSession={session}
        setInput={noop} showThinking showReturnToLatest={chat.canReturnToLatest}
        onPauseScroll={chat.pauseScrollFollowing} onResumeScroll={chat.scrollToBottom} />
    </div>
  </FindShortcutProvider>;
}

function ChildFixture({ direct = false }) {
  const store = useSessionStore();
  const [status, setStatus] = useState('running');
  useEffect(() => store.setActiveSession('s'), [store]);
  const detail = useSubagentMessages(direct ? null : 's', direct ? null : 'child', undefined, store, status);
  window.streamLifecycle = {
    store, detail, status,
    think: (text) => store.updateSubagentDetailThinking('s', 'child', text, 'pilotdeck'),
    text: (text) => store.updateSubagentDetailStreaming('s', 'child', text, 'pilotdeck'),
    finish: () => {
      store.finalizeSubagentDetailThinking('s', 'child');
      store.finalizeSubagentDetailStreaming('s', 'child');
      setStatus('completed');
    },
  };
  return <FindShortcutProvider activeScope="chat">
    {direct ? <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
      <SubagentFlow messages={normalizedToChatMessages(store.getSubagentDetailMessages('s', 'child'))}
        provider="pilotdeck" selectedProject={null} createDiff={diff} isRunning={status === 'running'} showThinking />
    </div> : <SubagentModal subagentId="child" messages={detail.messages}
      isLoading={detail.isLoading} error={detail.error} provider="pilotdeck" selectedProject={null} createDiff={diff}
      showThinking isRunning={status === 'running'} onClose={noop} />}
  </FindShortcutProvider>;
}

function TranscriptFixture() {
  const [state, set] = useState({ messages: [], working: true, activities: [], showThinking: true });
  const ref = useRef(null);
  window.streamLifecycle = { ...state, set: (update) => set((value) => ({ ...value, ...update })) };
  return <FindShortcutProvider activeScope="chat">
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MessagesPane scrollContainerRef={ref} chatMessages={state.messages} visibleMessages={state.messages}
        activityMessages={state.activities} visibleMessageCount={state.messages.length} totalMessages={state.messages.length}
        isLoadingSessionMessages={false} isLoadingMoreMessages={false} hasMoreMessages={false} allMessagesLoaded
        isLoadingAllMessages={false} loadAllMessages={noop} loadEarlierMessages={noop} provider="pilotdeck"
        selectedProject={null} selectedSession={null} createDiff={diff} showThinking={state.showThinking} inlineThinking
        isAssistantWorking={state.working} sessionRuntimeState={state.working ? 'running' : 'inactive'} activeRunId="run"
        setInput={noop} />
    </div>
  </FindShortcutProvider>;
}

createRoot(document.getElementById('root')).render(
  params.has('child-direct') ? <ChildFixture direct /> : params.has('child') ? <ChildFixture />
    : params.has('transcript') ? <TranscriptFixture /> : <SessionFixture />,
);
