import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import './light-appearance.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import { initializePreferencePersistence } from './lib/preferencePersistence'
import { registerUiDiagnostics, recordUiDiagnostic } from './lib/uiDiagnostics'
import { registerDynamicImportReloadHandler } from './utils/reloadOnChunkError'
import { installDesktopFilePicker } from './lib/desktopFilePicker'

registerDynamicImportReloadHandler();
registerUiDiagnostics();
installDesktopFilePicker();

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Install recovery handlers before importing the application.
async function mountApplication() {
await initializePreferencePersistence();
await import('./i18n/config.js');
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
  if (root) root.textContent = `${diagnostic.code} · diagnostic=${diagnostic.diagnosticId}\nRuntime log: ~/.pilotdeck/logs/runtime.log\n${error?.message || 'Interface failed to load'}`;
});
