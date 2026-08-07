import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];
let openDb = null;

afterEach(() => {
  try { openDb?.close(); } catch {}
  openDb = null;
  vi.resetModules();
  delete process.env.DATABASE_PATH;
  delete process.env.PILOTDECK_AUTH_MODE;
  delete process.env.PILOT_HOME;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-multi-user-'));
  tempDirs.push(directory);
  process.env.DATABASE_PATH = join(directory, 'auth.db');
  process.env.PILOT_HOME = join(directory, 'pilot-home');
  vi.resetModules();
  const database = await import('../database/db.js');
  openDb = database.db;
  await database.initializeDatabase();
  return database;
}

describe('multi-user migration and isolation primitives', () => {
  it('upgrades a legacy group_turns table before creating the idempotency index', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-legacy-group-turns-'));
    tempDirs.push(directory);
    const databasePath = join(directory, 'auth.db');
    const legacyDb = new Database(databasePath);
    legacyDb.exec(`
      CREATE TABLE group_turns (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_user_id INTEGER NOT NULL,
        entry_member_id TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacyDb.close();

    process.env.DATABASE_PATH = databasePath;
    process.env.PILOT_HOME = join(directory, 'pilot-home');
    vi.resetModules();
    const database = await import('../database/db.js');
    openDb = database.db;
    await database.initializeDatabase();

    const columns = database.db.prepare('PRAGMA table_info(group_turns)').all().map((column) => column.name);
    expect(columns).toContain('idempotency_key');
    expect(database.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_group_turns_room_idempotency'
    `).get()).toBeTruthy();
  });

  it('is idempotent and creates the full ownership schema', async () => {
    const database = await setup();
    await database.initializeDatabase();
    const tables = new Set(database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of [
      'auth_sessions', 'audit_events', 'project_access', 'session_owners',
      'user_tool_permissions', 'pilotdeck_instances', 'pilotdeck_instance_projects',
      'group_participants', 'group_turns', 'group_delegation_grants',
    ]) expect(tables.has(table)).toBe(true);
  });

  it('keeps projects and normal sessions private while sharing a group through participant ACL', async () => {
    const database = await setup();
    const owner = database.userDb.createUser('owner', 'hash', { displayName: 'Owner', systemRole: 'owner' });
    const alice = database.userDb.createUser('alice', 'hash', { displayName: 'Alice', systemRole: 'member' });
    const bob = database.userDb.createUser('bob', 'hash', { displayName: 'Bob', systemRole: 'member' });
    database.appConfigDb.set('auth_enabled', 'true');
    database.instancesDb.ensureLocalForUser(owner);
    database.instancesDb.ensureLocalForUser(alice);
    database.instancesDb.ensureLocalForUser(bob);

    const {
      canonicalizeProjectPath,
      getProjectRole,
      requireSessionOwner,
      resolveProjectNameForUser,
    } = await import('./access-control.js');
    const projectPath = canonicalizeProjectPath(join(tempDirs[0], 'shared-project'));
    database.projectAccessDb.setRole(projectPath, owner.id, 'owner', owner.id);
    database.projectAccessDb.setRole(projectPath, alice.id, 'editor', owner.id);
    expect(getProjectRole(projectPath, { id: alice.id, systemRole: 'member' })).toBe('editor');
    expect(getProjectRole(projectPath, { id: bob.id, systemRole: 'member' })).toBeNull();

    database.sessionOwnersDb.create('private-session', projectPath, alice.id);
    expect(requireSessionOwner('private-session', { id: alice.id })).toMatchObject({ user_id: alice.id });
    expect(() => requireSessionOwner('private-session', { id: owner.id, systemRole: 'owner' })).toThrow('Session not found');

    const { groupChatDb } = await import('./group-chat-db.js');
    const room = groupChatDb.createRoom(owner.id, {
      title: 'Shared group', projectName: 'shared', projectPath, triggerMode: 'auto',
      coordinatorInstanceId: database.instancesDb.getDefault(owner.id).id,
    });
    groupChatDb.addParticipant(owner.id, room.id, {
      userId: alice.id, displayName: 'Alice', role: 'member',
      instanceId: database.instancesDb.getDefault(alice.id).id,
      instanceKind: 'local', instanceName: 'Alice PilotDeck',
    });
    expect(groupChatDb.getRoom(alice.id, room.id)).toMatchObject({ participantRole: 'member' });
    expect(groupChatDb.getRoom(bob.id, room.id)).toBeNull();
    await expect(resolveProjectNameForUser(`group:${room.id}`, {
      id: alice.id,
      systemRole: 'member',
    })).resolves.toBe(projectPath);
    await expect(resolveProjectNameForUser(`group:${room.id}`, {
      id: bob.id,
      systemRole: 'member',
    })).rejects.toMatchObject({ statusCode: 404 });
    groupChatDb.setParticipantMuted(alice.id, room.id, true);
    expect(groupChatDb.getRoom(alice.id, room.id).muted).toBe(true);
    expect(groupChatDb.getRoom(owner.id, room.id).muted).toBe(false);
  }, 15_000);

  it('revokes browser sessions and stores remote credentials without exposing plaintext', async () => {
    const database = await setup();
    const owner = database.userDb.createUser('owner', 'hash', { displayName: 'Owner', systemRole: 'owner' });
    const expiry = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').replace('Z', '');
    database.authSessionsDb.create({
      id: 'session-1', userId: owner.id, tokenHash: 'token-hash', csrfHash: 'csrf-hash',
      idleExpiresAt: expiry, absoluteExpiresAt: expiry, userAgent: 'vitest', ipHash: 'ip-hash',
    });
    database.authSessionsDb.revokeForUser(owner.id);
    expect(database.authSessionsDb.getById('session-1').revoked_at).toBeTruthy();

    const instance = database.instancesDb.createRemote({
      id: 'remote-1', ownerUserId: owner.id, name: 'Remote', endpoint: 'http://127.0.0.1:8642',
    });
    const { encryptInstanceSecret, decryptInstanceSecret, serializeInstance } = await import('./instance-service.js');
    database.instancesDb.setSecret(instance.id, encryptInstanceSecret('top-secret'));
    expect(decryptInstanceSecret(instance.id)).toBe('top-secret');
    expect(JSON.stringify(serializeInstance(database.instancesDb.get(instance.id)))).not.toContain('top-secret');
    expect(serializeInstance(database.instancesDb.get(instance.id)).hasCredential).toBe(true);
  });

  it('uses HttpOnly revocable sessions, CSRF headers, and documented auth precedence', async () => {
    const database = await setup();
    const owner = database.userDb.createUser('owner', 'hash', { displayName: 'Owner', systemRole: 'owner' });
    database.appConfigDb.set('auth_enabled', 'true');
    const auth = await import('./auth-service.js');
    const req = {
      method: 'POST',
      headers: { 'user-agent': 'vitest', host: 'localhost:3001' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const created = auth.createBrowserSession(req, owner);
    const verified = auth.verifyBrowserSessionToken(created.token, { touch: false });
    expect(verified.user).toMatchObject({ id: owner.id, systemRole: 'owner' });
    expect(auth.verifyCsrf({ method: 'POST', headers: { 'x-csrf-token': created.csrfToken } }, verified.session)).toBe(true);
    expect(auth.verifyCsrf({ method: 'POST', headers: {} }, verified.session)).toBe(false);

    const { authenticateWebSocket } = await import('../middleware/auth.js');
    const websocketHeaders = {
      cookie: `pilotdeck_session=${created.token}`,
      host: 'localhost:3001',
      origin: 'http://localhost:3001',
    };
    expect(authenticateWebSocket({ headers: websocketHeaders })).toMatchObject({ id: owner.id });
    expect(authenticateWebSocket({ headers: { ...websocketHeaders, origin: 'http://evil.example' } })).toBeNull();
    expect(authenticateWebSocket({ headers: { cookie: websocketHeaders.cookie, host: websocketHeaders.host } })).toBeNull();

    const res = { setHeader: vi.fn() };
    auth.setSessionCookie(req, res, created.token);
    expect(res.setHeader.mock.calls[0][1]).toContain('HttpOnly');
    expect(res.setHeader.mock.calls[0][1]).toContain('SameSite=Strict');
    database.authSessionsDb.revoke(created.session.id);
    expect(auth.verifyBrowserSessionToken(created.token, { touch: false })).toBeNull();

    process.env.PILOTDECK_AUTH_MODE = 'disabled';
    expect(auth.isAuthEnabled()).toBe(false);
    process.env.PILOTDECK_AUTH_MODE = 'required';
    expect(auth.isAuthEnabled()).toBe(true);
  });

  it('blocks project path bypasses, partial instance registration, and admin-on-admin session control', async () => {
    const database = await setup();
    database.appConfigDb.set('auth_enabled', 'true');
    const owner = database.userDb.createUser('owner', 'hash', { displayName: 'Owner', systemRole: 'owner' });
    const admin = database.userDb.createUser('admin', 'hash', { displayName: 'Admin', systemRole: 'admin' });
    const otherAdmin = database.userDb.createUser('other-admin', 'hash', { displayName: 'Other Admin', systemRole: 'admin' });
    const alice = database.userDb.createUser('alice', 'hash', { displayName: 'Alice', systemRole: 'member' });
    const inaccessibleProject = join(tempDirs[0], 'not-alice-project');
    database.projectAccessDb.setRole(inaccessibleProject, owner.id, 'owner', owner.id);

    const [{ default: commandsRouter }, { default: instancesRouter }, { default: adminUsersRouter }] = await Promise.all([
      import('../routes/commands.js'),
      import('../routes/instances.js'),
      import('../routes/admin-users.js'),
    ]);
    const app = express();
    app.use(express.json());
    app.use('/commands', (req, _res, next) => { req.user = { id: alice.id, systemRole: 'member' }; next(); }, commandsRouter);
    app.use('/instances', (req, _res, next) => { req.user = { id: alice.id, systemRole: 'member' }; next(); }, instancesRouter);
    app.use('/admin', (req, _res, next) => { req.user = { id: admin.id, systemRole: 'admin' }; next(); }, adminUsersRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((accept) => server.once('listening', accept));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const commandResponse = await fetch(`${baseUrl}/commands/list`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: inaccessibleProject }),
      });
      expect(commandResponse.status).toBe(404);

      const remoteBefore = database.instancesDb.listForUser(alice.id).filter((instance) => instance.kind === 'remote').length;
      const instanceResponse = await fetch(`${baseUrl}/instances`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Must not persist', endpoint: 'http://127.0.0.1:8642',
          projectMappings: [{ projectPath: inaccessibleProject, workspaceKey: 'shared' }],
        }),
      });
      expect(instanceResponse.status).toBe(404);
      expect(database.instancesDb.listForUser(alice.id).filter((instance) => instance.kind === 'remote')).toHaveLength(remoteBefore);

      const revokeResponse = await fetch(`${baseUrl}/admin/users/${otherAdmin.id}/revoke-sessions`, { method: 'POST' });
      expect(revokeResponse.status).toBe(403);
    } finally {
      await new Promise((accept) => server.close(accept));
    }
  });
});
