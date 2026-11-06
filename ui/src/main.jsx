import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import './light-appearance.css'
import './form-controls.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import { registerUiDiagnostics, recordUiDiagnostic } from './lib/uiDiagnostics'
import { registerDynamicImportReloadHandler } from './utils/reloadOnChunkError'
import { installDesktopFilePicker } from './lib/desktopFilePicker'
import { installFormControlEvents } from './lib/formControlEvents'

registerDynamicImportReloadHandler();
registerUiDiagnostics();
installDesktopFilePicker();
installFormControlEvents();

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Install recovery handlers before importing the application.
async function mountApplication() {
// App imports the initialized i18n instance itself. Loading it separately here
// serialized two large chunks on every cold start.
const { default: App } = await import('./App.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
}
void mountApplication().catch(error => {
  const diagnostic = recordUiDiagnostic('bootstrap-failed', { errorName: error?.name || 'Error' });
  const root = document.getElementById('root');
  const status = window.pilotdeckDesktop?.getRuntimeStatus?.();
  if (window.__pilotdeckStartupUpdate) window.__pilotdeckStartupUpdate({ phase: 'error', error: diagnostic.code, logPath: status?.logPath || '~/.pilotdeck/logs/runtime.log' });
  else if (root) root.textContent = `${diagnostic.code}\nRuntime log: ${status?.logPath || '~/.pilotdeck/logs/runtime.log'}`;
});
