const RELOAD_MARKER = 'pilotdeck:chunk-load-reloaded';

const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /loading chunk \S+ failed/i,
  /chunkloaderror/i,
  /unable to preload css/i,
];

export function isDynamicImportLoadError(error: unknown): boolean {
  const message = errorToText(error);
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function reloadOnceForDynamicImportError(
  error: unknown,
  win: Pick<Window, 'sessionStorage' | 'location'> = window,
): boolean {
  if (!isDynamicImportLoadError(error)) return false;

  try {
    if (win.sessionStorage.getItem(RELOAD_MARKER) === '1') return false;
    win.sessionStorage.setItem(RELOAD_MARKER, '1');
  } catch {
    // If sessionStorage is unavailable, still try one recovery reload.
  }

  win.location.reload();
  return true;
}

export function clearDynamicImportReloadMarker(win: Pick<Window, 'sessionStorage'> = window): void {
  try {
    win.sessionStorage.removeItem(RELOAD_MARKER);
  } catch {
    // Ignore storage access failures.
  }
}

export function registerDynamicImportReloadHandler(win: Window = window): () => void {
  const onPreloadError = (event: Event) => {
    const preloadEvent = event as Event & { payload?: unknown };
    if (reloadOnceForDynamicImportError(preloadEvent.payload, win)) {
      event.preventDefault();
    }
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (reloadOnceForDynamicImportError(event.reason, win)) {
      event.preventDefault();
    }
  };

  const onLoad = () => clearDynamicImportReloadMarker(win);

  win.addEventListener('vite:preloadError', onPreloadError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);
  win.addEventListener('load', onLoad, { once: true });

  return () => {
    win.removeEventListener('vite:preloadError', onPreloadError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
    win.removeEventListener('load', onLoad);
  };
}

function errorToText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
  }
  return String(error ?? '');
}
