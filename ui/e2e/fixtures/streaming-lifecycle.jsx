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
// Interactive, isolated event replay for timing bugs that are expensive to
// reproduce with a real model (especially automatic context compaction).
let replayHistory = [];
const replayTimestamp = new Date().toISOString();
if (params.has('manual-reconcile')) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/sessions/s/messages') {
      return Promise.resolve(new Response(JSON.stringify({ messages: replayHistory, total: replayHistory.length }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return originalFetch(input, init);
  };
}
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

function TranscriptFixture({ reconcile = false }) {
  const [state, set] = useState({ messages: [], working: true, activities: [], showThinking: true });
  const [replayStage, setReplayStage] = useState(0);
  const store = useSessionStore();
  useEffect(() => { if (reconcile) store.setActiveSession('s'); }, [reconcile, store]);
  const messages = reconcile ? normalizedToChatMessages(store.getMessages('s')) : state.messages;
  const ref = useRef(null);
  window.streamLifecycle = { ...state, store, set: (update) => set((value) => ({ ...value, ...update })) };
  const advanceReplay = async () => {
    const base = { sessionId: 's', runId: 'run', provider: 'pilotdeck', timestamp: replayTimestamp };
    const user = { ...base, id: 'persisted-user', kind: 'text', role: 'user', content: '图片与压缩排列回归', images: ['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="50"%3E%3Crect width="50" height="50" fill="red"/%3E%3Ccircle cx="75" cy="25" r="25" fill="blue"/%3E%3C/svg%3E'] };
    const thought = { ...base, id: 'persisted-thought', kind: 'thinking', content: '压缩前：已确认左边是红色方块，右边是蓝色圆形。' };
    const compact = { ...base, id: 'live-compact', kind: 'compact_boundary', compactionId: 'replay-compact', preTokens: 120000, postTokens: 20000 };
    const answer = { ...base, id: 'live-answer', kind: 'text', role: 'assistant', content: '压缩后：继续回答，图片确认完成。' };
    if (replayStage === 0) {
      store.appendRealtime('s', { ...user, id: 'text_gateway_echo', queueItemId: 'queued-image' });
      store.updateStreamingThinking('s', thought.content, 'pilotdeck', 'run');
      store.finalizeStreamingThinking('s', 'run');
      store.appendRealtime('s', compact);
      store.appendRealtime('s', answer);
    } else {
      const status = { ...base, id: 'next-status', runId: 'next-run', kind: 'status' };
      replayHistory = replayStage === 1
        ? [user, status, { ...thought, content: '压缩前：已确认' }, { ...answer, id: 'persisted-answer' }]
        : [user, status, thought, { ...compact, id: 'persisted-compact' }, { ...answer, id: 'persisted-answer' }];
      await store.refreshFromServer('s', { provider: 'pilotdeck' });
      if (replayStage === 2) set(value => ({ ...value, working: false }));
    }
    setReplayStage(replayStage + 1);
  };
  return <FindShortcutProvider activeScope="chat">
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {params.has('manual-reconcile') && <div style={{ padding: 12, borderBottom: '1px solid #ddd' }}>
        <button onClick={advanceReplay} disabled={replayStage >= 3}>
          {['1. 回放实时消息', '2. 合并滞后历史', '3. 合并完整历史', '回放完成'][replayStage]}
        </button>
        <p>预期：一份图片提问 → 思考 → 压缩 → 回答；各阶段顺序不变。</p>
      </div>}
      <MessagesPane scrollContainerRef={ref} chatMessages={messages} visibleMessages={messages}
        activityMessages={state.activities} visibleMessageCount={messages.length} totalMessages={messages.length}
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
    : params.has('reconcile') || params.has('manual-reconcile') ? <TranscriptFixture reconcile />
      : params.has('transcript') ? <TranscriptFixture /> : <SessionFixture />,
);
