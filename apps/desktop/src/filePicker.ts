import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import path from 'node:path';

export type FilePickerRequest = { inputId: string; accept: string; multiple: boolean; directory: boolean };
export type FilePickerResult = 'selected' | 'canceled' | 'busy';
const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'image/svg+xml': ['svg'], 'image/*': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic'],
  'application/json': ['json'], 'application/pdf': ['pdf'], 'application/zip': ['zip'],
  'text/plain': ['txt'], 'text/csv': ['csv'], 'text/markdown': ['md'],
  'audio/*': ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'], 'video/*': ['mp4', 'webm', 'mov', 'mkv', 'avi'],
};
export function normalizeFilePickerRequest(value: unknown): FilePickerRequest {
  const v = value as Partial<FilePickerRequest> | null;
  if (!v || typeof v.inputId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(v.inputId)
    || typeof v.accept !== 'string' || v.accept.length > 4096
    || typeof v.multiple !== 'boolean' || typeof v.directory !== 'boolean') throw new Error('Invalid file picker request');
  return { inputId: v.inputId, accept: v.accept, multiple: v.multiple, directory: v.directory };
}
export function filePickerOptions(request: FilePickerRequest, defaultPath: string, chinese: boolean): OpenDialogOptions {
  const extensions = new Set<string>();
  // Explicit extensions avoid Chromium's MIME/registry discovery before a
  // Windows dialog opens. Unknown MIME types still allow choosing all files.
  for (const token of request.accept.toLowerCase().split(',').map(t => t.trim())) {
    if (/^\.[a-z0-9][a-z0-9._+-]{0,30}$/.test(token)) extensions.add(token.slice(1));
    else for (const extension of MIME_EXTENSIONS[token] || []) extensions.add(extension);
  }
  return {
    defaultPath,
    properties: request.directory ? ['openDirectory'] : request.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    ...(!request.directory && extensions.size ? { filters: [
      { name: chinese ? '支持的文件' : 'Supported files', extensions: [...extensions] },
      { name: chinese ? '所有文件' : 'All files', extensions: ['*'] },
    ] } : {}),
  };
}

/** Keep Chromium-backed File objects: no whole-file reads or copies over IPC.
 * Only paths selected in the native dialog reach this private DOM operation. */
export async function assignSelectedFiles(owner: BrowserWindow, inputId: string, files: string[]): Promise<void> {
  const debuggerApi = owner.webContents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  if (!alreadyAttached) debuggerApi.attach('1.3');
  let searchId: string | undefined;
  try {
    await debuggerApi.sendCommand('DOM.getDocument', { depth: 0 });
    const search = await debuggerApi.sendCommand('DOM.performSearch', { query: `input[type="file"][data-pilotdeck-file-picker="${inputId}"]`, includeUserAgentShadowDOM: false });
    searchId = search.searchId;
    if (search.resultCount !== 1) throw new Error('File input is no longer available');
    const { nodeIds } = await debuggerApi.sendCommand('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[0], files });
  } finally {
    if (searchId) await debuggerApi.sendCommand('DOM.discardSearchResults', { searchId }).catch(() => {});
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

export function createFilePicker(options: {
  defaults: { images: string; files: string; directory: string };
  chinese: () => boolean;
  showDialog: (owner: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  assign?: typeof assignSelectedFiles;
}) {
  let pending = false;
  const remembered = { ...options.defaults };
  return async (owner: BrowserWindow, value: unknown): Promise<FilePickerResult> => {
    const request = normalizeFilePickerRequest(value);
    if (pending) return 'busy';
    pending = true;
    try {
      const category = request.directory ? 'directory' : /image\/|\.(png|jpe?g|webp)/i.test(request.accept) ? 'images' : 'files';
      const result = await options.showDialog(owner, filePickerOptions(request, remembered[category], options.chinese()));
      if (result.canceled || result.filePaths.length === 0 || owner.isDestroyed()) return 'canceled';
      const selected = request.multiple && !request.directory ? result.filePaths : result.filePaths.slice(0, 1);
      await (options.assign || assignSelectedFiles)(owner, request.inputId, selected);
      // Do not make the next picker wait for a remote share to reconnect.
      const directory = request.directory ? selected[0] : path.dirname(selected[0]);
      if (!directory.startsWith('\\\\')) remembered[category] = directory;
      return 'selected';
    } finally { pending = false; }
  };
}
