import webPush from 'web-push';
import { db, yamlConfig } from '../database/db.js';
import { createECDH } from 'node:crypto';

let cachedKeys = null;

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  cachedKeys = yamlConfig.update('webPush', current => {
    try {
      const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(current.privateKey, 'base64url'));
      if (ecdh.getPublicKey().toString('base64url') === current.publicKey) return current;
    } catch { /* Repair only the invalid cryptographic key pair. */ }
    if (current.publicKey || current.privateKey) console.warn('[PD_CONFIG_FIELD] credentials/web.yaml (webPush): invalid key pair; generating a valid replacement.');
    return webPush.generateVAPIDKeys();
  }, () => {
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
