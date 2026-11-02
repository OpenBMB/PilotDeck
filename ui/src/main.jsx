import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import './light-appearance.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import { initializePreferencePersistence } from './lib/preferencePersistence'
import { registerUiDiagnostics } from './lib/uiDiagnostics'
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

// Resolve durable preferences before modules read language/editor settings.
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
void mountApplication();
