// @vitest-environment node
import { expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPilotDeckApprovalAuthority } from './pilotdeck-approval-authority.mjs';

it('authenticates the active PD owner JWT without SD credentials or requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sop-owner-')); const path = join(root, 'auth.db');
  const db = new DatabaseSync(path); db.exec("CREATE TABLE app_config(key TEXT, value TEXT); INSERT INTO app_config VALUES ('jwt_secret','test-only-secret')"); db.close();
  let owner = 'owner'; const authority = createPilotDeckApprovalAuthority({ databasePath: path, readOwner: () => owner });
  try {
    const bearer = jwt.sign({ userId: 'owner' }, 'test-only-secret');
    expect(await authority.authenticate({ bearer })).toMatchObject({ tenantId: 'pilotdeck', userId: 'owner' });
    for (const token of [jwt.sign({ userId: 'other' }, 'test-only-secret'), jwt.sign({ userId: 'owner' }, 'wrong'), jwt.sign({ userId: 'owner', exp: 1 }, 'test-only-secret')]) {
      await expect(authority.authenticate({ bearer: token })).rejects.toMatchObject({ code: 'APPROVAL_AUTH_REJECTED' });
    }
    owner = undefined; await expect(authority.authenticate({ bearer })).rejects.toMatchObject({ code: 'APPROVAL_AUTH_REJECTED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
