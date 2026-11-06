import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FindShortcutProvider } from '../../src/contexts/FindShortcutContext';
import MessagesPane from '../../src/components/chat-v2/MessagesPaneV2';
import { useChatSessionState } from '../../src/components/chat/hooks/useChatSessionState';
import { useSessionStore } from '../../src/stores/useSessionStore';
import '../../src/index.css';
import i18n from '../../src/i18n/config';
i18n.changeLanguage('en');
const project = { name: 'fixture', path: '/fixture' };
const sessions = [{ id: 'a', isReadOnly: true }, { id: 'b', isReadOnly: true }];
const noop = () => {};
function Fixture() {
  const store = useSessionStore();
  const [session, setSession] = useState(sessions[0]);
  const [working, setWorking] = useState(false);
  const pending = useRef(null);
  const chat = useChatSessionState({ selectedProject: project, selectedSession: session,
    ws: null, sendMessage: noop, autoScrollToBottom: true, resetStreamingState: noop,
    pendingViewSessionRef: pending, sessionStore: store });
  window.historyFixture = { store, chat, setSession: index => setSession(sessions[index]), setWorking,
    setLanguage: language => i18n.changeLanguage(language) };
  return <FindShortcutProvider activeScope="chat">
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MessagesPane {...chat} provider="pilotdeck" selectedProject={project} selectedSession={session}
        setInput={noop} showThinking isAssistantWorking={working} sessionRuntimeState={working ? 'running' : 'inactive'}
        showReturnToLatest={chat.canReturnToLatest} onPauseScroll={chat.pauseScrollFollowing} onResumeScroll={chat.scrollToBottom} />
    </div>
  </FindShortcutProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
