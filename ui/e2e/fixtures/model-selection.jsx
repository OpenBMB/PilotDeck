import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MessageRow from '../../src/components/chat-v2/MessageRowV2';
import Composer from '../../src/components/chat-v2/ComposerV2';
import { useChatModelSelection } from '../../src/components/chat/hooks/useChatModelSelection';
import { useChatComposerState } from '../../src/components/chat/hooks/useChatComposerState';
import { startSessionCommand, createUserTurnRunId } from '../../src/components/chat/utils/sessionLauncher';
import i18n from '../../src/i18n/config';
import '../../src/index.css';
i18n.changeLanguage('en');
const noop = () => {};
const props = {
  placeholder: 'Message', renderInputWithMentions: (text) => text,
  onTextareaClick: noop, onTextareaKeyDown: noop, onTextareaPaste: noop, onTextareaScrollSync: noop, onTextareaInput: noop,
  onAbortSession: noop, openImagePicker: noop, onAddAttachmentFiles: noop, attachedImages: [], onRemoveImage: noop, onRetryImage: noop,
  documentReferences: [], onRemoveDocumentReference: noop, uploadingImages: new Map(), imageErrors: new Map(),
  filteredFiles: [], selectedFileMentions: [], selectedSkills: [], selectedCommands: [], filteredCommands: [], frequentCommands: [],
  getRootProps: () => ({}), getInputProps: () => ({}), pendingPermissionRequests: [], permissionMode: 'default', runMode: 'agent',
  onPermissionModeChange: noop, onRunModeChange: noop, onInsertSlash: noop, onToggleCommandMenu: noop,
};
function App() {
  const [projectKey, setProject] = useState('/general');
  const [sessionId, setSession] = useState(new URLSearchParams(location.search).get('session') || undefined);
  const [input, setInput] = useState('hello');
  const [loading, setLoading] = useState(false);
  const [frame, setFrame] = useState(null);
  const model = useChatModelSelection();
  const textareaRef = useRef(null), highlightRef = useRef(null);
  const send = (event) => {
    event.preventDefault();
    if (!model.isModelSelectionReady) return;
    const runId = createUserTurnRunId();
    startSessionCommand({
      selectedProject: { name: 'fixture', path: projectKey }, sessionId,
      command: input, modelSelection: model.modelSelection, runId,
      sendMessage: (message) => {
        setFrame(message); setLoading(true); setInput('');
        void fetch('/api/test-submit', { method: 'POST', body: JSON.stringify(message) }).then((r) => r.json()).then((accepted) => {
          setSession(accepted.sessionId);
        });
        return true;
      },
    });
  };
  return <div style={{ maxWidth: 960, margin: '100px auto' }}>
    <button onClick={() => { setProject('/general'); setSession(undefined); setLoading(false); setInput('hello'); }}>General</button>
    <button onClick={() => { setProject('/project'); setSession(undefined); }}>Project</button>
    <button onClick={() => { setLoading(false); }}>Finish</button>
    <output data-testid="selection">{JSON.stringify(model.modelSelection)}</output>
    <output data-testid="submitted">{JSON.stringify(frame)}</output>
    {frame ? <div data-testid="response-fixture"><MessageRow message={{ id: 'fixture-answer', type: 'assistant', content: 'Response fixture', timestamp: '2026-09-05T12:58:00Z', model: frame.options.modelSelection.mode === 'auto' ? 'configured' : frame.options.modelSelection.model }} prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={() => []} /></div> : null}
    <Composer {...props} {...model} input={input} isLoading={loading} canAbortSession
      projectKey={projectKey} textareaRef={textareaRef} inputHighlightRef={highlightRef}
      onInputChange={(e) => setInput(e.target.value)} onSubmit={send}
      onModelSelectionChange={(choice) => { void model.setModelSelection(choice); }}
      />
  </div>;
}

const commandProject = { name: 'fixture', fullPath: '/general' };
function CommandApp() {
  const [settingsOpened, setSettingsOpened] = useState(0);
  const [messages, setMessages] = useState([]);
  const [sent, setSent] = useState(0);
  const pendingViewSessionRef = useRef(null);
  const ready = new URLSearchParams(location.search).get('ready') === 'true';
  const composer = useChatComposerState({
    selectedProject: commandProject, selectedSession: null, currentSessionId: null,
    model: 'missing/model', modelSelection: { mode: 'model', provider: 'missing', model: 'model' },
    isModelSelectionReady: ready, permissionMode: 'default', cycleRunMode: noop, isLoading: false,
    canAbortSession: false, tokenBudget: null, sendMessage: () => { setSent((n) => n + 1); return true; },
    onShowSettings: () => setSettingsOpened((n) => n + 1), pendingViewSessionRef, scrollToBottom: noop,
    addMessage: (message) => setMessages((previous) => [...previous, message]), clearMessages: noop, rewindMessages: noop,
    setIsLoading: noop, setCanAbortSession: noop, setIsAborting: noop, setClaudeStatus: noop, setPilotDeckStatus: noop,
    setIsUserScrolledUp: noop, pendingPermissionRequests: [], setPendingPermissionRequests: noop,
  });
  return <div style={{ maxWidth: 960, margin: '100px auto' }}>
    <output data-testid="settings-opened">{settingsOpened}</output>
    <output data-testid="commands-loaded">{composer.slashCommandsCount}</output>
    <output data-testid="model-requests">{sent}</output>
    <output data-testid="command-messages">{JSON.stringify(messages)}</output>
    <Composer {...props} {...composer} projectKey="/general" modelCatalog={[]} modelSelection={null}
      isLoading={false} canAbortSession={false} isModelSelectionReady={ready} onModelSelectionChange={noop}
      onInputChange={composer.handleInputChange} onSubmit={composer.handleSubmit}
      onTextareaKeyDown={composer.handleKeyDown} onCommandSelect={composer.handleCommandSelect}
      onCloseCommandMenu={composer.dismissCommandMenu} isCommandMenuOpen={composer.showCommandMenu}
      onRemoveCommand={composer.removeSelectedCommand}/>
  </div>;
}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('commands') ? <CommandApp /> : <App />);
