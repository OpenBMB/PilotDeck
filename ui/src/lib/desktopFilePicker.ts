import i18n from '../i18n/config.js';

/** One delegated handler covers appearance, attachments, file/folder uploads,
 * imports and owned same-origin iframe pages. Browsers retain native inputs. */
export function installDesktopFilePicker(rootDocument: Document = document): () => void {
  const bridge = window.pilotdeckDesktop?.pickFiles;
  if (!bridge) return () => {};
  let pending = false;
  let sequence = 0;
  const cleanups = new Map<Document, () => void>();
  const frameDocuments = new WeakMap<HTMLIFrameElement, Document>();
  const install = (doc: Document) => {
    if (cleanups.has(doc) || !doc.defaultView || doc.defaultView.location.origin !== window.location.origin) return;
    const frames = new Set<HTMLIFrameElement>();
    const click = (event: MouseEvent) => {
      const input = event.target;
      if (!(input instanceof doc.defaultView!.HTMLInputElement) || input.type !== 'file' || input.matches(':disabled') || event.defaultPrevented) return;
      event.preventDefault();
      if (pending) return;
      pending = true;
      const inputId = `${Date.now().toString(36)}-${++sequence}`;
      input.setAttribute('data-pilotdeck-file-picker', inputId);
      void bridge({ inputId, accept: input.accept, multiple: input.multiple, directory: input.hasAttribute('webkitdirectory') || input.hasAttribute('directory') })
        .then(result => { if (result === 'canceled' && input.isConnected && doc.defaultView) input.dispatchEvent(new doc.defaultView.Event('cancel', { bubbles: true })); })
        .catch(() => window.dispatchEvent(new CustomEvent('pilotdeck:toast', { detail: { kind: 'error', message: i18n.t('common:filePickerFailed') } })))
        .finally(() => { input.removeAttribute('data-pilotdeck-file-picker'); pending = false; });
    };
    const releaseFrame = (frame: HTMLIFrameElement) => {
      const previous = frameDocuments.get(frame);
      if (previous) cleanups.get(previous)?.();
      frameDocuments.delete(frame);
      frames.delete(frame);
    };
    const attachFrame = (frame: HTMLIFrameElement) => {
      try {
        const next = frame.contentDocument;
        if (frameDocuments.get(frame) !== next) releaseFrame(frame);
        if (next) { frames.add(frame); frameDocuments.set(frame, next); install(next); }
      } catch { releaseFrame(frame); /* External frames own their chooser. */ }
    };
    const load = (event: Event) => { if (event.target instanceof doc.defaultView!.HTMLIFrameElement) attachFrame(event.target); };
    doc.addEventListener('click', click, true);
    doc.addEventListener('load', load, true);
    const observer = new doc.defaultView.MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof doc.defaultView!.Element) {
          if (node instanceof doc.defaultView!.HTMLIFrameElement) releaseFrame(node);
          node.querySelectorAll('iframe').forEach(releaseFrame);
        }
      }
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof doc.defaultView!.Element) {
          if (node instanceof doc.defaultView!.HTMLIFrameElement) attachFrame(node);
          node.querySelectorAll('iframe').forEach(attachFrame);
        }
      }
    });
    observer.observe(doc, { childList: true, subtree: true });
    cleanups.set(doc, () => {
      if (!cleanups.delete(doc)) return;
      observer.disconnect();
      doc.removeEventListener('click', click, true); doc.removeEventListener('load', load, true);
      frames.forEach(releaseFrame);
    });
    doc.querySelectorAll('iframe').forEach(attachFrame);
  };
  install(rootDocument);
  return () => [...cleanups.values()].forEach(cleanup => cleanup());
}
