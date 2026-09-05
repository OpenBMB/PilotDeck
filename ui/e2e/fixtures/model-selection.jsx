import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Composer from '../../src/components/chat-v2/ComposerV2';
import { useChatModelSelection } from '../../src/components/chat/hooks/useChatModelSelection';
import { startSessionCommand } from '../../src/components/chat/utils/sessionLauncher';
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
  const listener = useRef(noop);
  const subscribe = useCallback((fn) => { listener.current = fn; return noop; }, []);
  const model = useChatModelSelection({ projectKey, sessionId, subscribe });
  const textareaRef = useRef(null), highlightRef = useRef(null);
  const send = (event) => {
    event.preventDefault();
    if (!model.isModelSelectionReady) return;
    startSessionCommand({
      selectedProject: { name: 'fixture', path: projectKey }, sessionId,
      command: input, modelSelection: model.modelSelection,
      sendMessage: (message) => {
        setFrame(message); setLoading(true); setInput('');
        void fetch('/api/test-submit', { method: 'POST', body: JSON.stringify(message) }).then((r) => r.json()).then((accepted) => {
          if (!sessionId) listener.current({ kind: 'session_created', projectKey, newSessionId: accepted.sessionId });
          setSession(accepted.sessionId);
          listener.current({ type: 'model-selection-saved', sessionId: accepted.sessionId, selection: message.options.modelSelection });
          const running = message.options.modelSelection.mode === 'auto'
            ? { provider: 'zeta', model: 'configured' } : message.options.modelSelection;
          listener.current({ type: 'model-selection-changed', sessionId: accepted.sessionId, modelProvider: running.provider, model: running.model, runId: 'run-1' });
        });
        return true;
      },
    });
  };
  return <div style={{ maxWidth: 960, margin: '100px auto' }}>
    <button onClick={() => { setProject('/general'); setSession(undefined); }}>General</button>
    <button onClick={() => { setProject('/project'); setSession(undefined); }}>Project</button>
    <button onClick={() => { setLoading(false); }}>Finish</button>
    <output data-testid="selection">{JSON.stringify(model.modelSelection)}</output>
    <output data-testid="submitted">{JSON.stringify(frame)}</output>
    <Composer {...props} {...model} input={input} isLoading={loading} canAbortSession
      projectKey={projectKey} textareaRef={textareaRef} inputHighlightRef={highlightRef}
      onInputChange={(e) => setInput(e.target.value)} onSubmit={send}
      onModelSelectionChange={(choice) => { void model.setModelSelection(choice); }}
      runningModel={model.runningModels[sessionId]}/>
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
