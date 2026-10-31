import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../../utils/api';
import type { Scope } from '../types/mcp';

type Props = { scope: Scope; name: string; projectPath?: string; onComplete: () => void };
export default function McpOAuthControls({ scope, name, projectPath, onComplete }: Props) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState('needs-auth');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  const request = useCallback(async (action: string) => {
    const response = await authenticatedFetch(`/api/mcp/oauth/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, name, projectPath }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }, [scope, name, projectPath]);
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await request('status');
        if (!stopped && status === 'pending' && data.status === 'authorized') {
          await request('complete');
          if (!stopped) { setUrl(''); completeRef.current(); }
        }
        if (!stopped) {
          setStatus(data.status);
          if (data.status !== 'pending') setUrl('');
        }
      } catch (err) { if (!stopped) setError((err as Error).message); }
      finally { inFlight = false; }
    };
    void check();
    const timer = status === 'pending' ? setInterval(() => void check(), 1500) : undefined;
    return () => { stopped = true; clearInterval(timer); };
  }, [request, status]);
  const action = async (value: string) => {
    setBusy(true); setError('');
    try {
      const data = await request(value);
      setStatus(data.status); setUrl(data.authorizationUrl ?? '');
      if (value === 'start' && data.status === 'authorized') { await request('complete'); completeRef.current(); }
      if (value === 'cancel' || value === 'disconnect') completeRef.current();
      if (value === 'disconnect' && !data.revoked) setError(t('mcpOAuth.localDisconnect'));
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="mcp-http-note" aria-label="MCP OAuth">
    <div>
      <p>{t('mcpOAuth.help')}</p>
      <p role="status">{t(`mcpOAuth.${status}`, { defaultValue: status })}</p>
      {error && <p role="alert">{error}</p>}
      {status === 'authorized'
        ? <button className="button secondary compact" type="button" disabled={busy} onClick={() => void action('disconnect')}>{t('mcpOAuth.disconnect')}</button>
        : status === 'pending'
          ? <button className="button secondary compact" type="button" disabled={busy} onClick={() => void action('cancel')}>{t('mcpOAuth.cancel')}</button>
          : <button className="button primary compact" type="button" disabled={busy} onClick={() => void action('start')}>{t('mcpOAuth.start')}</button>}
      {url && status === 'pending' && <p><a className="button primary compact" href={url} target="_blank" rel="noopener noreferrer">{t('mcpOAuth.open')}</a><br />{t('mcpOAuth.return')}</p>}
    </div>
  </section>;
}
