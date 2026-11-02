// Direct consumers (including notification delivery) can load this module before
// the server entry point. Resolve the user database path before opening SQLite.
import '../load-env.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createYamlConfiguration } from './yamlConfiguration.js';
import { userConfigurationDirectory } from '../services/userConfiguration.js';
import { readConfiguration, writeConfiguration, updateConfiguration, resolveConfigHome } from '@pilotdeck/config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);
const yamlConfig = createYamlConfiguration(db);

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    if (!db.prepare('PRAGMA table_info(push_subscriptions)').all().some(column => column.name === 'preferences_json')) {
      db.exec("ALTER TABLE push_subscriptions ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}'");
    }
    // Create app_config table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create session_names table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS session_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      custom_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash) => {
    try {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      const result = stmt.run(username, passwordHash);
      return { id: result.lastInsertRowid, username };
    } catch (err) {
      throw err;
    }
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    writeConfiguration(path.join(userConfigurationDirectory(userId), 'git.yaml'), { name: gitName || '', email: gitEmail || '' });
  },
  getGitConfig: userId => {
    const file = path.join(userConfigurationDirectory(userId), 'git.yaml');
    const old = fs.existsSync(file) ? null : db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
    const value = readConfiguration(file, { defaults: { name: old?.git_name || '', email: old?.git_email || '' } }).value;
    return { git_name: value.name, git_email: value.email };
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  }
};

// Legacy tables are imported once per section. Empty lists are authoritative:
// deleting a key must never resurrect it from the old database on next launch.
const oldApiKeys = () => yamlConfig.legacy('SELECT * FROM api_keys');
const oldCredentials = () => yamlConfig.legacy('SELECT * FROM user_credentials');
const apiKeysDb = {
  generateApiKey: () => 'ck_' + crypto.randomBytes(32).toString('hex'),
  createApiKey: (userId, keyName) => {
    const apiKey = apiKeysDb.generateApiKey();
    const row = yamlConfig.insert('apiKeys', { user_id: userId, key_name: keyName, api_key: apiKey, last_used: null }, oldApiKeys);
    return { id: row.id, keyName, apiKey };
  },
  getApiKeys: userId => yamlConfig.read('apiKeys', oldApiKeys).filter(row => row.user_id === userId).sort((a,b) => b.id-a.id),
  validateApiKey: apiKey => {
    const key = yamlConfig.read('apiKeys', oldApiKeys).find(row => row.api_key === apiKey && row.is_active === 1);
    if (!key) return undefined;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ? AND is_active = 1').get(key.user_id);
    if (!user) return undefined;
    yamlConfig.update('apiKeys', rows => rows.map(row => row.id === key.id ? { ...row, last_used: new Date().toISOString() } : row));
    return { ...user, api_key_id: key.id };
  },
  deleteApiKey: (userId, id) => {
    let removed = false;
    yamlConfig.update('apiKeys', rows => rows.filter(row => { const match = row.id === Number(id) && row.user_id === userId; removed ||= match; return !match; }), oldApiKeys);
    return removed;
  },
  toggleApiKey: (userId, id, active) => {
    let changed = false;
    yamlConfig.update('apiKeys', rows => rows.map(row => { if (row.id !== Number(id) || row.user_id !== userId) return row; changed = true; return { ...row, is_active: active ? 1 : 0 }; }), oldApiKeys);
    return changed;
  },
};
const credentialsDb = {
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    const row = yamlConfig.insert('credentials', { user_id: userId, credential_name: credentialName, credential_type: credentialType, credential_value: credentialValue, description }, oldCredentials);
    return { id: row.id, credentialName, credentialType };
  },
  getCredentials: (userId, type = null) => yamlConfig.read('credentials', oldCredentials)
    .filter(row => row.user_id === userId && (!type || row.credential_type === type)).sort((a,b) => b.id-a.id)
    .map(({ credential_value, ...row }) => row),
  getActiveCredential: (userId, type) => yamlConfig.read('credentials', oldCredentials)
    .filter(row => row.user_id === userId && row.credential_type === type && row.is_active === 1).sort((a,b) => b.id-a.id)[0]?.credential_value || null,
  deleteCredential: (userId, id) => {
    let removed = false;
    yamlConfig.update('credentials', rows => rows.filter(row => { const match = row.id === Number(id) && row.user_id === userId; removed ||= match; return !match; }), oldCredentials);
    return removed;
  },
  toggleCredential: (userId, id, active) => {
    let changed = false;
    yamlConfig.update('credentials', rows => rows.map(row => { if (row.id !== Number(id) || row.user_id !== userId) return row; changed = true; return { ...row, is_active: active ? 1 : 0 }; }), oldCredentials);
    return changed;
  },
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true
  }
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false
    }
  };
};

const notificationPreferencesDb = {
  getPreferences: userId => {
    let legacy;
    try { legacy = JSON.parse(db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId)?.preferences_json || 'null'); } catch { /* Invalid legacy data uses defaults. */ }
    const file = path.join(userConfigurationDirectory(userId), 'notifications.yaml');
    return readConfiguration(file, { defaults: fs.existsSync(file) ? DEFAULT_NOTIFICATION_PREFERENCES : normalizeNotificationPreferences(legacy), normalize: normalizeNotificationPreferences }).value;
  },
  updatePreferences: (userId, preferences) => {
    const value = normalizeNotificationPreferences(preferences);
    writeConfiguration(path.join(userConfigurationDirectory(userId), 'notifications.yaml'), value);
    return value;
  },
};

const oldPushSubscriptions = () => yamlConfig.legacy('SELECT * FROM push_subscriptions').map(({preferences_json, ...row}) => {
  let preferences = {}; try { preferences = JSON.parse(preferences_json || '{}'); } catch { /* Invalid legacy options. */ }
  return { ...row, preferences };
});
const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth, preferences = {}) => {
    yamlConfig.update('pushSubscriptions', rows => {
      const previous = rows.find(row => row.endpoint === endpoint);
      const row = { id: previous?.id || Math.max(0, ...rows.map(item => item.id)) + 1, user_id: userId, endpoint, keys_p256dh: keysP256dh, keys_auth: keysAuth, preferences };
      return [...rows.filter(item => item.endpoint !== endpoint), row];
    }, oldPushSubscriptions);
  },
  getSubscriptions: userId => yamlConfig.read('pushSubscriptions', oldPushSubscriptions).filter(row => row.user_id === userId)
    .map(row => ({ endpoint: row.endpoint, keys_p256dh: row.keys_p256dh, keys_auth: row.keys_auth, preferences_json: JSON.stringify(row.preferences || {}) })),
  removeSubscription: (endpoint, userId) => { yamlConfig.update('pushSubscriptions', rows => rows.filter(row => row.endpoint !== endpoint || userId !== undefined && row.user_id !== userId), oldPushSubscriptions); },
  removeAllForUser: userId => { yamlConfig.update('pushSubscriptions', rows => rows.filter(row => row.user_id !== userId), oldPushSubscriptions); },
};

// Session custom names database operations
function sessionNameConfiguration() {
  const file = path.join(resolveConfigHome(), 'session-names.yaml');
  const options = { defaults: { names: [] } };
  if (!fs.existsSync(file)) {
    readConfiguration(file, { defaults: { names: yamlConfig.legacy('SELECT session_id, provider, custom_name FROM session_names') } });
  }
  return { read: () => readConfiguration(file, options).value.names.filter(row => row && typeof row.session_id === 'string' && typeof row.provider === 'string' && typeof row.custom_name === 'string'),
    update: change => updateConfiguration(file, value => ({ ...value, names: change(value.names || []) }), options) };
}
const sessionNamesDb = {
  setName: (sessionId, provider, customName) => { sessionNameConfiguration().update(rows => [...rows.filter(row => row.session_id !== sessionId || row.provider !== provider), { session_id: sessionId, provider, custom_name: customName }]); },
  getName: (sessionId, provider) => sessionNameConfiguration().read().find(row => row.session_id === sessionId && row.provider === provider)?.custom_name || null,
  getNames: (sessionIds, provider) => new Map(sessionNameConfiguration().read().filter(row => row.provider === provider && sessionIds.includes(row.session_id)).map(row => [row.session_id, row.custom_name])),
  deleteName: (sessionId, provider) => {
    let removed = false; sessionNameConfiguration().update(rows => rows.filter(row => { const match = row.session_id === sessionId && row.provider === provider; removed ||= match; return !match; })); return removed;
  },
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// App config database operations
const oldAppConfig = () => Object.fromEntries(yamlConfig.legacy('SELECT key, value FROM app_config').map(row => [row.key, row.value]));
const appConfigDb = {
  get: key => yamlConfig.read('app', oldAppConfig)[key] || null,
  set: (key, value) => { yamlConfig.update('app', current => ({ ...current, [key]: value }), oldAppConfig); },
  getOrCreateJwtSecret: () => yamlConfig.update('app', current => ({ ...current, jwt_secret: current.jwt_secret || crypto.randomBytes(64).toString('hex') }), oldAppConfig).jwt_secret,
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  yamlConfig,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  appConfigDb,
  githubTokensDb // Backward compatibility
};
