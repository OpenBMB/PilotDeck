import express from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { readPilotDeckConfigFile } from '../services/pilotdeckConfig.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

const PILOT_HOME = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
const PILOTDECK_YAML = process.env.PILOTDECK_CONFIG_PATH || join(PILOT_HOME, 'pilotdeck.yaml');
const WEIXIN_CREDS = join(PILOT_HOME, 'weixin-credentials.json');

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const WECOM_DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';
const WECOM_QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate';
const WECOM_QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result';
const WECOM_QR_CODE_PAGE = 'https://work.weixin.qq.com/ai/qc/gen?source=hermes&scode=';
const WECOM_QR_TIMEOUT_MS = 300_000;

const FEISHU_ACCOUNTS_URLS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};
const FEISHU_OPEN_URLS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};
const REGISTRATION_PATH = '/oauth/v1/app/registration';

async function notifyGatewayReload() {
  try {
    const gw = await getPilotDeckGateway();
    if (gw?.reloadConfig) await gw.reloadConfig();
  } catch { /* gateway unreachable */ }
}

function loadYaml() {
  try {
    if (!existsSync(PILOTDECK_YAML)) return {};
    return parseYaml(readFileSync(PILOTDECK_YAML, 'utf-8')) ?? {};
  } catch { return {}; }
}

function saveYaml(config) {
  mkdirSync(dirname(PILOTDECK_YAML), { recursive: true });
  suppressNextWatchEvent();
  writeFileSync(PILOTDECK_YAML, stringifyYaml(config, { lineWidth: 0 }), 'utf-8');
}

function maskValue(value) {
  if (!value || value.length <= 8) return value || '';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeAccessPolicy(value, fallback) {
  return ['open', 'allowlist', 'disabled'].includes(value) ? value : fallback;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function writeWeComConfig(config, input) {
  if (!config.adapters) config.adapters = {};
  const previous = config.adapters.wecom ?? {};
  const previousExtra = previous.extra ?? {};
  const dmPolicy = normalizeAccessPolicy(input.dmPolicy, 'open');
  const groupPolicy = normalizeAccessPolicy(input.groupPolicy, 'disabled');
  const extra = {
    secret: input.secret || previousExtra.secret || '',
    websocket_url: input.websocketUrl || previousExtra.websocket_url || previousExtra.websocketUrl || WECOM_DEFAULT_WS_URL,
    dm_policy: dmPolicy,
    group_policy: groupPolicy,
  };
  const allowFrom = normalizeList(input.allowFrom ?? previousExtra.allow_from ?? previousExtra.allowFrom);
  const groupAllowFrom = normalizeList(input.groupAllowFrom ?? previousExtra.group_allow_from ?? previousExtra.groupAllowFrom);
  if (dmPolicy === 'allowlist') extra.allow_from = allowFrom;
  if (groupPolicy === 'allowlist') extra.group_allow_from = groupAllowFrom;
  config.adapters.wecom = {
    enabled: true,
    token: input.botId || previous.token || '',
    extra,
  };
  return config;
}

async function persistConfigAndReload(config) {
  saveYaml(config);
  const record = readPilotDeckConfigFile();
  await reloadPilotDeckConfig(record.config);
  void notifyGatewayReload();
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'PilotDeck/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`); }
}

// ─── Status ──────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  try {
    const config = loadYaml();
    const feishu = config.adapters?.feishu ?? {};
    const wecom = config.adapters?.wecom ?? {};
    const wecomExtra = wecom.extra ?? {};
    const weixinEnabled = config.adapters?.weixin?.enabled === true;

    let weixinCredentials = null;
    try {
      if (existsSync(WEIXIN_CREDS)) {
        const raw = JSON.parse(readFileSync(WEIXIN_CREDS, 'utf-8'));
        if (raw.accountId) {
          weixinCredentials = { accountId: raw.accountId };
        }
      }
    } catch { /* ignore */ }

    res.json({
      feishu: {
        enabled: feishu.enabled === true,
        appId: feishu.appId ? maskValue(feishu.appId) : '',
        hasSecret: !!feishu.appSecret,
        connectionMode: feishu.connectionMode || 'stream',
        domainName: feishu.domainName || 'feishu',
      },
      weixin: {
        enabled: weixinEnabled,
        hasCredentials: !!weixinCredentials,
        accountId: weixinCredentials?.accountId || null,
      },
      wecom: {
        enabled: wecom.enabled === true,
        botId: wecom.token ? maskValue(wecom.token) : '',
        hasSecret: !!wecomExtra.secret,
        websocketUrl: wecomExtra.websocket_url || wecomExtra.websocketUrl || WECOM_DEFAULT_WS_URL,
        dmPolicy: wecomExtra.dm_policy || wecomExtra.dmPolicy || 'open',
        groupPolicy: wecomExtra.group_policy || wecomExtra.groupPolicy || 'disabled',
        allowFrom: normalizeList(wecomExtra.allow_from ?? wecomExtra.allowFrom),
        groupAllowFrom: normalizeList(wecomExtra.group_allow_from ?? wecomExtra.groupAllowFrom),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Feishu ──────────────────────────────────────────────────────────────────

router.post('/feishu/test', async (req, res) => {
  const { appId, appSecret, domainName } = req.body || {};
  if (!appId || !appSecret) {
    return res.status(400).json({ ok: false, error: 'appId and appSecret are required' });
  }

  const tokenUrl = domainName === 'lark' ? LARK_TOKEN_URL : FEISHU_TOKEN_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = await response.json();
    if (json.code === 0 && json.tenant_access_token) {
      return res.json({ ok: true, message: '凭据验证通过' });
    }
    return res.json({ ok: false, error: `code=${json.code} msg=${json.msg || 'unknown'}` });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.json({ ok: false, error: '连接超时 (10s)' });
    }
    return res.json({ ok: false, error: err.message });
  }
});

// ─── Feishu QR scan-to-create (device code flow) ─────────────────────────────

async function postRegistration(domain, body) {
  const baseUrl = FEISHU_ACCOUNTS_URLS[domain] || FEISHU_ACCOUNTS_URLS.feishu;
  const url = `${baseUrl}${REGISTRATION_PATH}`;
  const formBody = new URLSearchParams(body).toString();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`); }
}

router.post('/feishu/qr-begin', async (req, res) => {
  const { domainName } = req.body || {};
  const domain = domainName === 'lark' ? 'lark' : 'feishu';
  try {
    const initRes = await postRegistration(domain, { action: 'init' });
    const methods = initRes.supported_auth_methods || [];
    if (!methods.includes('client_secret')) {
      return res.json({ ok: false, error: `Registration env does not support client_secret. Supported: ${methods.join(', ')}` });
    }

    const beginRes = await postRegistration(domain, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
    const deviceCode = beginRes.device_code;
    if (!deviceCode) {
      return res.json({ ok: false, error: 'Feishu did not return a device_code' });
    }

    const qrUrl = beginRes.verification_uri_complete || '';

    // Store state for polling
    req.app.locals._feishuQr = {
      deviceCode,
      domain,
      interval: beginRes.interval || 5,
      expireIn: beginRes.expire_in || 600,
      startedAt: Date.now(),
    };

    res.json({
      ok: true,
      qrUrl,
      userCode: beginRes.user_code || '',
      expireIn: beginRes.expire_in || 600,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/feishu/qr-poll', async (req, res) => {
  const state = req.app.locals._feishuQr;
  if (!state) {
    return res.json({ ok: false, error: 'No QR session active' });
  }

  const elapsed = (Date.now() - state.startedAt) / 1000;
  if (elapsed > state.expireIn) {
    req.app.locals._feishuQr = null;
    return res.json({ ok: false, error: 'QR code expired' });
  }

  try {
    const pollRes = await postRegistration(state.domain, {
      action: 'poll',
      device_code: state.deviceCode,
      tp: 'ob_app',
    });

    // Auto-detect lark tenant
    const userInfo = pollRes.user_info || {};
    if (userInfo.tenant_brand === 'lark') {
      state.domain = 'lark';
    }

    // Success — got credentials
    if (pollRes.client_id && pollRes.client_secret) {
      req.app.locals._feishuQr = null;

      const appId = pollRes.client_id;
      const appSecret = pollRes.client_secret;
      const domain = state.domain;

      // Auto-save to config
      const config = loadYaml();
      if (!config.adapters) config.adapters = {};
      config.adapters.feishu = {
        enabled: true,
        appId,
        appSecret,
        connectionMode: 'stream',
        domainName: domain,
      };
      saveYaml(config);

      const record = readPilotDeckConfigFile();
      await reloadPilotDeckConfig(record.config);
      void notifyGatewayReload();

      return res.json({
        ok: true,
        appId,
        domain,
        openId: userInfo.open_id || null,
      });
    }

    // Terminal errors
    const error = pollRes.error || '';
    if (error === 'access_denied' || error === 'expired_token') {
      req.app.locals._feishuQr = null;
      return res.json({ ok: false, error: `Registration ${error}` });
    }

    // Still pending
    res.json({ pending: true });
  } catch (err) {
    res.json({ pending: true });
  }
});

router.post('/feishu/qr-cancel', (req, res) => {
  req.app.locals._feishuQr = null;
  res.json({ ok: true });
});

router.post('/feishu/save', async (req, res) => {
  const { appId, appSecret, connectionMode, domainName } = req.body || {};
  if (!appId || !appSecret) {
    return res.status(400).json({ ok: false, error: 'appId and appSecret are required' });
  }

  try {
    const config = loadYaml();
    if (!config.adapters) config.adapters = {};
    config.adapters.feishu = {
      enabled: true,
      appId,
      appSecret,
      connectionMode: connectionMode || 'stream',
      domainName: domainName || 'feishu',
    };
    saveYaml(config);

    const record = readPilotDeckConfigFile();
    await reloadPilotDeckConfig(record.config);
    void notifyGatewayReload();

    res.json({ ok: true, message: '飞书配置已保存，重启后生效' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/feishu/disable', async (_req, res) => {
  try {
    const config = loadYaml();
    if (config.adapters?.feishu) {
      config.adapters.feishu.enabled = false;
    }
    saveYaml(config);

    const record = readPilotDeckConfigFile();
    await reloadPilotDeckConfig(record.config);
    void notifyGatewayReload();

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── Weixin ──────────────────────────────────────────────────────────────────

router.get('/weixin/qr', async (_req, res) => {
  try {
    const { loginWithQR } = await import('weixin-ilink');

    let qrUrl = null;
    let resolved = false;

    const loginPromise = loginWithQR({
      onQRCode: (url) => {
        qrUrl = url;
        if (!resolved) {
          resolved = true;
          res.json({ ok: true, qrUrl: url });
        }
      },
      onStatusChange: () => {},
    });

    // Store the login promise so /weixin/qr-poll can check it
    _req.app.locals._weixinLoginPromise = loginPromise;
    _req.app.locals._weixinLoginResolved = false;

    loginPromise
      .then((result) => {
        _req.app.locals._weixinLoginResult = {
          ok: true,
          accountId: result.accountId,
          baseUrl: result.baseUrl,
          botToken: result.botToken,
        };
        _req.app.locals._weixinLoginResolved = true;

        // Auto-save credentials
        mkdirSync(PILOT_HOME, { recursive: true });
        writeFileSync(WEIXIN_CREDS, JSON.stringify({
          baseUrl: result.baseUrl,
          botToken: result.botToken,
          accountId: result.accountId,
        }, null, 2), 'utf-8');

        // Enable in config
        const config = loadYaml();
        if (!config.adapters) config.adapters = {};
        config.adapters.weixin = { enabled: true };
        saveYaml(config);
      })
      .catch((err) => {
        _req.app.locals._weixinLoginResult = {
          ok: false,
          error: err.message || String(err),
        };
        _req.app.locals._weixinLoginResolved = true;
      });

    // Fallback: if QR URL wasn't ready in 15s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        res.json({ ok: false, error: '获取二维码超时' });
      }
    }, 15_000);
  } catch (error) {
    res.json({ ok: false, error: error.message || 'weixin-ilink 模块加载失败' });
  }
});

router.get('/weixin/qr-poll', (_req, res) => {
  const resolved = _req.app.locals._weixinLoginResolved;
  const result = _req.app.locals._weixinLoginResult;

  if (resolved && result) {
    // Clear state
    _req.app.locals._weixinLoginPromise = null;
    _req.app.locals._weixinLoginResult = null;
    _req.app.locals._weixinLoginResolved = false;
    return res.json(result);
  }

  res.json({ pending: true });
});

router.post('/weixin/disable', async (_req, res) => {
  try {
    const config = loadYaml();
    if (config.adapters?.weixin) {
      config.adapters.weixin.enabled = false;
    }
    saveYaml(config);

    const record = readPilotDeckConfigFile();
    await reloadPilotDeckConfig(record.config);
    void notifyGatewayReload();

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── WeCom (Enterprise WeChat AI Bot) ─────────────────────────────────────────

router.post('/wecom/qr-begin', async (req, res) => {
  try {
    const raw = await fetchJson(`${WECOM_QR_GENERATE_URL}?source=hermes`);
    const data = raw.data || {};
    const scode = String(data.scode || '').trim();
    const authUrl = String(data.auth_url || '').trim();
    if (!scode || !authUrl) {
      return res.json({ ok: false, error: 'WeCom did not return a QR code' });
    }

    req.app.locals._wecomQr = {
      scode,
      startedAt: Date.now(),
      expireInMs: WECOM_QR_TIMEOUT_MS,
    };

    res.json({
      ok: true,
      qrUrl: authUrl,
      fallbackUrl: `${WECOM_QR_CODE_PAGE}${encodeURIComponent(scode)}`,
      expireIn: Math.floor(WECOM_QR_TIMEOUT_MS / 1000),
    });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

router.get('/wecom/qr-poll', async (req, res) => {
  const state = req.app.locals._wecomQr;
  if (!state) {
    return res.json({ ok: false, error: 'No WeCom QR session active' });
  }

  if (Date.now() - state.startedAt > state.expireInMs) {
    req.app.locals._wecomQr = null;
    return res.json({ ok: false, error: 'WeCom QR code expired' });
  }

  try {
    const raw = await fetchJson(`${WECOM_QR_QUERY_URL}?scode=${encodeURIComponent(state.scode)}`);
    const data = raw.data || {};
    const status = String(data.status || '').toLowerCase();
    if (status !== 'success') {
      return res.json({ pending: true });
    }

    const botInfo = data.bot_info || {};
    const botId = String(botInfo.botid || botInfo.bot_id || '').trim();
    const secret = String(botInfo.secret || '').trim();
    if (!botId || !secret) {
      req.app.locals._wecomQr = null;
      return res.json({ ok: false, error: 'WeCom QR scan did not return complete bot credentials' });
    }

    req.app.locals._wecomQr = null;
    const config = writeWeComConfig(loadYaml(), {
      botId,
      secret,
      websocketUrl: WECOM_DEFAULT_WS_URL,
      dmPolicy: 'open',
      groupPolicy: 'disabled',
    });
    await persistConfigAndReload(config);

    res.json({ ok: true, botId: maskValue(botId) });
  } catch {
    res.json({ pending: true });
  }
});

router.post('/wecom/qr-cancel', (req, res) => {
  req.app.locals._wecomQr = null;
  res.json({ ok: true });
});

router.post('/wecom/save', async (req, res) => {
  const {
    botId,
    secret,
    websocketUrl,
    dmPolicy,
    groupPolicy,
    allowFrom,
    groupAllowFrom,
  } = req.body || {};
  const existing = loadYaml();
  const existingWeCom = existing.adapters?.wecom ?? {};
  const existingExtra = existingWeCom.extra ?? {};
  const normalizedBotId = String(botId || '').trim();
  const normalizedSecret = String(secret || '').trim();
  const resolvedBotId = normalizedBotId || String(existingWeCom.token || '').trim();
  const resolvedSecret = normalizedSecret || String(existingExtra.secret || '').trim();
  if (!resolvedBotId || !resolvedSecret) {
    return res.status(400).json({ ok: false, error: 'botId and secret are required' });
  }

  try {
    const config = writeWeComConfig(existing, {
      botId: resolvedBotId,
      secret: resolvedSecret,
      websocketUrl: String(websocketUrl || '').trim() || WECOM_DEFAULT_WS_URL,
      dmPolicy,
      groupPolicy,
      allowFrom,
      groupAllowFrom,
    });
    await persistConfigAndReload(config);
    res.json({ ok: true, message: 'WeCom config saved' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/wecom/disable', async (_req, res) => {
  try {
    const config = loadYaml();
    if (config.adapters?.wecom) {
      config.adapters.wecom.enabled = false;
    }
    await persistConfigAndReload(config);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
