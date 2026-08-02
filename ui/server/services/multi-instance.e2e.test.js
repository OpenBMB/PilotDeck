import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { expect, it, vi } from 'vitest';

const run = process.env.PILOTDECK_RUN_MULTI_INSTANCE_E2E === '1' ? it : it.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function freePort() {
  const server = createNetServer();
  await new Promise((accept, reject) => server.once('error', reject).listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

function startWorker({ name, port, apiKey, workspace, pilotHome }) {
  const workerPath = resolve(repositoryRoot, 'dist/tests/fixtures/group-turn-worker.js');
  const child = spawn(process.execPath, [workerPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      WORKER_NAME: name,
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: apiKey,
      WORKSPACE_PATH: workspace,
      PILOT_HOME: pilotHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const ready = new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name} worker did not become ready.\n${logs}`)), 15_000);
    const check = () => {
      if (logs.includes(`READY ${name} ${port}`)) {
        clearTimeout(timeout);
        accept();
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`${name} worker exited early (${code}).\n${logs}`));
    });
  });
  return { child, ready, logs: () => logs };
}

async function stopWorker(worker) {
  if (!worker || worker.child.exitCode != null) return;
  worker.child.kill('SIGTERM');
  await Promise.race([
    new Promise((accept) => worker.child.once('exit', accept)),
    new Promise((accept) => setTimeout(accept, 5_000)),
  ]);
  if (worker.child.exitCode == null) worker.child.kill('SIGKILL');
}

async function waitForTurn(groupChatDb, userId, roomId, roundId, expected = 'completed') {
  await vi.waitFor(() => {
    expect(groupChatDb.getTurn(userId, roomId, roundId)?.status).toBe(expected);
  }, { timeout: 20_000, interval: 50 });
}

run('runs three identities across isolated real group-turn worker processes', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-multi-instance-e2e-'));
  const coordinatorHome = join(directory, 'coordinator-home');
  const workspace = join(directory, 'shared-workspace');
  mkdirSync(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync(workspace);
  process.env.DATABASE_PATH = join(directory, 'coordinator.db');
  process.env.PILOT_HOME = coordinatorHome;
  let ownerWorker;
  let aliceWorker;
  let bobWorker;
  let coordinatorServer;
  let hangingServer;
  const hangingSockets = new Set();
  let completed = false;
  try {
    vi.resetModules();
    process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS = '250';
    const database = await import('../database/db.js');
    await database.initializeDatabase();
    const { groupChatDb } = await import('./group-chat-db.js');
    const { groupChatService } = await import('./group-chat-service.js');
    const { encryptInstanceSecret, testAndApproveInstance } = await import('./instance-service.js');
    const { authenticateGroupDelegation } = await import('../middleware/auth.js');

    const app = express();
    app.use(express.json());
    app.post('/api/groups/:groupId/delegate', authenticateGroupDelegation, async (req, res) => {
      try {
        const turn = groupChatDb.getTurnById(req.groupDelegationGrant?.turn_id);
        if (!turn || turn.roomId !== req.params.groupId) return res.status(403).json({ error: 'Grant mismatch.' });
        const result = await groupChatService.delegateMember(turn.senderUserId, req.params.groupId, req.body || {});
        return res.json(result);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    });
    coordinatorServer = app.listen(0, '127.0.0.1');
    await new Promise((accept) => coordinatorServer.once('listening', accept));
    const coordinatorPort = coordinatorServer.address().port;
    process.env.PILOTDECK_PUBLIC_URL = `http://127.0.0.1:${coordinatorPort}`;

    const ownerPort = await freePort();
    const alicePort = await freePort();
    const bobPort = await freePort();
    ownerWorker = startWorker({ name: 'OwnerWorker', port: ownerPort, apiKey: 'owner-key', workspace: canonicalWorkspace, pilotHome: join(directory, 'owner-home') });
    aliceWorker = startWorker({ name: 'AliceWorker', port: alicePort, apiKey: 'alice-key', workspace: canonicalWorkspace, pilotHome: join(directory, 'alice-home') });
    bobWorker = startWorker({ name: 'BobWorker', port: bobPort, apiKey: 'bob-key', workspace: canonicalWorkspace, pilotHome: join(directory, 'bob-home') });
    await Promise.all([ownerWorker.ready, aliceWorker.ready, bobWorker.ready]);

    const owner = database.userDb.createUser('owner', 'hash', { displayName: 'Owner', systemRole: 'owner' });
    const alice = database.userDb.createUser('alice', 'hash', { displayName: 'Alice', systemRole: 'member' });
    const bob = database.userDb.createUser('bob', 'hash', { displayName: 'Bob', systemRole: 'member' });
    database.instancesDb.ensureLocalForUser(owner);
    database.instancesDb.ensureLocalForUser(alice);
    database.instancesDb.ensureLocalForUser(bob);
    for (const user of [owner, alice, bob]) database.projectAccessDb.setRole(canonicalWorkspace, user.id, user.id === owner.id ? 'owner' : 'editor', owner.id);

    const createApprovedRemote = async (user, id, name, endpoint, apiKey) => {
      database.instancesDb.createRemote({ id, ownerUserId: user.id, name, endpoint });
      database.instancesDb.setSecret(id, encryptInstanceSecret(apiKey));
      database.instancesDb.setProjectBinding(id, canonicalWorkspace, 'shared');
      await testAndApproveInstance(id, owner.id);
      database.instancesDb.setDefault(id, user.id);
      return database.instancesDb.get(id);
    };
    const ownerInstance = await createApprovedRemote(owner, 'owner-remote', 'Owner remote PilotDeck', `http://127.0.0.1:${ownerPort}`, 'owner-key');
    const aliceInstance = await createApprovedRemote(alice, 'alice-remote', 'Alice remote PilotDeck', `http://127.0.0.1:${alicePort}`, 'alice-key');
    const bobInstance = await createApprovedRemote(bob, 'bob-remote', 'Bob remote PilotDeck', `http://127.0.0.1:${bobPort}`, 'bob-key');

    const room = groupChatDb.createRoom(owner.id, {
      title: 'Three-user E2E', projectName: 'shared', projectPath: canonicalWorkspace,
      triggerMode: 'auto', coordinatorInstanceId: ownerInstance.id,
    });
    groupChatDb.addParticipant(owner.id, room.id, {
      userId: alice.id, displayName: 'Alice', role: 'member', instanceId: aliceInstance.id,
      instanceKind: 'remote', instanceName: aliceInstance.name,
    });
    groupChatDb.addParticipant(owner.id, room.id, {
      userId: bob.id, displayName: 'Bob', role: 'member', instanceId: bobInstance.id,
      instanceKind: 'remote', instanceName: bobInstance.name,
    });
    groupChatDb.addMember(owner.id, room.id, {
      id: 'reviewer', kind: 'pilotdeck_remote', name: 'Reviewer', role: 'Review',
      description: 'Deterministic E2E reviewer', instanceId: bobInstance.id,
    });

    const ownerRound = groupChatService.sendMessage(owner.id, room.id, { content: 'Owner ordinary message', clientMessageId: 'owner-ordinary' });
    await waitForTurn(groupChatDb, owner.id, room.id, ownerRound.roundId);
    const aliceRound = groupChatService.sendMessage(alice.id, room.id, { content: 'Alice ordinary message', clientMessageId: 'alice-ordinary' });
    await waitForTurn(groupChatDb, alice.id, room.id, aliceRound.roundId);
    const bobRound = groupChatService.sendMessage(bob.id, room.id, { content: 'Bob ordinary message', clientMessageId: 'bob-ordinary' });
    await waitForTurn(groupChatDb, bob.id, room.id, bobRound.roundId);
    const ordinaryTimeline = groupChatDb.listMessages(owner.id, room.id, 200);
    expect(ordinaryTimeline.some((message) => message.roundId === ownerRound.roundId && message.senderMemberId === 'main' && message.content.includes('OwnerWorker reply'))).toBe(true);
    expect(ordinaryTimeline.some((message) => message.roundId === aliceRound.roundId && message.senderMemberId === `user-${alice.id}` && message.content.includes('AliceWorker reply'))).toBe(true);
    expect(ordinaryTimeline.some((message) => message.roundId === bobRound.roundId && message.senderMemberId === `user-${bob.id}` && message.content.includes('BobWorker reply'))).toBe(true);

    const bobMemberId = `user-${bob.id}`;
    const delegatedRound = groupChatService.sendMessage(alice.id, room.id, {
      content: `Please consult Bob naturally [delegate:${bobMemberId}]`,
      clientMessageId: 'alice-delegates-bob',
    });
    await waitForTurn(groupChatDb, alice.id, room.id, delegatedRound.roundId);
    const timeline = groupChatDb.listMessages(owner.id, room.id, 200);
    expect(timeline.some((message) => message.senderMemberId === `user-${alice.id}` && message.content.includes('AliceWorker reply'))).toBe(true);
    expect(timeline.some((message) => message.senderMemberId === bobMemberId && message.content.includes('BobWorker reply'))).toBe(true);
    const delegation = timeline.find((message) => message.roundId === delegatedRound.roundId && message.kind === 'delegation');
    expect(delegation?.metadata).toMatchObject({ state: 'completed', targetMemberId: bobMemberId });
    expect(timeline.some((message) => message.roundId === delegatedRound.roundId
      && message.senderMemberId === `user-${alice.id}`
      && message.content.includes('AliceWorker summary after'))).toBe(true);

    const explicitRound = groupChatService.sendMessage(alice.id, room.id, {
      content: '@Reviewer @Bob remote PilotDeck please review in this order',
      mentionedMemberIds: ['reviewer', bobMemberId],
      clientMessageId: 'ordered-explicit-mentions',
    });
    await waitForTurn(groupChatDb, alice.id, room.id, explicitRound.roundId);
    const explicitDelegations = groupChatDb.listMessages(owner.id, room.id, 300)
      .filter((message) => message.roundId === explicitRound.roundId && message.kind === 'delegation');
    expect(explicitDelegations.map((message) => message.metadata.targetMemberId)).toEqual(['reviewer', bobMemberId]);

    const allRound = groupChatService.sendMessage(alice.id, room.id, {
      content: '@所有人 report your status', clientMessageId: 'mention-all',
    });
    await waitForTurn(groupChatDb, alice.id, room.id, allRound.roundId);
    const allTimeline = groupChatDb.listMessages(owner.id, room.id, 400).filter((message) => message.roundId === allRound.roundId);
    expect(allTimeline.filter((message) => message.kind === 'delegation').map((message) => message.metadata.targetMemberId))
      .toEqual([`user-${alice.id}`, bobMemberId, 'reviewer']);
    expect(allTimeline.some((message) => message.senderMemberId === 'main' && message.content.includes('OwnerWorker summary after'))).toBe(true);

    const firstDuplicate = groupChatService.sendMessage(alice.id, room.id, { content: 'Deduplicate this', clientMessageId: 'same-client-message' });
    const secondDuplicate = groupChatService.sendMessage(alice.id, room.id, { content: 'Deduplicate this', clientMessageId: 'same-client-message' });
    expect(secondDuplicate.roundId).toBe(firstDuplicate.roundId);
    expect(secondDuplicate.deduplicated).toBe(true);
    await waitForTurn(groupChatDb, alice.id, room.id, firstDuplicate.roundId);
    expect(groupChatDb.listMessages(owner.id, room.id, 500)
      .filter((message) => message.roundId === firstDuplicate.roundId && message.senderType === 'user')).toHaveLength(1);

    const fifoAlice = groupChatService.sendMessage(alice.id, room.id, { content: 'FIFO Alice', clientMessageId: 'fifo-a' });
    const fifoBob = groupChatService.sendMessage(bob.id, room.id, { content: 'FIFO Bob', clientMessageId: 'fifo-b' });
    await waitForTurn(groupChatDb, alice.id, room.id, fifoAlice.roundId);
    await waitForTurn(groupChatDb, bob.id, room.id, fifoBob.roundId);
    const fifoTurns = [groupChatDb.getTurnById(fifoAlice.roundId), groupChatDb.getTurnById(fifoBob.roundId)];
    expect(fifoTurns.map((turn) => turn.status)).toEqual(['completed', 'completed']);
    const fifoTimeline = groupChatDb.listMessages(owner.id, room.id, 500);
    const fifoAliceReply = fifoTimeline.find((message) => message.roundId === fifoAlice.roundId && message.senderType === 'agent' && message.kind === 'chat');
    const fifoBobReply = fifoTimeline.find((message) => message.roundId === fifoBob.roundId && message.senderType === 'agent' && message.kind === 'chat');
    expect(fifoAliceReply.sequence).toBeLessThan(fifoBobReply.sequence);

    const recoveredTurn = groupChatDb.createTurn(alice.id, room.id, {
      entryMemberId: `user-${alice.id}`, triggerSource: 'auto', status: 'running',
      idempotencyKey: `${alice.id}:restart-recovery`, requiredDelegates: [],
    });
    const recoveredMessage = groupChatDb.createMessage(alice.id, room.id, {
      roundId: recoveredTurn.id, kind: 'chat', senderType: 'user', senderUserId: alice.id,
      senderName: 'Alice', content: 'Recover this interrupted turn', status: 'completed',
    });
    groupChatDb.setTurnMessageSequence(recoveredTurn.id, recoveredMessage.sequence);
    groupChatService.recoverPendingTurns();
    await waitForTurn(groupChatDb, alice.id, room.id, recoveredTurn.id);

    await stopWorker(bobWorker);
    const offlineRound = groupChatService.sendMessage(bob.id, room.id, { content: 'Bob is offline', clientMessageId: 'bob-offline' });
    await waitForTurn(groupChatDb, bob.id, room.id, offlineRound.roundId, 'failed');
    expect(groupChatDb.listMessages(owner.id, room.id, 200).some((message) => message.roundId === offlineRound.roundId && message.status === 'failed')).toBe(true);

    hangingServer = createNetServer((socket) => {
      hangingSockets.add(socket);
      socket.once('close', () => hangingSockets.delete(socket));
    });
    await new Promise((accept, reject) => hangingServer.once('error', reject).listen(bobPort, '127.0.0.1', accept));
    const timeoutRound = groupChatService.sendMessage(bob.id, room.id, { content: 'Bob times out', clientMessageId: 'bob-timeout' });
    await waitForTurn(groupChatDb, bob.id, room.id, timeoutRound.roundId, 'failed');
    expect(groupChatDb.getTurnById(timeoutRound.roundId).error).toMatch(/abort|timeout|fetch|超时/iu);
    for (const socket of hangingSockets) socket.destroy();
    await new Promise((accept) => hangingServer.close(accept));
    hangingServer = null;

    database.userDb.setActive(bob.id, false);
    const disabledRound = groupChatService.sendMessage(bob.id, room.id, { content: 'Disabled Bob message', clientMessageId: 'bob-disabled' });
    await waitForTurn(groupChatDb, bob.id, room.id, disabledRound.roundId, 'failed');
    expect(groupChatDb.getTurnById(disabledRound.roundId).error).toContain('账号已停用');
    completed = true;
  } finally {
    for (const socket of hangingSockets) socket.destroy();
    if (hangingServer) await new Promise((accept) => hangingServer.close(accept));
    await Promise.all([stopWorker(ownerWorker), stopWorker(aliceWorker), stopWorker(bobWorker)]);
    if (coordinatorServer) await new Promise((accept) => coordinatorServer.close(accept));
    delete process.env.DATABASE_PATH;
    delete process.env.PILOT_HOME;
    delete process.env.PILOTDECK_PUBLIC_URL;
    delete process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS;
    if (completed) rmSync(directory, { recursive: true, force: true });
    else {
      writeFileSync(join(directory, 'worker-logs.txt'), `${ownerWorker?.logs() || ''}\n${aliceWorker?.logs() || ''}\n${bobWorker?.logs() || ''}`);
      console.error(`Multi-instance E2E failed; logs retained at ${directory}`);
    }
  }
});
