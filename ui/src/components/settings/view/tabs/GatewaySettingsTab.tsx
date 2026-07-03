import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquare,
  QrCode,
  Radio,
  XCircle,
} from 'lucide-react';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import { cn } from '../../../../lib/utils';

type GatewayStatus = {
  feishu: {
    enabled: boolean;
    appId: string;
    hasSecret: boolean;
    connectionMode: string;
    domainName: string;
  };
  weixin: {
    enabled: boolean;
    hasCredentials: boolean;
    accountId: string | null;
  };
  wecom: {
    enabled: boolean;
    botId: string;
    hasSecret: boolean;
    websocketUrl: string;
    dmPolicy: string;
    groupPolicy: string;
  };
};

type TestResult = { ok: boolean; message?: string; error?: string } | null;
type WeComAccessPolicy = 'open' | 'allowlist' | 'disabled';

function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch('/api/gateway/status');
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetch_(); }, [fetch_]);

  return { status, loading, refresh: fetch_ };
}

// ─── Feishu Section ──────────────────────────────────────────────────────────

type FeishuSetupMode = 'choose' | 'qr' | 'manual';
type FeishuQrPhase = 'idle' | 'connecting' | 'scanning' | 'success' | 'error';

function FeishuSection({ status, onSaved }: { status: GatewayStatus['feishu']; onSaved: () => void }) {
  const { t } = useTranslation('settings');
  const [setupMode, setSetupMode] = useState<FeishuSetupMode>('choose');
  const [expanded, setExpanded] = useState(!status.enabled);

  // ── QR state ──
  const [qrPhase, setQrPhase] = useState<FeishuQrPhase>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [qrDomain, setQrDomain] = useState<'feishu' | 'lark'>('feishu');
  const [qrError, setQrError] = useState('');
  const pollRef = useRef<number | null>(null);

  // ── Manual state ──
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu');
  const [mode, setMode] = useState<'stream' | 'webhook'>('stream');
  const [testResult, setTestResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status.domainName === 'lark') setDomain('lark');
    if (status.connectionMode === 'webhook') setMode('webhook');
  }, [status]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startQR = async () => {
    setQrPhase('connecting');
    setQrError('');
    setQrUrl('');
    try {
      const res = await authenticatedFetch('/api/gateway/feishu/qr-begin', {
        method: 'POST',
        body: JSON.stringify({ domainName: qrDomain }),
      });
      const data = await res.json();
      if (!data.ok) {
        setQrPhase('error');
        setQrError(data.error || 'Failed');
        return;
      }
      setQrUrl(data.qrUrl);
      setQrPhase('scanning');

      pollRef.current = window.setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch('/api/gateway/feishu/qr-poll');
          const pollData = await pollRes.json();
          if (pollData.pending) return;
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (pollData.ok) {
            setQrPhase('success');
            onSaved();
          } else {
            setQrPhase('error');
            setQrError(pollData.error || 'Failed');
          }
        } catch { /* network error, keep polling */ }
      }, 3000);
    } catch (err: any) {
      setQrPhase('error');
      setQrError(err.message);
    }
  };

  const cancelQR = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    void authenticatedFetch('/api/gateway/feishu/qr-cancel', { method: 'POST' });
    setQrPhase('idle');
    setSetupMode('choose');
  };

  const handleTest = async () => {
    if (!appId || !appSecret) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await authenticatedFetch('/api/gateway/feishu/test', {
        method: 'POST',
        body: JSON.stringify({ appId, appSecret, domainName: domain }),
      });
      setTestResult(await res.json());
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!appId || !appSecret) return;
    setSaving(true);
    try {
      const res = await authenticatedFetch('/api/gateway/feishu/save', {
        method: 'POST',
        body: JSON.stringify({ appId, appSecret, connectionMode: mode, domainName: domain }),
      });
      const data = await res.json();
      if (data.ok) { onSaved(); setExpanded(false); }
      else setTestResult({ ok: false, error: data.error });
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    try {
      await authenticatedFetch('/api/gateway/feishu/disable', { method: 'POST' });
      onSaved();
    } catch { /* ignore */ }
  };

  const closeExpanded = () => {
    cancelQR();
    setSetupMode('choose');
    setExpanded(false);
  };

  return (
    <SettingsSection title={t('gateway.feishu.title')}>
      <SettingsCard>
        <div className="space-y-4 p-5">
          {/* Status bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium text-foreground">{t('gateway.feishu.label')}</div>
                <div className="text-xs text-muted-foreground">
                  {status.enabled
                    ? `${t('gateway.connected')} · ${status.appId}`
                    : t('gateway.notConfigured')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status.enabled && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  {t('gateway.enabled')}
                </span>
              )}
              {!expanded && (
                <Button variant={status.enabled ? 'ghost' : 'outline'} size="sm" onClick={() => setExpanded(true)}>
                  {status.enabled ? t('gateway.edit') : t('gateway.setup')}
                </Button>
              )}
            </div>
          </div>

          {/* Setup mode chooser */}
          {expanded && setupMode === 'choose' && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">{t('gateway.feishu.chooseMethod')}</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSetupMode('qr')}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <QrCode className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">{t('gateway.feishu.qrScan')}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground">{t('gateway.feishu.qrScanDesc')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupMode('manual')}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <KeyRound className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">{t('gateway.feishu.manualInput')}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground">{t('gateway.feishu.manualInputDesc')}</span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                {status.enabled && (
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={handleDisable}>
                    {t('gateway.disable')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={closeExpanded}>{t('gateway.cancel')}</Button>
              </div>
            </div>
          )}

          {/* QR scan flow */}
          {expanded && setupMode === 'qr' && (
            <div className="space-y-3 border-t border-border pt-4">
              {qrPhase === 'idle' && (
                <div className="space-y-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">{t('gateway.feishu.domain')}</span>
                    <select
                      value={qrDomain}
                      onChange={(e) => setQrDomain(e.target.value as any)}
                      className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    >
                      <option value="feishu">feishu.cn (飞书)</option>
                      <option value="lark">larksuite.com (Lark)</option>
                    </select>
                  </label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={startQR}>
                      <QrCode className="mr-1.5 h-3 w-3" />
                      {t('gateway.feishu.startQr')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSetupMode('choose')}>{t('gateway.cancel')}</Button>
                  </div>
                </div>
              )}

              {qrPhase === 'connecting' && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('gateway.feishu.connecting')}
                </div>
              )}

              {qrPhase === 'scanning' && qrUrl && (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 dark:bg-white">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                      alt="Feishu QR Code"
                      className="h-[200px] w-[200px]"
                    />
                  </div>
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('gateway.feishu.scanPrompt')}
                  </div>
                  <div className="flex justify-center">
                    <Button variant="ghost" size="sm" onClick={cancelQR}>{t('gateway.cancel')}</Button>
                  </div>
                </div>
              )}

              {qrPhase === 'success' && (
                <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                  {t('gateway.feishu.qrSuccess')}
                  <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={closeExpanded}>
                    {t('gateway.dismiss')}
                  </Button>
                </div>
              )}

              {qrPhase === 'error' && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>{qrError}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setQrPhase('idle'); }}>{t('gateway.feishu.retry')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setSetupMode('choose')}>{t('gateway.cancel')}</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Manual config form */}
          {expanded && setupMode === 'manual' && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('gateway.feishu.domain')}</span>
                  <select
                    value={domain}
                    onChange={(e) => setDomain(e.target.value as any)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="feishu">feishu.cn (飞书)</option>
                    <option value="lark">larksuite.com (Lark)</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('gateway.feishu.connectionMode')}</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as any)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="stream">Stream (WebSocket)</option>
                    <option value="webhook">Webhook</option>
                  </select>
                </label>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">App ID</span>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value.trim())}
                  placeholder="cli_xxxxxxxxxxxx"
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">App Secret</span>
                <input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value.trim())}
                  placeholder="••••••••"
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>

              {testResult && (
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg px-3 py-2 text-xs',
                    testResult.ok
                      ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                      : 'bg-red-500/10 text-red-700 dark:text-red-400',
                  )}
                >
                  {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />}
                  <span>{testResult.ok ? testResult.message : testResult.error}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={!appId || !appSecret || testing}>
                  {testing ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Radio className="mr-1.5 h-3 w-3" />}
                  {t('gateway.testConnection')}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!appId || !appSecret || saving}>
                  {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}
                  {t('gateway.save')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSetupMode('choose')}>{t('gateway.cancel')}</Button>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

// ─── Weixin Section ──────────────────────────────────────────────────────────

function WeixinSection({ status, onSaved }: { status: GatewayStatus['weixin']; onSaved: () => void }) {
  const { t } = useTranslation('settings');
  const [phase, setPhase] = useState<'idle' | 'loading-qr' | 'scanning' | 'success' | 'error'>('idle');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startQRLogin = async () => {
    setPhase('loading-qr');
    setError('');
    setQrUrl(null);
    try {
      const res = await authenticatedFetch('/api/gateway/weixin/qr');
      const data = await res.json();
      if (!data.ok) {
        setPhase('error');
        setError(data.error || 'Failed to get QR code');
        return;
      }
      setQrUrl(data.qrUrl);
      setPhase('scanning');

      // Start polling for login result
      pollRef.current = window.setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch('/api/gateway/weixin/qr-poll');
          const pollData = await pollRes.json();
          if (pollData.pending) return;
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (pollData.ok) {
            setPhase('success');
            onSaved();
          } else {
            setPhase('error');
            setError(pollData.error || 'Login failed');
          }
        } catch {
          // Network error, keep polling
        }
      }, 2000);
    } catch (err: any) {
      setPhase('error');
      setError(err.message);
    }
  };

  const handleDisable = async () => {
    try {
      await authenticatedFetch('/api/gateway/weixin/disable', { method: 'POST' });
      onSaved();
    } catch { /* ignore */ }
  };

  return (
    <SettingsSection title={t('gateway.weixin.title')}>
      <SettingsCard>
        <div className="space-y-4 p-5">
          {/* Status bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium text-foreground">{t('gateway.weixin.label')}</div>
                <div className="text-xs text-muted-foreground">
                  {status.enabled && status.hasCredentials
                    ? `${t('gateway.connected')}${status.accountId ? ` · ${status.accountId}` : ''}`
                    : t('gateway.notConfigured')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status.enabled && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  {t('gateway.enabled')}
                </span>
              )}
            </div>
          </div>

          {/* QR Login flow */}
          {phase === 'idle' && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={startQRLogin}>
                <QrCode className="mr-1.5 h-3 w-3" />
                {status.enabled ? t('gateway.weixin.relogin') : t('gateway.weixin.qrLogin')}
              </Button>
              {status.enabled && (
                <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={handleDisable}>
                  {t('gateway.disable')}
                </Button>
              )}
            </div>
          )}

          {phase === 'loading-qr' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('gateway.weixin.loadingQr')}
            </div>
          )}

          {phase === 'scanning' && qrUrl && (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 dark:bg-white">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                  alt="WeChat QR Code"
                  className="h-[200px] w-[200px]"
                />
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('gateway.weixin.scanPrompt')}
              </div>
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                    setPhase('idle');
                  }}
                >
                  {t('gateway.cancel')}
                </Button>
              </div>
            </div>
          )}

          {phase === 'success' && (
            <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              {t('gateway.weixin.loginSuccess')}
              <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={() => setPhase('idle')}>
                {t('gateway.dismiss')}
              </Button>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPhase('idle')}>
                {t('gateway.dismiss')}
              </Button>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

// ─── WeCom Section ────────────────────────────────────────────────────────────

type WeComSetupMode = 'choose' | 'qr' | 'manual';
type WeComQrPhase = 'idle' | 'connecting' | 'scanning' | 'success' | 'error';

function WeComSection({ status, onSaved }: { status: GatewayStatus['wecom']; onSaved: () => void }) {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState(!status.enabled);
  const [setupMode, setSetupMode] = useState<WeComSetupMode>('choose');
  const [qrPhase, setQrPhase] = useState<WeComQrPhase>('idle');
  const [qrUrl, setQrUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const [botId, setBotId] = useState('');
  const [secret, setSecret] = useState('');
  const [websocketUrl, setWebsocketUrl] = useState(status.websocketUrl || 'wss://openws.work.weixin.qq.com');
  const [dmPolicy, setDmPolicy] = useState<WeComAccessPolicy>(normalizeWeComPolicy(status.dmPolicy, 'allowlist'));
  const [groupPolicy, setGroupPolicy] = useState<WeComAccessPolicy>(normalizeWeComPolicy(status.groupPolicy, 'disabled'));
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<TestResult>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    setWebsocketUrl(status.websocketUrl || 'wss://openws.work.weixin.qq.com');
    setDmPolicy(normalizeWeComPolicy(status.dmPolicy, 'allowlist'));
    setGroupPolicy(normalizeWeComPolicy(status.groupPolicy, 'disabled'));
  }, [status]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startQR = async () => {
    setQrPhase('connecting');
    setQrError('');
    setQrUrl('');
    try {
      const res = await authenticatedFetch('/api/gateway/wecom/qr-begin', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setQrPhase('error');
        setQrError(data.error || 'Failed');
        return;
      }
      setQrUrl(data.qrUrl || data.fallbackUrl);
      setQrPhase('scanning');

      pollRef.current = window.setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch('/api/gateway/wecom/qr-poll');
          const pollData = await pollRes.json();
          if (pollData.pending) return;
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (pollData.ok) {
            setQrPhase('success');
            onSaved();
          } else {
            setQrPhase('error');
            setQrError(pollData.error || 'Failed');
          }
        } catch {
          // Network error, keep polling.
        }
      }, 3000);
    } catch (err: any) {
      setQrPhase('error');
      setQrError(err.message);
    }
  };

  const cancelQR = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    void authenticatedFetch('/api/gateway/wecom/qr-cancel', { method: 'POST' });
    setQrPhase('idle');
    setSetupMode('choose');
  };

  const handleSave = async () => {
    if (!botId || !secret) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await authenticatedFetch('/api/gateway/wecom/save', {
        method: 'POST',
        body: JSON.stringify({ botId, secret, websocketUrl, dmPolicy, groupPolicy }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveResult({ ok: true, message: data.message || t('gateway.wecom.saveSuccess') });
        onSaved();
        setExpanded(false);
        setSetupMode('choose');
        setBotId('');
        setSecret('');
      } else {
        setSaveResult({ ok: false, error: data.error || 'Failed' });
      }
    } catch (err: any) {
      setSaveResult({ ok: false, error: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    try {
      await authenticatedFetch('/api/gateway/wecom/disable', { method: 'POST' });
      onSaved();
    } catch { /* ignore */ }
  };

  const closeExpanded = () => {
    cancelQR();
    setSetupMode('choose');
    setExpanded(false);
  };

  return (
    <SettingsSection title={t('gateway.wecom.title')}>
      <SettingsCard>
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-[13px] font-medium text-foreground">{t('gateway.wecom.label')}</div>
                <div className="text-xs text-muted-foreground">
                  {status.enabled && status.hasSecret
                    ? `${t('gateway.connected')}${status.botId ? ` · ${status.botId}` : ''}`
                    : t('gateway.notConfigured')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status.enabled && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  {t('gateway.enabled')}
                </span>
              )}
              {!expanded && (
                <Button variant={status.enabled ? 'ghost' : 'outline'} size="sm" onClick={() => setExpanded(true)}>
                  {status.enabled ? t('gateway.edit') : t('gateway.setup')}
                </Button>
              )}
            </div>
          </div>

          {expanded && setupMode === 'choose' && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">{t('gateway.wecom.chooseMethod')}</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSetupMode('qr')}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <QrCode className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">{t('gateway.wecom.qrSetup')}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground">{t('gateway.wecom.qrSetupDesc')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupMode('manual')}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-4 text-center transition-colors hover:border-ring hover:bg-accent/30"
                >
                  <KeyRound className="h-6 w-6 text-muted-foreground" />
                  <span className="text-[13px] font-medium text-foreground">{t('gateway.wecom.manualInput')}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground">{t('gateway.wecom.manualInputDesc')}</span>
                </button>
              </div>
              <div className="flex items-center gap-2">
                {status.enabled && (
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={handleDisable}>
                    {t('gateway.disable')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={closeExpanded}>{t('gateway.cancel')}</Button>
              </div>
            </div>
          )}

          {expanded && setupMode === 'qr' && (
            <div className="space-y-3 border-t border-border pt-4">
              {qrPhase === 'idle' && (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={startQR}>
                    <QrCode className="mr-1.5 h-3 w-3" />
                    {t('gateway.wecom.startQr')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSetupMode('choose')}>{t('gateway.cancel')}</Button>
                </div>
              )}

              {qrPhase === 'connecting' && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('gateway.wecom.connecting')}
                </div>
              )}

              {qrPhase === 'scanning' && qrUrl && (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 dark:bg-white">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`}
                      alt="WeCom QR Code"
                      className="h-[200px] w-[200px]"
                    />
                  </div>
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('gateway.wecom.scanPrompt')}
                  </div>
                  <div className="flex justify-center">
                    <Button variant="ghost" size="sm" onClick={cancelQR}>{t('gateway.cancel')}</Button>
                  </div>
                </div>
              )}

              {qrPhase === 'success' && (
                <div className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                  {t('gateway.wecom.qrSuccess')}
                  <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={closeExpanded}>
                    {t('gateway.dismiss')}
                  </Button>
                </div>
              )}

              {qrPhase === 'error' && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>{qrError}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setQrPhase('idle')}>{t('gateway.wecom.retry')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setSetupMode('manual')}>{t('gateway.wecom.manualInput')}</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {expanded && setupMode === 'manual' && (
            <div className="space-y-3 border-t border-border pt-4">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t('gateway.wecom.botId')}</span>
                <input
                  type="text"
                  value={botId}
                  onChange={(e) => setBotId(e.target.value.trim())}
                  placeholder="bot_xxxxxxxxxxxx"
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t('gateway.wecom.secret')}</span>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value.trim())}
                  placeholder="••••••••"
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t('gateway.wecom.websocketUrl')}</span>
                <input
                  type="text"
                  value={websocketUrl}
                  onChange={(e) => setWebsocketUrl(e.target.value.trim())}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] font-mono text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('gateway.wecom.dmPolicy')}</span>
                  <select
                    value={dmPolicy}
                    onChange={(e) => setDmPolicy(e.target.value as WeComAccessPolicy)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="allowlist">allowlist</option>
                    <option value="open">open</option>
                    <option value="disabled">disabled</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('gateway.wecom.groupPolicy')}</span>
                  <select
                    value={groupPolicy}
                    onChange={(e) => setGroupPolicy(e.target.value as WeComAccessPolicy)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-3 text-[13px] text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                  >
                    <option value="disabled">disabled</option>
                    <option value="allowlist">allowlist</option>
                    <option value="open">open</option>
                  </select>
                </label>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">{t('gateway.wecom.policyHint')}</p>

              {saveResult && (
                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg px-3 py-2 text-xs',
                    saveResult.ok
                      ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                      : 'bg-red-500/10 text-red-700 dark:text-red-400',
                  )}
                >
                  {saveResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />}
                  <span>{saveResult.ok ? saveResult.message : saveResult.error}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={!botId || !secret || saving}>
                  {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Check className="mr-1.5 h-3 w-3" />}
                  {t('gateway.save')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSetupMode('choose')}>{t('gateway.cancel')}</Button>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function normalizeWeComPolicy(value: string | undefined, fallback: WeComAccessPolicy): WeComAccessPolicy {
  return value === 'open' || value === 'allowlist' || value === 'disabled' ? value : fallback;
}

// ─── Main Tab ────────────────────────────────────────────────────────────────

export default function GatewaySettingsTab() {
  const { t } = useTranslation('settings');
  const { status, loading, refresh } = useGatewayStatus();

  if (loading || !status) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <p className="text-xs leading-5 text-muted-foreground">
        {t('gateway.description')}
      </p>
      <FeishuSection status={status.feishu} onSaved={refresh} />
      <WeixinSection status={status.weixin} onSaved={refresh} />
      <WeComSection status={status.wecom} onSaved={refresh} />
    </div>
  );
}
