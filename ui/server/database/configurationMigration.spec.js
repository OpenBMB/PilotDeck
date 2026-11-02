// @vitest-environment node
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import { readConfiguration } from '@pilotdeck/config';

it('migrates a real legacy database and preserves credentials, settings and deletion across reloads', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-db-upgrade-'));
  const previous = { ...process.env }, databasePath = path.join(home, 'auth.db');
  let imported;
  try {
    process.env.PILOT_HOME = home; process.env.PILOTDECK_CONFIG_PATH = path.join(home, 'pilotdeck.yaml'); process.env.DATABASE_PATH = databasePath;
    const legacy = new Database(databasePath);
    legacy.exec(fs.readFileSync(new URL('./init.sql', import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO users(id,username,password_hash,git_name,git_email) VALUES(1,?,?,?,?)').run('alice','hash','Alice','alice@example.test');
    legacy.prepare('INSERT INTO api_keys(id,user_id,key_name,api_key) VALUES(7,1,?,?)').run('old-key','legacy-api-secret');
    legacy.prepare('INSERT INTO user_credentials(id,user_id,credential_name,credential_type,credential_value) VALUES(8,1,?,?,?)').run('github','github_token','legacy-github-secret');
    legacy.prepare('INSERT INTO app_config(key,value) VALUES(?,?)').run('jwt_secret','stable-jwt-secret');
    const keys = webPush.generateVAPIDKeys();
    legacy.prepare('INSERT INTO vapid_keys(public_key,private_key) VALUES(?,?)').run(keys.publicKey,keys.privateKey);
    legacy.prepare('INSERT INTO session_names(session_id,provider,custom_name) VALUES(?,?,?)').run('session','pilotdeck','My title');
    legacy.close();
    imported = await import('./db.js');
    const { apiKeysDb, credentialsDb, appConfigDb, userDb, sessionNamesDb, pushSubscriptionsDb, notificationPreferencesDb } = imported;
    expect(apiKeysDb.getApiKeys(1)[0].api_key).toBe('legacy-api-secret');
    expect(apiKeysDb.validateApiKey('legacy-api-secret').id).toBe(1);
    expect(credentialsDb.getActiveCredential(1,'github_token')).toBe('legacy-github-secret');
    expect(credentialsDb.getCredentials(1)[0]).not.toHaveProperty('credential_value');
    expect(appConfigDb.getOrCreateJwtSecret()).toBe('stable-jwt-secret');
    const vapid = await import('../services/vapid-keys.js'); expect(vapid.ensureVapidKeys()).toEqual(keys);
    expect(userDb.getGitConfig(1)).toEqual({git_name:'Alice',git_email:'alice@example.test'});
    userDb.updateGitConfig(1,'New name','new@example.test'); expect(userDb.getGitConfig(1).git_name).toBe('New name');
    expect(sessionNamesDb.getName('session','pilotdeck')).toBe('My title');
    sessionNamesDb.deleteName('session','pilotdeck'); expect(sessionNamesDb.getName('session','pilotdeck')).toBeNull();
    notificationPreferencesDb.updatePreferences(1,{channels:{inApp:true},events:{error:false}});
    expect(notificationPreferencesDb.getPreferences(1).events.error).toBe(false);
    pushSubscriptionsDb.saveSubscription(1,'https://push.example.test/endpoint','public','auth-secret',{stop:true});
    expect(pushSubscriptionsDb.getSubscriptions(1)[0].keys_auth).toBe('auth-secret');
    pushSubscriptionsDb.removeAllForUser(1); expect(pushSubscriptionsDb.getSubscriptions(1)).toEqual([]);
    apiKeysDb.deleteApiKey(1,7); credentialsDb.deleteCredential(1,8);
    expect(apiKeysDb.getApiKeys(1)).toEqual([]); expect(credentialsDb.getActiveCredential(1,'github_token')).toBeNull();
    expect(apiKeysDb.createApiKey(1,'new').id).toBeGreaterThan(7);
    expect(readConfiguration(path.join(home,'credentials/web.yaml')).value.app.jwt_secret).toBe('stable-jwt-secret');
    expect(fs.existsSync(path.join(home,'users/1/git.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(home,'users/1/notifications.yaml'))).toBe(true);
  } finally {
    imported?.db.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    fs.rmSync(home,{recursive:true,force:true});
  }
}, 20000);
