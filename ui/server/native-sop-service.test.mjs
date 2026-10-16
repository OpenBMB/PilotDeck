// @vitest-environment node
import { expect, it } from 'vitest';
import { createNativeSopService } from './native-sop-service.mjs';

it('repairs invalid model output once and leaves a persisted draft untouched on failure', async () => {
  const operations = []; let completions = 0, models = 0; let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const service = createNativeSopService({ config: () => ({ hostAdapter: 'pilotdeck', endpoint: 'http://runtime' }),
    request: async (_url, options) => {
      const command = JSON.parse(options.body); operations.push(command);
      if (command.operation === 'job_create') return Response.json({ ok: true, result: { id: 'job', input: command.input.input } });
      if (command.operation === 'job_complete') { completions++; return Response.json({ ok: false, error: { code: 'SOP_DEFINITION_INVALID', message: 'Invalid successor' } }, { status: 422 }); }
      if (command.operation === 'job_fail') finished();
      return Response.json({ ok: true, result: {} });
    }, modelPort: async () => ({ call: async operation => {
      if (operation === 'list_model_catalog') return { body: { data: [{ id: 'test/model', is_default: true }] } };
      models++; return { status: 200, body: (async function* () { yield JSON.stringify({ type: 'text_delta', text: '{"skill_id":"sop","nodes":[]}' }) + '\n'; })() };
    } }),
  });
  await service.generate({ sopId: 'sop', draftId: 'draft', etag: '3', current: { name: 'Original' } }, 'rewrite'); await done;
  expect(models).toBe(2); expect(completions).toBe(2);
  expect(operations.filter(item => item.operation === 'job_chunk_reset')).toHaveLength(1);
  expect(operations.some(item => ['publish', 'replace_draft'].includes(item.operation))).toBe(false);
  expect(operations.at(-1)).toMatchObject({ operation: 'job_fail', input: { error: 'Invalid successor' } });
});
