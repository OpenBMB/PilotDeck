-- Initialize authentication database
PRAGMA foreign_keys = ON;

-- Users table (single user system)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- API Keys table for external API access
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

-- User credentials table for storing various tokens/credentials (GitHub, GitLab, etc.)
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

-- User notification preferences (backend-owned, provider-agnostic)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- VAPID key pair for Web Push notifications
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Browser push subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Session custom names (provider-agnostic display name overrides)
CREATE TABLE IF NOT EXISTS session_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    custom_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider);

-- App configuration table (auto-generated secrets, settings, etc.)
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Persistent agent group chats. Group-backed PilotDeck sessions are kept in
-- a hidden gateway project; these tables own the product-facing room state.
CREATE TABLE IF NOT EXISTS group_rooms (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    trigger_mode TEXT NOT NULL DEFAULT 'auto' CHECK (trigger_mode IN ('auto', 'mentions')),
    muted BOOLEAN NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_rooms_user_activity
    ON group_rooms(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS group_members (
    id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pilotdeck_main', 'pilotdeck_local', 'pilotdeck_remote', 'staffdeck', 'staffdeck_mock')),
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, id),
    FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_room_position
    ON group_members(room_id, is_active, position);

-- Human participants are deliberately lightweight for the single-user MVP.
-- The authenticated owner is inserted at room creation and bound to the
-- room's main PilotDeck member. Future multi-user work can add invitations
-- without changing message ownership or entry-agent resolution.
CREATE TABLE IF NOT EXISTS group_participants (
    room_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    bound_member_id TEXT NOT NULL DEFAULT 'main',
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_turns (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    round_id TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    message_kind TEXT NOT NULL DEFAULT 'chat' CHECK (message_kind IN ('chat', 'delegation', 'activity')),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
    sender_user_id INTEGER,
    sender_member_id TEXT,
    sender_name TEXT NOT NULL,
    reply_to_message_id TEXT,
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('queued', 'thinking', 'completed', 'failed')),
    error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reply_to_message_id) REFERENCES group_messages(id) ON DELETE SET NULL
);

-- Keep the legacy timestamp index here so existing databases whose table has
-- not gained `sequence` yet can still execute this bootstrap file. The
-- sequence index is added by the idempotent JS migration immediately after.
CREATE INDEX IF NOT EXISTS idx_group_messages_room_created
    ON group_messages(room_id, created_at, id);

CREATE TABLE IF NOT EXISTS group_read_state (
    user_id INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    last_read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, room_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE CASCADE
);
