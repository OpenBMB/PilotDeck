#!/usr/bin/env node
import process from 'node:process';
import bcrypt from 'bcrypt';
import {
  appConfigDb,
  auditEventsDb,
  authSessionsDb,
  db,
  initializeDatabase,
  instancesDb,
  userDb,
} from '../database/db.js';

const [command, ...args] = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || '') : fallback;
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value.trimEnd();
  }
  process.stdout.write('New password: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') return finish(new Error('Cancelled.'));
      if (text === '\r' || text === '\n') return finish();
      if (text === '\u007f' || text === '\b') value = value.slice(0, -1);
      else value += text;
    };
    process.stdin.on('data', onData);
  });
}

function validatePassword(password) {
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
}

async function enable() {
  const password = await readPassword();
  validatePassword(password);
  const current = userDb.getFirstUser();
  if (!current) throw new Error('No local user exists. Start PilotDeck once to initialize the database.');
  const conflict = db.prepare("SELECT id FROM users WHERE username = 'owner' AND id <> ?").get(current.id);
  if (conflict) throw new Error('Another owner username already exists.');
  const owner = userDb.setUsernameAndOwnerProfile(current.id, {
    displayName: option('display-name', 'Owner'),
    passwordHash: await bcrypt.hash(password, 12),
  });
  instancesDb.ensureLocalForUser(owner);
  appConfigDb.set('auth_enabled', 'true');
  authSessionsDb.revokeForUser(owner.id);
  auditEventsDb.create({ actorUserId: owner.id, eventType: 'auth.enabled_via_cli', targetType: 'user', targetId: owner.id });
  process.stdout.write('Multi-user login enabled. Sign in as owner.\n');
}

async function reset() {
  const username = option('username', 'owner');
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) throw new Error(`User ${username} does not exist.`);
  const password = await readPassword();
  validatePassword(password);
  userDb.updatePassword(target.id, await bcrypt.hash(password, 12), false);
  authSessionsDb.revokeForUser(target.id);
  auditEventsDb.create({ actorUserId: null, eventType: 'auth.password_reset_via_cli', targetType: 'user', targetId: target.id });
  process.stdout.write(`Password reset for ${username}; all browser sessions were revoked.\n`);
}

try {
  await initializeDatabase();
  if (command === 'enable') await enable();
  else if (command === 'reset-password') await reset();
  else {
    process.stderr.write('Usage:\n  npm run auth:cli -- enable [--display-name Owner]\n  npm run auth:cli -- reset-password [--username owner]\nPassword is read from stdin or prompted interactively.\n');
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
