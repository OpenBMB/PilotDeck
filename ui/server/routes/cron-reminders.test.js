import express from 'express';
import { expect, it, vi } from 'vitest';
import { createCronReminderRoutes } from './cron-reminders.js';

it('lists without acknowledging and derives dismissal scope from authentication', async () => {
  const gateway = { cronReminderList: vi.fn(async () => ({ reminders: [{ id: 'a'.repeat(64) }] })),
    cronReminderDismiss: vi.fn(async () => ({ dismissed: true })) };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use('/reminders', createCronReminderRoutes({ getGateway: async () => gateway }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/reminders`;
    expect((await (await fetch(base)).json()).scope).toBe('7');
    expect(gateway.cronReminderDismiss).not.toHaveBeenCalled();
    await fetch(`${base}/${'a'.repeat(64)}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'another-account' }) });
    expect(gateway.cronReminderDismiss).toHaveBeenCalledExactlyOnceWith({ scope: '7', id: 'a'.repeat(64) });
    expect((await fetch(`${base}/invalid/dismiss`, { method: 'POST' })).status).toBe(400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
