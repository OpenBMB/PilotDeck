import { authenticatedFetch } from './api';

export async function saveRuntimeLogs(): Promise<{ canceled: boolean }> {
  if (window.pilotdeckDesktop?.saveRuntimeLogs) return window.pilotdeckDesktop.saveRuntimeLogs();
  type Handle = { createWritable(): Promise<{ write(value: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> };
  const picker = (window as Window & { showSaveFilePicker?: (options: object) => Promise<Handle> }).showSaveFilePicker;
  const filename = `PilotDeck-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  let handle: Handle | undefined;
  if (picker) {
    try { handle = await picker.call(window, { suggestedName: filename, types: [{ description: 'Runtime logs', accept: { 'text/plain': ['.log'] } }] }); }
    catch (error) { if ((error as Error).name === 'AbortError') return { canceled: true }; throw error; }
  }
  const response = await authenticatedFetch('/api/diagnostics/logs');
  if (!response.ok) throw new Error('Runtime log export failed');
  const blob = await response.blob();
  if (handle) {
    const output = await handle.createWritable();
    try { await output.write(blob); await output.close(); }
    catch (error) { await output.abort().catch(() => {}); throw error; }
  } else {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { canceled: false };
}
