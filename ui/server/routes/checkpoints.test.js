// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createCheckpointHandler } from './checkpoints.js';
import { parseGitStatus, gitStatusError } from '../utils/gitStatus.js';

describe('checkpoint HTTP boundary', () => {
  const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  it('resolves registered project identity and forwards explicit selections', async () => {
    const manageCheckpoints = vi.fn(async () => ({ id: 'plan' }));
    const resolveProject = vi.fn(async () => '/registered/project');
    const handler = createCheckpointHandler({ getGateway: async () => ({ manageCheckpoints }), resolveProject });
    const res = response();
    await handler({ body: { project: 'encoded-project', sessionId: 'web:session', action: 'restore', planId: 'plan', paths: ['a.txt'] } }, res);
    expect(res.statusCode).toBe(200); expect(manageCheckpoints).toHaveBeenCalledWith(expect.objectContaining({ projectKey: '/registered/project', sessionKey: 'web:session', paths: ['a.txt'] }));
  });
  it('rejects malformed selections and maps modification conflicts to 409', async () => {
    const gateway = vi.fn(async () => ({ manageCheckpoints: async () => { throw new Error('File changed after the preview'); } }));
    const handler = createCheckpointHandler({ getGateway: gateway, resolveProject: async () => '/project' });
    const invalid = response(); await handler({ body: { project: 'p', sessionId: 's', action: 'restore', paths: [7] } }, invalid);
    expect(invalid.statusCode).toBe(400); expect(gateway).not.toHaveBeenCalled();
    const stale = response(); await handler({ body: { project: 'p', sessionId: 's', action: 'restore' } }, stale); expect(stale.statusCode).toBe(409);
  });
});

it('parses staged and unstaged sides, renames, conflicts and unusual filenames without trimming', () => {
  const entries = parseGitStatus('MM normal.txt\0R  new name.txt\0old\nname.txt\0??  leading.txt\0UU conflict.txt\0');
  expect(entries[0]).toMatchObject({ path: 'normal.txt', staged: true, unstaged: true });
  expect(entries[1]).toMatchObject({ path: 'new name.txt', originalPath: 'old\nname.txt', staged: true });
  expect(entries[2]).toMatchObject({ path: ' leading.txt', untracked: true, staged: false });
  expect(entries[3]).toMatchObject({ conflicted: true, staged: false });
});

it('reports an ordinary folder even when Git repository errors start with a capital letter', () => {
  expect(gitStatusError(new Error('Not a git repository. This directory does not contain a .git folder.'))).toMatchObject({ isRepository: false, code: 'NOT_GIT_REPOSITORY' });
});
