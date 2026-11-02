import webPush from 'web-push';
import { db, yamlConfig } from '../database/db.js';
import { createECDH } from 'node:crypto';

let cachedKeys = null;

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const validPair = current => {
    try { const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(current.privateKey, 'base64url')); return ecdh.getPublicKey().toString('base64url') === current.publicKey; } catch { return false; }
  };
  const legacyKeys = () => {
    let row;
    try { row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get(); } catch { /* New installation. */ }
    return row ? { publicKey: row.public_key, privateKey: row.private_key } : { publicKey: '', privateKey: '' };
  };
  const existing = yamlConfig.read('webPush', legacyKeys);
  if (validPair(existing)) return cachedKeys = existing;

  cachedKeys = yamlConfig.update('webPush', current => {
    if (validPair(current)) return current;
    if (current.publicKey || current.privateKey) console.warn('[PD_CONFIG_FIELD] credentials/web.yaml (webPush): invalid key pair; generating a valid replacement.');
    return webPush.generateVAPIDKeys();
  }, legacyKeys);
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  try {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@pilotdeck.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
  } catch (error) {
    console.warn(`[PD_CONFIG_WRITE] Web Push is unavailable; the interface remains usable. ${error.code || 'Check credentials/web.yaml and directory permissions.'}`);
  }
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
