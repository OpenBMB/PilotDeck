import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
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
const DEFAULT_PILOT_HOME_DB_PATH = path.join(
  process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck'),
  'auth.db',
);
const shouldMigrateLegacyDatabase = path.resolve(DB_PATH) === path.resolve(DEFAULT_PILOT_HOME_DB_PATH);
if (shouldMigrateLegacyDatabase && DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
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

const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    console.log(`Running migration: Adding ${table}.${column}`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

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

    ensureColumn('users', 'display_name', 'TEXT');
    ensureColumn('users', 'system_role', "TEXT NOT NULL DEFAULT 'member'");
    ensureColumn('users', 'must_change_password', 'BOOLEAN NOT NULL DEFAULT 0');
    ensureColumn('users', 'updated_at', 'DATETIME');

    db.exec(`
      UPDATE users SET display_name = COALESCE(NULLIF(display_name, ''), username);
      UPDATE users SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP);
      UPDATE users SET system_role = 'member'
        WHERE system_role IS NULL OR system_role NOT IN ('owner', 'admin', 'member');
      UPDATE users SET system_role = 'owner'
        WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM users WHERE system_role = 'owner');
    `);

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

    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        csrf_hash TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        idle_expires_at DATETIME NOT NULL,
        absolute_expires_at DATETIME NOT NULL,
        revoked_at DATETIME,
        user_agent TEXT,
        ip_hash TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
        ON auth_sessions(user_id, revoked_at, idle_expires_at);
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        event_type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        outcome TEXT NOT NULL DEFAULT 'success',
        ip_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_created
        ON audit_events(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS project_access (
        project_path TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        granted_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_path, user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS session_owners (
        session_key TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS user_tool_permissions (
        user_id INTEGER PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{"version":1,"allowedTools":[],"disallowedTools":[],"skipPermissions":false}',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_owners_user_project
        ON session_owners(user_id, project_path);
      CREATE TABLE IF NOT EXISTS pilotdeck_instances (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
        endpoint TEXT,
        status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
        is_default BOOLEAN NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        approved_by INTEGER,
        approved_at DATETIME,
        last_checked_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pilotdeck_instances_owner
        ON pilotdeck_instances(owner_user_id, status, is_default);
      CREATE TABLE IF NOT EXISTS pilotdeck_instance_secrets (
        instance_id TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (instance_id) REFERENCES pilotdeck_instances(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS pilotdeck_instance_projects (
        instance_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (instance_id, project_path),
        FOREIGN KEY (instance_id) REFERENCES pilotdeck_instances(id) ON DELETE CASCADE
      );
    `);

    // Group-chat v2 keeps human ownership, entry-agent selection, and every
    // visible collaboration step durable. `init.sql` handles new installs;
    // these guards upgrade rooms created by the first group-chat MVP.
    ensureColumn('group_messages', 'sequence', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('group_messages', 'message_kind', "TEXT NOT NULL DEFAULT 'chat'");
    ensureColumn('group_messages', 'sender_user_id', 'INTEGER');
    ensureColumn('group_messages', 'reply_to_message_id', 'TEXT');
    ensureColumn('group_messages', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn('group_rooms', 'owner_user_id', 'INTEGER');
    ensureColumn('group_rooms', 'coordinator_instance_id', 'TEXT');
    ensureColumn('group_members', 'instance_id', 'TEXT');
    ensureColumn('group_turns', 'message_sequence', 'INTEGER');
    ensureColumn('group_turns', 'idempotency_key', 'TEXT');
    ensureColumn('group_turns', 'required_delegates_json', "TEXT NOT NULL DEFAULT '[]'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_conversations (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '新会话',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_by_user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_group_conversations_room_activity
        ON group_conversations(room_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS group_conversation_read_state (
        user_id INTEGER NOT NULL,
        room_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, conversation_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES group_conversations(id) ON DELETE CASCADE
      );
    `);

    ensureColumn('group_messages', 'conversation_id', 'TEXT');
    ensureColumn('group_turns', 'conversation_id', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_turns (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        conversation_id TEXT,
        sender_user_id INTEGER NOT NULL,
        entry_member_id TEXT NOT NULL,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('auto', 'mentions')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_group_turns_room_created
        ON group_turns(room_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_group_messages_room_sequence
        ON group_messages(room_id, sequence, id);
    `);

    const participantSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'group_participants'
    `).get()?.sql || '';
    if (!participantSql.includes("'moderator'") || !participantSql.includes('bound_instance_id')) {
      console.log('Running migration: Upgrading group_participants for multi-user roles');
      db.exec(`
        CREATE TABLE group_participants_v3 (
          room_id TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          display_name TEXT NOT NULL,
          bound_member_id TEXT NOT NULL DEFAULT 'main',
          bound_instance_id TEXT,
          role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
          muted BOOLEAN NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (room_id, user_id),
          FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO group_participants_v3 (
          room_id, user_id, display_name, bound_member_id, role, status, created_at, updated_at
        )
        SELECT room_id, user_id, display_name, bound_member_id, role, status, created_at, updated_at
        FROM group_participants;
        DROP TABLE group_participants;
        ALTER TABLE group_participants_v3 RENAME TO group_participants;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS group_delegation_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        entry_instance_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (turn_id) REFERENCES group_turns(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_turns_room_idempotency
        ON group_turns(room_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      UPDATE group_rooms SET owner_user_id = COALESCE(owner_user_id, user_id);
      INSERT OR IGNORE INTO pilotdeck_instances (
        id, owner_user_id, name, kind, status, is_default, capabilities_json, approved_by, approved_at
      )
      SELECT 'local-user-' || id, id, COALESCE(NULLIF(display_name, ''), username) || ' 的 PilotDeck',
        'local', 'approved', 1, '{"groupTurn":true,"delegation":true}', id, CURRENT_TIMESTAMP
      FROM users;
      UPDATE group_participants
      SET bound_instance_id = COALESCE(bound_instance_id, 'local-user-' || user_id);
      UPDATE group_rooms
      SET coordinator_instance_id = COALESCE(
        coordinator_instance_id,
        'local-user-' || COALESCE(owner_user_id, user_id)
      );
      UPDATE group_members
      SET instance_id = COALESCE(
        instance_id,
        (SELECT p.bound_instance_id FROM group_participants p
          WHERE p.room_id = group_members.room_id
            AND p.bound_member_id = group_members.id
            AND p.status = 'active'
          LIMIT 1)
      )
      WHERE kind IN ('pilotdeck_main', 'pilotdeck_local', 'pilotdeck_remote');
      UPDATE group_members
      SET kind = 'pilotdeck_remote'
      WHERE id = 'main'
        AND instance_id IN (SELECT id FROM pilotdeck_instances WHERE kind = 'remote');
      UPDATE group_members
      SET is_active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE kind IN ('pilotdeck_local', 'staffdeck_mock')
        AND is_active = 1;
    `);

    db.exec(`
      INSERT OR IGNORE INTO group_participants (
        room_id, user_id, display_name, bound_member_id, role, status,
        created_at, updated_at
      )
      SELECT r.id, r.user_id, COALESCE(u.username, '你'), 'main', 'owner', 'active',
        r.created_at, r.updated_at
      FROM group_rooms r
      LEFT JOIN users u ON u.id = r.user_id
    `);

    // A room used to be its own single conversation. Give every existing room
    // one deterministic default conversation and attach its complete timeline
    // before any conversation-scoped indexes or queries are used.
    db.exec(`
      INSERT OR IGNORE INTO group_conversations (
        id, room_id, title, status, created_by_user_id, created_at, updated_at
      )
      SELECT
        'group-conversation-' || r.id,
        r.id,
        COALESCE(
          NULLIF(TRIM(SUBSTR((
            SELECT gm.content FROM group_messages gm
            WHERE gm.room_id = r.id
              AND gm.sender_type = 'user'
              AND gm.message_kind = 'chat'
            ORDER BY gm.created_at ASC, gm.rowid ASC LIMIT 1
          ), 1, 60)), ''),
          '默认会话'
        ),
        'active',
        COALESCE(r.owner_user_id, r.user_id),
        r.created_at,
        r.updated_at
      FROM group_rooms r;

      UPDATE group_messages
      SET conversation_id = 'group-conversation-' || room_id
      WHERE conversation_id IS NULL OR conversation_id = '';

      UPDATE group_turns
      SET conversation_id = 'group-conversation-' || room_id
      WHERE conversation_id IS NULL OR conversation_id = '';

      INSERT OR IGNORE INTO group_conversation_read_state (
        user_id, room_id, conversation_id, last_read_at
      )
      SELECT p.user_id, p.room_id, c.id,
        COALESCE(rs.last_read_at, c.created_at)
      FROM group_participants p
      JOIN group_conversations c ON c.room_id = p.room_id AND c.status = 'active'
      LEFT JOIN group_read_state rs ON rs.user_id = p.user_id AND rs.room_id = p.room_id
      WHERE p.status = 'active';

      CREATE INDEX IF NOT EXISTS idx_group_messages_conversation_sequence
        ON group_messages(conversation_id, sequence, id);
      CREATE INDEX IF NOT EXISTS idx_group_turns_conversation_created
        ON group_turns(conversation_id, created_at, id);
    `);

    const roomsNeedingSequence = db.prepare(`
      SELECT DISTINCT room_id FROM group_messages WHERE sequence = 0
    `).all();
    if (roomsNeedingSequence.length > 0) {
      const rowsForRoom = db.prepare(`
        SELECT id FROM group_messages WHERE room_id = ?
        ORDER BY created_at ASC, rowid ASC
      `);
      const setSequence = db.prepare('UPDATE group_messages SET sequence = ? WHERE id = ?');
      db.transaction(() => {
        for (const room of roomsNeedingSequence) {
          rowsForRoom.all(room.room_id).forEach((message, index) => {
            setSequence.run(index + 1, message.id);
          });
        }
      })();
    }

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
  createUser: (username, passwordHash, options = {}) => {
    try {
      const displayName = options.displayName || username;
      const systemRole = options.systemRole || 'member';
      const mustChangePassword = options.mustChangePassword ? 1 : 0;
      const stmt = db.prepare(`
        INSERT INTO users (
          username, password_hash, display_name, system_role, must_change_password, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      const result = stmt.run(username, passwordHash, displayName, systemRole, mustChangePassword);
      return userDb.getUserById(result.lastInsertRowid, { includeInactive: true });
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
  getUserById: (userId, options = {}) => {
    try {
      const activeClause = options.includeInactive ? '' : 'AND is_active = 1';
      const row = db.prepare(`
        SELECT id, username, display_name, system_role, must_change_password,
          created_at, updated_at, last_login, is_active
        FROM users WHERE id = ? ${activeClause}
      `).get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare(`
        SELECT id, username, display_name, system_role, must_change_password,
          created_at, updated_at, last_login, is_active
        FROM users WHERE is_active = 1 ORDER BY id ASC LIMIT 1
      `).get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
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
  },

  listUsers: () => db.prepare(`
    SELECT id, username, display_name, system_role, must_change_password,
      created_at, updated_at, last_login, is_active
    FROM users ORDER BY id ASC
  `).all(),

  updateProfile: (userId, { displayName }) => {
    db.prepare(`
      UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(displayName, userId);
    return userDb.getUserById(userId, { includeInactive: true });
  },

  updatePassword: (userId, passwordHash, mustChangePassword = false) => {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(passwordHash, mustChangePassword ? 1 : 0, userId);
  },

  updateRole: (userId, systemRole) => {
    db.prepare(`
      UPDATE users SET system_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(systemRole, userId);
    return userDb.getUserById(userId, { includeInactive: true });
  },

  setActive: (userId, isActive) => {
    db.prepare(`
      UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(isActive ? 1 : 0, userId);
    return userDb.getUserById(userId, { includeInactive: true });
  },

  setUsernameAndOwnerProfile: (userId, { displayName, passwordHash }) => {
    db.prepare(`
      UPDATE users
      SET username = 'owner', display_name = ?, password_hash = ?, system_role = 'owner',
        must_change_password = 0, is_active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(displayName || 'Owner', passwordHash, userId);
    return userDb.getUserById(userId, { includeInactive: true });
  },
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
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
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint, userId = null) => {
    try {
      return userId == null
        ? db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
        : db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
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
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

const authSessionsDb = {
  create: ({ id, userId, tokenHash, csrfHash, idleExpiresAt, absoluteExpiresAt, userAgent, ipHash }) => {
    db.prepare(`
      INSERT INTO auth_sessions (
        id, user_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at,
        user_agent, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, csrfHash, idleExpiresAt, absoluteExpiresAt, userAgent, ipHash);
    return authSessionsDb.getById(id);
  },
  getById: (id) => db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) || null,
  getByTokenHash: (tokenHash) => db.prepare(`
    SELECT s.*, u.username, u.display_name, u.system_role, u.must_change_password, u.is_active
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash) || null,
  touch: (id, idleExpiresAt) => db.prepare(`
    UPDATE auth_sessions
    SET last_seen_at = CURRENT_TIMESTAMP, idle_expires_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(idleExpiresAt, id),
  updateCsrf: (id, csrfHash) => db.prepare(`
    UPDATE auth_sessions SET csrf_hash = ? WHERE id = ? AND revoked_at IS NULL
  `).run(csrfHash, id),
  revoke: (id) => db.prepare(`
    UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?
  `).run(id),
  revokeForUser: (userId, exceptId = null) => {
    if (exceptId) {
      return db.prepare(`
        UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
        WHERE user_id = ? AND id <> ?
      `).run(userId, exceptId);
    }
    return db.prepare(`
      UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
      WHERE user_id = ?
    `).run(userId);
  },
  listForUser: (userId) => db.prepare(`
    SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
      revoked_at, user_agent
    FROM auth_sessions WHERE user_id = ?
    ORDER BY last_seen_at DESC, created_at DESC
  `).all(userId),
  deleteExpired: () => db.prepare(`
    DELETE FROM auth_sessions
    WHERE absolute_expires_at <= CURRENT_TIMESTAMP
       OR (revoked_at IS NOT NULL AND revoked_at <= datetime('now', '-30 days'))
  `).run(),
};

const auditEventsDb = {
  create: ({ actorUserId = null, eventType, targetType = null, targetId = null, outcome = 'success', ipHash = null, metadata = {} }) => {
    const result = db.prepare(`
      INSERT INTO audit_events (
        actor_user_id, event_type, target_type, target_id, outcome, ip_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actorUserId, eventType, targetType, targetId == null ? null : String(targetId), outcome, ipHash, JSON.stringify(metadata || {}));
    return result.lastInsertRowid;
  },
  list: ({ limit = 100, offset = 0 } = {}) => db.prepare(`
    SELECT e.*, u.username AS actor_username, u.display_name AS actor_display_name
    FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
    ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?
  `).all(Math.max(1, Math.min(Number(limit) || 100, 500)), Math.max(0, Number(offset) || 0)),
};

const projectAccessDb = {
  getRole: (projectPath, userId) => db.prepare(`
    SELECT role FROM project_access WHERE project_path = ? AND user_id = ?
  `).get(projectPath, userId)?.role || null,
  listForUser: (userId) => db.prepare(`
    SELECT project_path, role, created_at, updated_at FROM project_access WHERE user_id = ?
  `).all(userId),
  listMembers: (projectPath) => db.prepare(`
    SELECT a.project_path, a.user_id, a.role, a.created_at, a.updated_at,
      u.username, u.display_name, u.system_role, u.is_active
    FROM project_access a JOIN users u ON u.id = a.user_id
    WHERE a.project_path = ? ORDER BY a.created_at ASC, a.user_id ASC
  `).all(projectPath),
  setRole: (projectPath, userId, role, grantedBy = null) => db.prepare(`
    INSERT INTO project_access (project_path, user_id, role, granted_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_path, user_id) DO UPDATE SET
      role = excluded.role,
      granted_by = excluded.granted_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(projectPath, userId, role, grantedBy),
  remove: (projectPath, userId) => db.prepare(`
    DELETE FROM project_access WHERE project_path = ? AND user_id = ?
  `).run(projectPath, userId),
  ensureOwner: (projectPath, userId) => projectAccessDb.setRole(projectPath, userId, 'owner', userId),
};

const sessionOwnersDb = {
  get: (sessionKey) => db.prepare(`
    SELECT session_key, project_path, user_id, created_at, updated_at
    FROM session_owners WHERE session_key = ?
  `).get(sessionKey) || null,
  create: (sessionKey, projectPath, userId) => db.prepare(`
    INSERT INTO session_owners (session_key, project_path, user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_key) DO NOTHING
  `).run(sessionKey, projectPath, userId),
  isOwner: (sessionKey, userId) => Boolean(db.prepare(`
    SELECT 1 FROM session_owners WHERE session_key = ? AND user_id = ?
  `).get(sessionKey, userId)),
  listForUser: (userId, projectPath = null) => projectPath
    ? db.prepare(`SELECT * FROM session_owners WHERE user_id = ? AND project_path = ?`).all(userId, projectPath)
    : db.prepare(`SELECT * FROM session_owners WHERE user_id = ?`).all(userId),
  delete: (sessionKey, userId) => db.prepare(`
    DELETE FROM session_owners WHERE session_key = ? AND user_id = ?
  `).run(sessionKey, userId),
};

const userToolPermissionsDb = {
  get: (userId) => {
    const row = db.prepare('SELECT settings_json FROM user_tool_permissions WHERE user_id = ?').get(userId);
    if (!row) return null;
    try { return JSON.parse(row.settings_json); } catch { return null; }
  },
  set: (userId, settings) => {
    db.prepare(`
      INSERT INTO user_tool_permissions (user_id, settings_json)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = CURRENT_TIMESTAMP
    `).run(userId, JSON.stringify(settings || {}));
    return userToolPermissionsDb.get(userId);
  },
};

const instancesDb = {
  ensureLocalForUser: (user) => {
    const id = `local-user-${user.id}`;
    db.prepare(`
      INSERT OR IGNORE INTO pilotdeck_instances (
        id, owner_user_id, name, kind, status, is_default, capabilities_json,
        approved_by, approved_at
      ) VALUES (?, ?, ?, 'local', 'approved', 1, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, user.id, `${user.display_name || user.username} 的 PilotDeck`, JSON.stringify({ groupTurn: true, delegation: true }), user.id);
    return instancesDb.get(id);
  },
  get: (id) => db.prepare(`SELECT * FROM pilotdeck_instances WHERE id = ?`).get(id) || null,
  listForUser: (userId) => db.prepare(`
    SELECT * FROM pilotdeck_instances WHERE owner_user_id = ? ORDER BY is_default DESC, created_at ASC
  `).all(userId),
  listRemote: () => db.prepare(`
    SELECT i.*, u.username AS owner_username, u.display_name AS owner_display_name
    FROM pilotdeck_instances i JOIN users u ON u.id = i.owner_user_id
    WHERE i.kind = 'remote' ORDER BY i.status = 'pending' DESC, i.updated_at DESC
  `).all(),
  getDefault: (userId, approvedOnly = true) => db.prepare(`
    SELECT * FROM pilotdeck_instances
    WHERE owner_user_id = ? ${approvedOnly ? "AND status = 'approved'" : ''}
    ORDER BY is_default DESC, kind = 'local' DESC, created_at ASC LIMIT 1
  `).get(userId) || null,
  createRemote: ({ id, ownerUserId, name, endpoint }) => {
    db.prepare(`
      INSERT INTO pilotdeck_instances (id, owner_user_id, name, kind, endpoint, status, is_default)
      VALUES (?, ?, ?, 'remote', ?, 'pending', 0)
    `).run(id, ownerUserId, name, endpoint);
    return instancesDb.get(id);
  },
  updateRemote: (id, ownerUserId, { name, endpoint }) => {
    db.prepare(`
      UPDATE pilotdeck_instances SET
        name = COALESCE(?, name), endpoint = COALESCE(?, endpoint),
        status = CASE WHEN ? IS NOT NULL THEN 'pending' ELSE status END,
        approved_by = CASE WHEN ? IS NOT NULL THEN NULL ELSE approved_by END,
        approved_at = CASE WHEN ? IS NOT NULL THEN NULL ELSE approved_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_user_id = ? AND kind = 'remote'
    `).run(name ?? null, endpoint ?? null, endpoint ?? null, endpoint ?? null, endpoint ?? null, id, ownerUserId);
    return instancesDb.get(id);
  },
  setApproval: (id, status, approvedBy, capabilities = {}) => {
    db.prepare(`
      UPDATE pilotdeck_instances SET status = ?, capabilities_json = ?, approved_by = ?,
        approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END,
        last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND kind = 'remote'
    `).run(status, JSON.stringify(capabilities || {}), approvedBy, status, id);
    return instancesDb.get(id);
  },
  setDefault: (id, ownerUserId) => db.transaction(() => {
    const instance = db.prepare(`
      SELECT * FROM pilotdeck_instances WHERE id = ? AND owner_user_id = ? AND status = 'approved'
    `).get(id, ownerUserId);
    if (!instance) return null;
    db.prepare('UPDATE pilotdeck_instances SET is_default = 0 WHERE owner_user_id = ?').run(ownerUserId);
    db.prepare('UPDATE pilotdeck_instances SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return instancesDb.get(id);
  })(),
  remove: (id, ownerUserId) => db.prepare(`
    DELETE FROM pilotdeck_instances
    WHERE id = ? AND owner_user_id = ? AND kind = 'remote' AND is_default = 0
  `).run(id, ownerUserId),
  listProjectBindings: (instanceId) => db.prepare(`
    SELECT project_path, workspace_key, created_at, updated_at
    FROM pilotdeck_instance_projects WHERE instance_id = ? ORDER BY project_path
  `).all(instanceId),
  setSecret: (instanceId, { encryptedValue, iv, authTag }) => db.prepare(`
    INSERT INTO pilotdeck_instance_secrets (instance_id, encrypted_value, iv, auth_tag)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET encrypted_value = excluded.encrypted_value,
      iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = CURRENT_TIMESTAMP
  `).run(instanceId, encryptedValue, iv, authTag),
  getSecret: (instanceId) => db.prepare(`SELECT * FROM pilotdeck_instance_secrets WHERE instance_id = ?`).get(instanceId) || null,
  setProjectBinding: (instanceId, projectPath, workspaceKey) => db.prepare(`
    INSERT INTO pilotdeck_instance_projects (instance_id, project_path, workspace_key)
    VALUES (?, ?, ?)
    ON CONFLICT(instance_id, project_path) DO UPDATE SET
      workspace_key = excluded.workspace_key, updated_at = CURRENT_TIMESTAMP
  `).run(instanceId, projectPath, workspaceKey),
  getProjectBinding: (instanceId, projectPath) => db.prepare(`
    SELECT * FROM pilotdeck_instance_projects WHERE instance_id = ? AND project_path = ?
  `).get(instanceId, projectPath) || null,
};

const groupDelegationGrantsDb = {
  create: ({ id, tokenHash, roomId, turnId, entryInstanceId, expiresAt }) => db.prepare(`
    INSERT INTO group_delegation_grants (
      id, token_hash, room_id, turn_id, entry_instance_id, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, tokenHash, roomId, turnId, entryInstanceId, expiresAt),
  getByTokenHash: (tokenHash) => db.prepare(`
    SELECT * FROM group_delegation_grants WHERE token_hash = ?
  `).get(tokenHash) || null,
  markUsed: (id) => db.prepare(`
    UPDATE group_delegation_grants SET used_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(id),
  revokeForTurn: (turnId) => db.prepare(`DELETE FROM group_delegation_grants WHERE turn_id = ?`).run(turnId),
  deleteExpired: () => db.prepare(`DELETE FROM group_delegation_grants WHERE expires_at <= CURRENT_TIMESTAMP`).run(),
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
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  appConfigDb,
  authSessionsDb,
  auditEventsDb,
  projectAccessDb,
  sessionOwnersDb,
  userToolPermissionsDb,
  instancesDb,
  groupDelegationGrantsDb,
  githubTokensDb // Backward compatibility
};
