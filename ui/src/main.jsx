import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@fontsource-variable/inter'
import './index.css'
import './light-appearance.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
