import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../plugins/staffdeck-sop/src/vendor/DistillPageHost';
import { createPublicCapabilityAdapter, type PublicJobEventDecoder } from './public-capability-adapter';
const unusedDecoder: PublicJobEventDecoder = async function* () {};

describe('public gateway adapter projections without enabling operations', () => {
  it('unwraps only actual data arrays and preserves response extensions', async () => {
    const rows = [{ id: 'actual-tool', connection: { headers: { secret: '********' } }, extension: { kept: true } }];
    const call = vi.fn().mockResolvedValueOnce({ status: 200, body: { data: rows } }).mockResolvedValueOnce({ status: 200, body: {} });
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: unusedDecoder });
    expect(await adapter.collection('list_tools')).toBe(rows);
    await expect(adapter.collection('list_tools')).rejects.toThrow('data array');
    expect(call.mock.calls[0]).toEqual(['list_tools', {}, { signal: undefined }]);
  });
  it('keeps original failed HTTP body/status/code and never retries or reports success', async () => {
    const raw = '{"error":{"code":"FORBIDDEN","message":"Denied"}}';
    const call = vi.fn().mockResolvedValue({ status: 403, body: raw });
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: unusedDecoder });
    const error = await adapter.collection('list_tools').catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Denied', body: raw });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('preserves 202 acceptance and terminal result draft/ETag without creating another draft', async () => {
    const job = { id: 'public-job', status: 'queued', extension: { source: 'owner' } };
    const result = { job: { id: 'public-job', status: 'completed' }, result: { draft: { id: 'draft-row', sop_id: 'sop', content: { nodes: [{ extension: true }] }, etag: '"same-read"' } }, error: {} };
    const call = vi.fn().mockResolvedValueOnce({ status: 202, body: job }).mockResolvedValueOnce({ status: 200, body: result, headers: { etag: '"actual-response"' } });
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: unusedDecoder });
    expect(await adapter.acceptedJob('generate_sop', { body: { title: 'Title', raw_content: 'Source' } })).toMatchObject({ status: 202, body: job });
    const observed = await adapter.response('get_job_result', { jobId: 'public-job' });
    expect(observed.body).toBe(result);
    expect(observed.headers).toEqual({ etag: '"actual-response"' });
    expect(call.mock.calls.map(([op]) => op)).toEqual(['generate_sop', 'get_job_result']);
  });
  it('propagates denied operation/dirty-preview errors without bypass or save', async () => {
    const error = Object.assign(new Error('Preview required'), { code: 'PUBLIC_PREVIEW_REQUIRED', status: 409 });
    const call = vi.fn().mockRejectedValue(error);
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: unusedDecoder });
    await expect(adapter.acceptedJob('rewrite_saved_sop', { dirty: true, current_skill: { skill_id: 'sop' }, body: { instruction: 'Rewrite' } })).rejects.toMatchObject({ status: 409, code: 'PUBLIC_PREVIEW_REQUIRED', message: 'Preview required', cause: error });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toBe('rewrite_saved_sop');
  });
  it('consumes real events and advances a cursor only after the consumer accepts the event', async () => {
    const wire = Symbol('wire');
    const controller = new AbortController();
    const call = vi.fn().mockResolvedValue({ status: 200, body: wire });
    const events = [{ id: '4', event: 'progress', data: '{"phase":"actual-owner-phase"}' }, { id: '5', event: 'completed', data: '{"draft_id":"real-draft"}' }];
    const decoder: PublicJobEventDecoder = async function* (chunks, options) {
      expect(chunks).toBe(wire);
      expect(options?.signal).toBe(controller.signal);
      yield* events;
    };
    const sequence: string[] = [];
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: decoder });
    expect(await adapter.events({ jobId: 'public-job', lastEventId: '3', signal: controller.signal,
      onEvent: event => { sequence.push(`event:${event.id}:${event.event}:${event.data}`); },
      onConsumedId: id => { sequence.push(`cursor:${id}`); },
    })).toEqual({ lastEventId: '5' });
    expect(sequence).toEqual(events.flatMap(event => [`event:${event.id}:${event.event}:${event.data}`, `cursor:${event.id}`]));
    expect(call.mock.calls[0]).toEqual(['job_events', { jobId: 'public-job', lastEventId: '3' }, { signal: controller.signal }]);
  });
  it('does not advance the resume cursor after a rejected event or synthesize cancellation', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const decoder: PublicJobEventDecoder = async function* () { yield { id: '9', event: 'progress', data: 'actual' }; };
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: decoder });
    const cursor = vi.fn();
    await expect(adapter.events({ jobId: 'job', lastEventId: '8', onEvent: () => { throw new Error('Consumer rejected'); }, onConsumedId: cursor })).rejects.toThrow('Consumer rejected');
    expect(cursor).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });
});


describe('public event cancellation and cursor reset', () => {
  it('does not advance a cursor or issue cancel when the consumer aborts the stream', async () => {
    const controller = new AbortController();
    const call = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const decoder: PublicJobEventDecoder = async function* () { yield { id: '10', event: 'progress', data: 'actual' }; };
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: decoder });
    const cursor = vi.fn();
    await expect(adapter.events({ jobId: 'job', signal: controller.signal, onEvent: () => controller.abort(), onConsumedId: cursor })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cursor).not.toHaveBeenCalled();
    expect(call.mock.calls.map(([op]) => op)).toEqual(['job_events']);
  });
  it('retains a real empty SSE id as cursor reset and omits Last-Event-ID on resume', async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const decoder: PublicJobEventDecoder = async function* () { yield { id: '', event: 'progress', data: 'actual' }; };
    const adapter = createPublicCapabilityAdapter({ client: { call }, decodeEvents: decoder });
    const cursor = vi.fn();
    expect(await adapter.events({ jobId: 'job', lastEventId: '', onEvent: () => {}, onConsumedId: cursor })).toEqual({ lastEventId: '' });
    expect(cursor).toHaveBeenCalledWith('');
    expect(call.mock.calls[0][1]).toEqual({ jobId: 'job' });
  });
});
