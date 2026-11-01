import express from 'express';
import { createUsageStatsReader } from '../services/usageStats.js';

export function createUsageRouter(readStats = createUsageStatsReader()) {
    const router = express.Router();
    router.get('/', async (_req, res) => {
        try {
            res.set('Cache-Control', 'no-store').json(await readStats());
        } catch {
            res.status(500).json({ error: 'usage_stats_unavailable' });
        }
    });
    return router;
}
