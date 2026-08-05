import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];
const servers = [];
let openDb = null;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    openDb?.close();
  } catch {
    // Already closed.
  }
  openDb = null;
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.DATABASE_PATH;
  delete process.env.PILOT_HOME;
  delete process.env.STAFFDECK_BASE_URL;
  delete process.env.STAFFDECK_API_KEY;
  delete process.env.STAFFDECK_API_TOKEN;
  delete process.env.STAFFDECK_TENANT_ID;
  delete process.env.STAFFDECK_POLL_INTERVAL_MS;
  delete process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setupDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-staffdeck-v1-'));
  tempDirs.push(dir);
  process.env.PILOT_HOME = dir;
  process.env.DATABASE_PATH = join(dir, 'groups.db');
  const database = await import('../database/db.js');
  openDb = database.db;
  await database.initializeDatabase();
  const user = database.userDb.createUser('staffdeck-test', 'not-a-real-password-hash');
  return { database, user, dir };
}

async function startStaffDeckStub() {
  const requests = [];
  const employees = [
    { id: 'finance-1', name: '财务', description: '处理报销与预算问题', metadata: { published_to_gallery: true, created_by_username: 'admin', role_name: '财务', expertise_tags: ['预算', '报销'] }, reply: '这是来自真实 StaffDeck 协议的财务回复。' },
    { id: 'hr-1', name: '人事', description: '处理招聘与员工关系问题', metadata: { published_to_gallery: true, created_by_username: 'admin', role_name: '人事' }, reply: '这是来自真实 StaffDeck 协议的人事回复。' },
    { id: 'legal-1', name: '法务', description: '处理合同与合规问题', metadata: { published_to_gallery: true, created_by_username: 'admin', role_name: '法务' }, reply: '这是来自真实 StaffDeck 协议的法务回复。' },
    { id: 'admin-1', name: '行政', description: '处理办公与行政协调问题', metadata: { published_to_gallery: true, created_by_username: 'admin', role_name: '行政' }, reply: '这是来自真实 StaffDeck 协议的行政回复。' },
    { id: 'it-1', name: 'IT', description: '处理账号、设备与系统问题', metadata: { published_to_gallery: true, created_by_username: 'admin', role_name: 'IT' }, reply: '这是来自真实 StaffDeck 协议的 IT 回复。' },
  ];
  const byId = new Map(employees.map((employee, index) => [employee.id, {
    ...employee,
    sessionId: `staff-session-${index + 1}`,
    runId: `staff-run-${index + 1}`,
  }]));
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers['idempotency-key'],
      body,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/agents') {
      response.end(JSON.stringify({
        data: [
          ...employees.map(({ reply: _reply, ...employee }) => ({ ...employee, status: 'active' })),
        ],
        next_cursor: null,
      }));
      return;
    }
    const sessionMatch = request.url?.match(/^\/api\/v1\/agents\/([^/]+)\/sessions$/u);
    if (request.method === 'POST' && sessionMatch && byId.has(sessionMatch[1])) {
      const employee = byId.get(sessionMatch[1]);
      response.statusCode = 201;
      response.end(JSON.stringify({ id: employee.sessionId, status: 'active' }));
      return;
    }
    const runCreateMatch = request.url?.match(/^\/api\/v1\/agents\/([^/]+)\/runs$/u);
    if (request.method === 'POST' && runCreateMatch && byId.has(runCreateMatch[1])) {
      const employee = byId.get(runCreateMatch[1]);
      response.statusCode = 202;
      response.end(JSON.stringify({ id: employee.runId, status: 'queued', stage: 'queued' }));
      return;
    }
    const runStatusMatch = request.url?.match(/^\/api\/v1\/runs\/(staff-run-\d+)$/u);
    if (request.method === 'GET' && runStatusMatch) {
      response.end(JSON.stringify({ id: runStatusMatch[1], status: 'succeeded', stage: 'completed' }));
      return;
    }
    const runResultMatch = request.url?.match(/^\/api\/v1\/runs\/(staff-run-\d+)\/result$/u);
    if (request.method === 'GET' && runResultMatch) {
      const employee = [...byId.values()].find((candidate) => candidate.runId === runResultMatch[1]);
      response.end(JSON.stringify({
        run_id: employee.runId,
        session_id: employee.sessionId,
        reply: employee.reply,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('StaffDeck stub failed to listen.');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe('StaffDeck Open API v1 group integration', () => {
  it('discovers a real employee and persists its direct group reply', async () => {
    const stub = await startStaffDeckStub();
    const { user } = await setupDatabase();
    process.env.STAFFDECK_BASE_URL = stub.baseUrl;
    process.env.STAFFDECK_API_KEY = 'test-admin-key';
    process.env.STAFFDECK_POLL_INTERVAL_MS = '0';
    process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS = '5000';
    const { groupChatDb } = await import('./group-chat-db.js');
    const { groupChatService } = await import('./group-chat-service.js');

    const available = await groupChatService.listAvailableMembers();
    expect(available.staffdeckConfigured).toBe(true);
    expect(available.staffdeckError).toBeNull();
    expect(available.local).toEqual([]);
    expect(available.mocks).toEqual([]);
    expect(available.staffdeck.map((employee) => employee.name)).toEqual(['财务', '人事', '法务', '行政', 'IT']);
    expect(available.staffdeck.every((employee) => employee.kind === 'staffdeck')).toBe(true);
    expect(available.staffdeck.every((employee) => employee.staffdeckAccess === 'public')).toBe(true);
    expect(available.staffdeck[0]).toMatchObject({ creatorUsername: 'admin', role: '财务', expertiseTags: ['预算', '报销'] });

    const room = groupChatDb.createRoom(user.id, {
      title: '财务协作群',
      projectName: 'general',
      projectPath: '/workspace/general',
      triggerMode: 'mentions',
      muted: false,
    });
    groupChatService.addMember(user.id, room.id, {
      id: 'finance-1',
      employeeId: 'finance-1',
      kind: 'staffdeck',
      name: '财务',
      role: 'StaffDeck 数字员工',
      description: '处理报销与预算问题',
    });
    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: '@财务 请说明报销职责',
      mentionedMemberIds: ['finance-1'],
      clientMessageId: 'staffdeck-live-protocol-test',
    });
    await vi.waitFor(() => {
      expect(['completed', 'failed']).toContain(groupChatDb.getTurn(user.id, room.id, sent.roundId).status);
    }, { timeout: 12_000 });
    const completedTurn = groupChatDb.getTurn(user.id, room.id, sent.roundId);
    expect(completedTurn.status, completedTurn.error || 'group turn failed').toBe('completed');

    const reply = groupChatDb.listMessages(user.id, room.id, 20)
      .find((message) => message.senderMemberId === 'finance-1');
    expect(reply).toMatchObject({
      status: 'completed',
      content: '这是来自真实 StaffDeck 协议的财务回复。',
    });
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/agents',
      'POST /api/v1/agents/finance-1/sessions',
      'POST /api/v1/agents/finance-1/runs',
      'GET /api/v1/runs/staff-run-1',
      'GET /api/v1/runs/staff-run-1/result',
    ]);
    expect(stub.requests.every((request) => request.authorization === 'Bearer test-admin-key')).toBe(true);
    expect(stub.requests[1].idempotencyKey).toMatch(/^pilotdeck-session-/);
    expect(stub.requests[2].idempotencyKey).toMatch(/^pilotdeck-run-/);
    expect(stub.requests[2].body).toMatchObject({
      session_id: 'staff-session-1',
      session_mode: 'stateful',
    });
    expect(stub.requests[2].body).not.toHaveProperty('tenant_id');
  });

  it('forwards pasted images and text attachments to a directly mentioned StaffDeck employee', async () => {
    const stub = await startStaffDeckStub();
    const { user, dir } = await setupDatabase();
    process.env.STAFFDECK_BASE_URL = stub.baseUrl;
    process.env.STAFFDECK_API_KEY = 'test-admin-key';
    process.env.STAFFDECK_POLL_INTERVAL_MS = '0';
    process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS = '5000';
    const projectPath = join(dir, 'general');
    mkdirSync(projectPath, { recursive: true });
    const imagePath = join(projectPath, 'evidence.png');
    const notePath = join(projectPath, 'evidence.md');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    writeFileSync(imagePath, imageBytes);
    writeFileSync(notePath, '# 验收证据\n这是传给数字员工的文本附件。\n');
    const { groupChatDb } = await import('./group-chat-db.js');
    const { groupChatService } = await import('./group-chat-service.js');
    const room = groupChatDb.createRoom(user.id, {
      title: '附件直达财务',
      projectName: 'general',
      projectPath,
      triggerMode: 'mentions',
      muted: false,
    });
    groupChatService.addMember(user.id, room.id, {
      id: 'finance-1', employeeId: 'finance-1', kind: 'staffdeck', name: '财务', role: '财务', description: '财务审核',
    });

    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: '@财务 请查看图片和说明文件',
      mentionedMemberIds: ['finance-1'],
      images: [{ name: 'evidence.png', path: imagePath, size: imageBytes.length, mimeType: 'image/png' }],
      attachments: [{ name: 'evidence.md', path: notePath, size: 64, mimeType: 'text/markdown' }],
      clientMessageId: 'staffdeck-direct-attachments',
    });
    await vi.waitFor(() => {
      expect(['completed', 'failed']).toContain(groupChatDb.getTurn(user.id, room.id, sent.roundId).status);
    }, { timeout: 12_000 });
    expect(groupChatDb.getTurn(user.id, room.id, sent.roundId).status).toBe('completed');
    const runRequest = stub.requests.find((request) => request.method === 'POST' && request.url === '/api/v1/agents/finance-1/runs');
    expect(runRequest.body.attachments).toEqual([
      expect.objectContaining({ filename: 'evidence.png', content_type: 'image/png', kind: 'image', data_url: expect.stringMatching(/^data:image\/png;base64,/) }),
      expect.objectContaining({ filename: 'evidence.md', content_type: 'text/markdown', kind: 'text', text: expect.stringContaining('验收证据') }),
    ]);
    expect(runRequest.body.input).toContain('<staffdeck_text_attachment name="evidence.md"');
    expect(runRequest.body.input).toContain('这是传给数字员工的文本附件。');
    expect(JSON.stringify(runRequest.body.attachments)).not.toContain(projectPath);
  });

  it('lets the same main-agent loop reassess one StaffDeck reply and delegate to another employee', async () => {
    const stub = await startStaffDeckStub();
    const { user, dir } = await setupDatabase();
    process.env.STAFFDECK_BASE_URL = stub.baseUrl;
    process.env.STAFFDECK_API_KEY = 'test-admin-key';
    process.env.STAFFDECK_POLL_INTERVAL_MS = '0';
    process.env.PILOTDECK_GROUP_MEMBER_TIMEOUT_MS = '5000';
    let delegateMember;
    let room;
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        submitTurn: async function* (input) {
          if (!input.sessionKey.endsWith(':main')) {
            throw new Error(`Unexpected local member turn: ${input.sessionKey}`);
          }
          yield { type: 'assistant_thinking_delta', text: '这是跨部门问题，需要依次咨询五位真实数字员工。' };
          for (const employee of [
            ['finance-1', '财务'],
            ['hr-1', '人事'],
            ['legal-1', '法务'],
            ['admin-1', '行政'],
            ['it-1', 'IT'],
          ]) {
            const [memberId, name] = employee;
            yield {
              type: 'tool_call_started',
              toolCallId: `delegate-${memberId}`,
              name: 'group_member_delegate',
              argsPreview: JSON.stringify({ memberId }),
            };
            await delegateMember(user.id, room.id, {
              sourceSessionId: `group:${room.id}:${room.conversations[0].id}:main`,
              sourceTurnId: `turn-${memberId}`,
              memberId,
              message: `请从${name}职责给出一句建议。`,
            });
            yield {
              type: 'tool_call_finished',
              toolCallId: `delegate-${memberId}`,
              toolName: 'group_member_delegate',
              ok: true,
              resultPreview: `${name}员工已回复`,
            };
          }
          yield { type: 'assistant_text_delta', text: '已综合财务、人事、法务、行政和 IT 五位数字员工的意见。' };
          yield { type: 'turn_completed', usage: {}, finishReason: 'completed' };
        },
      })),
    }));
    const { groupChatDb } = await import('./group-chat-db.js');
    const { groupChatService } = await import('./group-chat-service.js');
    delegateMember = groupChatService.delegateMember.bind(groupChatService);
    const projectPath = join(dir, 'general');
    mkdirSync(projectPath, { recursive: true });
    const attachmentPath = join(projectPath, 'onboarding.md');
    writeFileSync(attachmentPath, '# 入职方案\n请五个部门分别评估。\n');
    room = groupChatDb.createRoom(user.id, {
      title: '智能财务协作群',
      projectName: 'general',
      projectPath,
      triggerMode: 'auto',
      muted: false,
    });
    for (const employee of [
      ['finance-1', '财务', '处理报销与预算问题'],
      ['hr-1', '人事', '处理招聘与员工关系问题'],
      ['legal-1', '法务', '处理合同与合规问题'],
      ['admin-1', '行政', '处理办公与行政协调问题'],
      ['it-1', 'IT', '处理账号、设备与系统问题'],
    ]) {
      groupChatService.addMember(user.id, room.id, {
        id: employee[0],
        employeeId: employee[0],
        kind: 'staffdeck',
        name: employee[1],
        role: 'StaffDeck 数字员工',
        description: employee[2],
      });
    }

    const sent = groupChatService.sendMessage(user.id, room.id, {
      content: '请从财务、人事、法务、行政和 IT 五个部门综合评估新员工入职方案，需要时咨询合适的数字员工。',
      attachments: [{ name: 'onboarding.md', path: attachmentPath, size: 48, mimeType: 'text/markdown' }],
      clientMessageId: 'staffdeck-agentic-delegation-test',
    });
    await vi.waitFor(() => {
      expect(['completed', 'failed']).toContain(groupChatDb.getTurn(user.id, room.id, sent.roundId).status);
    }, { timeout: 12_000 });
    const completedTurn = groupChatDb.getTurn(user.id, room.id, sent.roundId);
    expect(completedTurn.status, completedTurn.error || 'group turn failed').toBe('completed');

    const timeline = groupChatDb.listMessages(user.id, room.id, 30);
    expect(timeline.find((message) => message.kind === 'activity')?.content)
      .toContain('跨部门问题');
    expect(timeline.filter((message) => message.kind === 'delegation').map((message) => message.metadata))
      .toEqual(['finance-1', 'hr-1', 'legal-1', 'admin-1', 'it-1'].map((targetMemberId, index) => expect.objectContaining({
        state: 'completed', targetMemberId, delegationIndex: index + 1, delegationReason: 'agentic',
      })));
    expect(timeline.filter((message) => ['finance-1', 'hr-1', 'legal-1', 'admin-1', 'it-1'].includes(message.senderMemberId)))
      .toHaveLength(5);
    expect(timeline.at(-1)).toMatchObject({
      senderMemberId: 'main',
      content: '已综合财务、人事、法务、行政和 IT 五位数字员工的意见。',
    });
    expect(stub.requests).toHaveLength(20);
    const runRequests = stub.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/runs'));
    expect(runRequests).toHaveLength(5);
    expect(runRequests.every((request) => request.body.attachments?.[0]?.text?.includes('入职方案'))).toBe(true);
    expect(runRequests.every((request) => request.body.input?.includes('# 入职方案'))).toBe(true);
  }, 15_000);
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}
