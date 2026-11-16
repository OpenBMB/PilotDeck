import express from 'express';

/** Acknowledgement endpoints never modify conversation read state or task schedules. */
export function createCronReminderRoutes({ getGateway }) {
  const router = express.Router();
  const scope = req => String(req.user?.id ?? 'local');
  router.get('/', async (req, res) => {
    try {
      const gateway = await getGateway();
      const result = await gateway.cronReminderList({ scope: scope(req) });
      res.json({ ...result, scope: scope(req) });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  router.post('/:id/dismiss', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid reminder ID.' });
    try {
      const gateway = await getGateway();
      const result = await gateway.cronReminderDismiss({ id: req.params.id, scope: scope(req) });
      res.status(result.dismissed ? 200 : 404).json(result);
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  return router;
}
