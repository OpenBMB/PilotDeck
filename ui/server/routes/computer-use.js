import express from 'express';

export function createComputerUseRouter({ service, env = process.env }) {
  const router = express.Router();
  // Local installations can disable JWT auth; that must not make native
  // control callable by arbitrary web origins or a DNS-rebinding Host header.
  router.use((req, res, next) => {
    const origin = req.get('origin');
    try {
      const target = new URL(`${req.protocol}://${req.get('host')}`);
      const loopback = name => ['localhost', '127.0.0.1', '[::1]'].includes(name);
      if (loopback(env.HOST || '') && !loopback(target.hostname)) throw new Error('Invalid host');
      const localMode = !['0', 'false'].includes(env.PILOTDECK_DISABLE_LOCAL_AUTH) || env.VITE_IS_PLATFORM === 'true';
      const localAddress = req.socket.localAddress?.replace(/^::ffff:/, '');
      if (localMode && !loopback(target.hostname) && target.hostname !== env.HOST
        && target.hostname.replace(/^\[|\]$/g, '') !== localAddress) throw new Error('Invalid local host');
      if (req.get('sec-fetch-site') === 'cross-site') throw new Error('Cross-site request');
      if (origin && new URL(origin).origin !== target.origin) {
        const frontend = new URL(origin);
        if (!loopback(frontend.hostname) || !loopback(target.hostname) || frontend.protocol !== target.protocol
          || frontend.port !== String(env.VITE_PORT || 5173)) throw new Error('Invalid origin');
      }
      next();
    } catch { res.status(403).json({ error: 'Computer use requests must come from this PilotDeck instance.' }); }
  });
  const handle = action => async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) { res.status(503).json({ error: error.message || 'Computer use is unavailable' }); }
  };
  router.get('/status', handle(() => service.status()));
  router.post('/refresh', handle(() => service.refresh()));
  router.post('/permission-app/reveal', handle(() => service.revealPermissionApp()));
  router.put('/enabled', (req, res, next) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    next();
  }, handle(req => service.setEnabled(req.body.enabled)));
  router.post('/permissions', (req, res, next) => {
    if (!['accessibility', 'screenRecording'].includes(req.body?.permission)) return res.status(400).json({ error: 'Invalid permission' });
    next();
  }, handle(req => service.requestPermission(req.body.permission)));
  return router;
}
