import express from 'express';
import { createUserPreferences } from '../services/userPreferences.js';
import { userConfigurationDirectory } from '../services/userPreferences.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const router = express.Router();
const imagePath = req => {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(png|webp)$/i.test(req.params.id)) throw Object.assign(new Error('Invalid image ID'), { status: 400 });
  return path.join(userConfigurationDirectory(req.user.id), 'appearance-images', req.params.id);
};
router.get('/images/:id', async (req, res, next) => {
  try { const file = imagePath(req); res.set('Cache-Control', 'private, max-age=3600').sendFile(file, error => { if (error) next(error); }); } catch (error) { next(error); }
});
router.put('/images/:id', express.raw({ type: ['image/png', 'image/webp'], limit: '10mb' }), async (req, res, next) => {
  try {
    const file = imagePath(req), bytes = req.body;
    const png = Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp = Buffer.isBuffer(bytes) && bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!png && !webp) return res.status(400).json({ error: 'Invalid image' });
    if (png && (bytes.readUInt32BE(16) > 3840 || bytes.readUInt32BE(20) > 3840)) return res.status(400).json({ error: 'Image dimensions exceed the limit' });
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
    res.json({ saved: true });
  } catch (error) { next(error); }
});
router.delete('/images/:id', async (req, res, next) => {
  try { await fs.rm(imagePath(req), { force: true }); res.json({ deleted: true }); } catch (error) { next(error); }
});
router.get('/', (req, res, next) => {
  try { res.json({ userId: req.user.id, entries: createUserPreferences(req.user.id).read() }); } catch (error) { next(error); }
});
router.patch('/', (req, res, next) => {
  try { res.json({ entries: createUserPreferences(req.user.id).update(req.body.changes, req.body.migrate === true) }); }
  catch (error) { if (error.message.startsWith('Invalid preference')) return res.status(400).json({ error: error.message }); next(error); }
});
export default router;
