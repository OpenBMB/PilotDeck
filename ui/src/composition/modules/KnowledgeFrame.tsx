import { useEffect, useRef, useState } from 'react';

const protocol = 'knowledge-frame/v1';
type Directory = { spaces: Array<{ id: string; name: string; can_write?: boolean }>; models: Array<{ id: string; name: string; space_id?: string }>; publishSuggestions?: boolean; capabilities?: unknown };
type Props = { src: string; apiPath: string; headers: () => Record<string, string>; directory: () => Promise<Directory>; navigate?: (path: string) => void; notify?: (message: string, error: boolean) => void };

export default function KnowledgeFrame({ src, apiPath, headers, directory, navigate, notify }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  useEffect(() => {
    const origin = new URL(src, location.href).origin;
    const requests = new Map<string, XMLHttpRequest>();
    let active = true;
    let connected = false;
    const post = (value: Record<string, unknown>, transfer: Transferable[] = []) => frame.current?.contentWindow?.postMessage({ protocol, channel, ...value }, origin, transfer);
    const timer = setTimeout(() => { if (!connected) setError('Knowledge plugin did not connect'); }, 15000);
    const listener = async (event: MessageEvent) => {
      if (!active || event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.channel !== channel) return;
      const value = event.data;
      if (value.protocol !== protocol) { setError('Knowledge plugin protocol is incompatible'); return; }
      if (value.type === 'ready') {
        try { const config = await directory(); if (active) { connected = true; clearTimeout(timer); post({ type: 'init', ...config }); } }
        catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
        return;
      }
      if (value.type === 'navigate' && typeof value.path === 'string' && /^\/knowledge(?:\/|$)/.test(value.path)) { navigate?.(value.path); return; }
      if (value.type === 'notify' && typeof value.message === 'string') { notify?.(value.message.slice(0, 2000), value.error === true); return; }
      if (typeof value.id !== 'string' || value.id.length > 100) return;
      if (value.type === 'cancel') { requests.get(value.id)?.abort(); return; }
      if (value.type !== 'request') return;
      const fail = (message: string) => post({ type: 'response', id: value.id, error: message });
      if (requests.has(value.id)) { fail('Duplicate Knowledge request'); return; }
      if (typeof value.path !== 'string' || !value.path.startsWith('/api/km/v1/') || !['GET', 'POST', 'PUT', 'DELETE'].includes(value.method)
        || value.body !== undefined && typeof value.body !== 'string') { fail('Invalid Knowledge request'); return; }
      const url = new URL(value.path, location.origin);
      const suffix = url.pathname.slice('/api/km/v1'.length);
      if (url.origin !== location.origin || !/^\/(identity|models|okf|spaces|bindings|knowledge-bases|documents|buckets|chunks|concepts|jobs|suggestions|citations|query)(\/|$)/.test(suffix)
        || value.path.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/.test(value.path)) { fail('Knowledge operation is not allowed'); return; }
      const xhr = new XMLHttpRequest();
      requests.set(value.id, xhr);
      xhr.open(value.method, apiPath + suffix + url.search);
      xhr.responseType = 'arraybuffer';
      for (const [name, content] of Object.entries(headers())) xhr.setRequestHeader(name, content);
      if (value.body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.upload.onprogress = progress => { if (value.upload === true && progress.lengthComputable) post({ type: 'progress', id: value.id, percent: Math.round(progress.loaded / progress.total * 100) }); };
      xhr.onload = () => {
        if (!active) return;
        const body = xhr.response as ArrayBuffer;
        post({ type: 'response', id: value.id, status: xhr.status, headers: { 'content-type': xhr.getResponseHeader('content-type') || 'application/octet-stream', ...(xhr.getResponseHeader('content-disposition') ? { 'content-disposition': xhr.getResponseHeader('content-disposition') } : {}) }, body }, [body]);
      };
      xhr.onerror = () => fail('Knowledge request failed');
      xhr.onabort = () => fail('Knowledge request cancelled');
      xhr.onloadend = () => requests.delete(value.id);
      xhr.send(value.body ?? null);
    };
    addEventListener('message', listener);
    return () => { active = false; clearTimeout(timer); removeEventListener('message', listener); requests.forEach(xhr => xhr.abort()); requests.clear(); };
  }, [src, apiPath, headers, directory, navigate, notify, channel]);
  return error ? <div role="alert">{error}</div> : <iframe ref={frame} title="Knowledge" src={src + '#channel=' + channel}
    sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" style={{ width: '100%', height: 'calc(100dvh - 64px)', minHeight: 480, border: 0 }} />;
}
