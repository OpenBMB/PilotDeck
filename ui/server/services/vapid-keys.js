import webPush from 'web-push';
import { db, yamlConfig } from '../database/db.js';

let cachedKeys = null;

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  cachedKeys = yamlConfig.update('webPush', current => current.publicKey && current.privateKey ? current : webPush.generateVAPIDKeys(), () => {
    let row;
    try { row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get(); } catch { /* New installation. */ }
    return row ? { publicKey: row.public_key, privateKey: row.private_key } : { publicKey: '', privateKey: '' };
  });
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@pilotdeck.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
