import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  clearCodexCredentials,
  exchangeCodexDeviceAuthorization,
  getCodexAuthStatus,
  importCodexCliCredentials,
  pollCodexDeviceCode,
  requestCodexDeviceCode,
} from '../../../src/model/providers/codex/auth.js';
import { CODEX_DEVICE_LOGIN_TIMEOUT_MS } from '../../../src/model/providers/codex/constants.js';

export function createCodexAuthRouter(dependencies = {}) {
  const deps = {
    clearCodexCredentials,
    exchangeCodexDeviceAuthorization,
    getCodexAuthStatus,
    importCodexCliCredentials,
    pollCodexDeviceCode,
    requestCodexDeviceCode,
    now: Date.now,
    uuid: randomUUID,
    ...dependencies,
  };
  const router = express.Router();
  const pending = new Map();

  router.get('/status', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await deps.getCodexAuthStatus()) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/import', async (_req, res) => {
    try {
      const credentials = await deps.importCodexCliCredentials();
      if (!credentials) {
        return res.status(404).json({
          ok: false,
          error: 'No usable Codex credentials were found in ~/.codex/auth.json.',
        });
      }
      return res.json({ ok: true, ...(await deps.getCodexAuthStatus()) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/device/start', async (_req, res) => {
    try {
      pruneExpired(pending, deps.now());
      const device = await deps.requestCodexDeviceCode();
      const state = deps.uuid();
      const expiresAt = deps.now() + CODEX_DEVICE_LOGIN_TIMEOUT_MS;
      pending.set(state, {
        ...device,
        expiresAt,
        nextPollAt: deps.now() + device.intervalMs,
        polling: false,
      });
      res.json({
        ok: true,
        state,
        userCode: device.userCode,
        verificationUrl: device.verificationUrl,
        intervalMs: device.intervalMs,
        expiresAt,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/device/poll', async (req, res) => {
    const state = typeof req.body?.state === 'string' ? req.body.state.trim() : '';
    if (!state) {
      return res.status(400).json({ ok: false, error: 'Device login state is required.' });
    }
    const device = pending.get(state);
    if (!device) {
      return res.status(404).json({ ok: false, error: 'Device login state was not found.' });
    }
    const now = deps.now();
    if (device.expiresAt <= now) {
      pending.delete(state);
      return res.status(410).json({ ok: false, error: 'Codex sign-in expired. Start again.' });
    }
    if (device.polling) {
      return res.status(409).json({
        ok: false,
        pending: true,
        error: 'A device login poll is already in progress.',
      });
    }
    if (now < device.nextPollAt) {
      return res.status(429).json({
        ok: false,
        pending: true,
        retryAfterMs: device.nextPollAt - now,
        error: 'Device login was polled too soon.',
      });
    }

    device.polling = true;
    device.nextPollAt = now + device.intervalMs;
    try {
      const result = await deps.pollCodexDeviceCode(device);
      if (result.status === 'pending') {
        return res.json({ ok: true, pending: true });
      }
      await deps.exchangeCodexDeviceAuthorization(result);
      pending.delete(state);
      return res.json({ ok: true, pending: false, ...(await deps.getCodexAuthStatus()) });
    } catch (error) {
      return sendError(res, error);
    } finally {
      device.polling = false;
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deps.clearCodexCredentials();
      res.json({ ok: true, authenticated: false });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

function pruneExpired(pending, now) {
  for (const [state, device] of pending.entries()) {
    if (device.expiresAt <= now) pending.delete(state);
  }
}

function sendError(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  return res.status(status).json({
    ok: false,
    code: typeof error?.code === 'string' ? error.code : 'codex_auth_error',
    error: error instanceof Error ? error.message : String(error),
  });
}

export default createCodexAuthRouter();
