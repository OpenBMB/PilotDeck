const STORAGE_KEY = 'pilotdeck:ui-diagnostics';
const LIMIT = 20;

type Diagnostic = { at: string; event: string; diagnosticId: string; code: string; metrics: Record<string, number | boolean | string> };
// Deliberately exclude prompts, model replies, paths, credentials and session IDs.
export function recordUiDiagnostic(event: string, metrics: Diagnostic['metrics'] = {}) {
  const diagnosticId = crypto.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const code = event === 'unhandled-rejection' ? 'PD_UI_UNHANDLED_REJECTION' : event === 'react-boundary' ? 'PD_UI_RENDER_FAILED' : 'PD_UI_UNEXPECTED_ERROR';
  const item: Diagnostic = { at: new Date().toISOString(), event, diagnosticId, code, metrics };
  console.warn('[PilotDeck UI]', item);
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    const entries = Array.isArray(saved) ? saved.slice(-(LIMIT - 1)) : [];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...entries, item]));
  } catch { /* Diagnostics must never break recovery. */ }
  if (typeof fetch === 'function' && ['react-boundary', 'window-error', 'unhandled-rejection', 'bootstrap-failed'].includes(event)) {
    let token: string | null = null;
    try { token = localStorage.getItem('auth-token'); } catch { /* unavailable */ }
    void fetch('/api/diagnostics/ui', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ diagnosticId, code, event, errorName: metrics.errorName }) }).catch(() => {});
  }
  return item;
}

export function reloadUi() {
  window.dispatchEvent(new Event('pilotdeck:flush-drafts'));
  recordUiDiagnostic('manual-reload');
  window.location.reload();
}

export function registerUiDiagnostics() {
  const onError = (event: ErrorEvent) => recordUiDiagnostic('window-error', {
    errorName: event.error instanceof Error ? event.error.name : 'Error',
    line: event.lineno || 0, column: event.colno || 0,
  });
  const onRejection = (event: PromiseRejectionEvent) => recordUiDiagnostic('unhandled-rejection', {
    errorName: event.reason instanceof Error ? event.reason.name : 'Unknown',
  });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
