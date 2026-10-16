// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../../i18n/locales/en/staffdeck.json';
import zh from '../../../i18n/locales/zh-CN/staffdeck.json';
import { createPublishRuntimeObserver } from './publish-runtime-observer';
import { PublishRuntimeProvider, usePublishRuntimeObserver } from './publish-runtime-context';
import PublishRuntimeStatus from './PublishRuntimeStatus';
import { staffDeckSopManagementClient } from './clients';
import { createPilotDeckDistillPageHost } from './vendor/skills-host-adapter';

const owner = { tenantId: 'tenant', actorUserId: 'actor', agentId: 'agent' };
const bootstrap = (agentId = 'agent', receipts: unknown[] = []) => ({ enabled: true, ...owner, agentId, runtime: { receipts } });
const runtime = { sopId: '新增', status: 'awaiting-runtime-observation', ownerPublished: true, snapshotWritten: true, refreshRequested: true, effective: false, receiptPersisted: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('mounted publish/runtime observation', () => {
  it('clears an archived publication receipt and ignores a late archive from another owner', () => {
    const observer = createPublishRuntimeObserver();
    observer.acceptBootstrap(bootstrap('agent', [runtime]));
    observer.captureArchive(runtime.sopId)({ runtime: { ownerArchived: true, status: 'awaiting-runtime-observation' } });
    expect(observer.getSnapshot().receipts).toEqual([]);
    const late = observer.captureArchive(runtime.sopId);
    observer.acceptBootstrap(bootstrap('replacement', [runtime]));
    late({ runtime: { ownerArchived: true } });
    expect(observer.getSnapshot().receipts).toEqual([runtime]);
  });
  it('restores only owner-scoped gateway receipts and never promotes an ack to effective', () => {
    const observer = createPublishRuntimeObserver();
    observer.acceptBootstrap(bootstrap('agent', [runtime]));
    expect(observer.getSnapshot().receipts).toEqual([runtime]);
    const accept = observer.capturePublish('新增');
    accept({ result: { sop: { skill_id: '新增' } }, runtime: { ...runtime, effective: true } });
    expect(observer.getSnapshot().error).toBe(true);
    expect(observer.getSnapshot().receipts[0].effective).toBe(false);
  });

  it('isolates sibling owners, stale responses and disposed mount cleanup', () => {
    const a = createPublishRuntimeObserver();
    const b = createPublishRuntimeObserver();
    a.acceptBootstrap(bootstrap('a')); b.acceptBootstrap(bootstrap('b'));
    const stale = a.capturePublish('新增');
    a.acceptBootstrap(bootstrap('replacement'));
    stale({ result: {}, runtime });
    expect(a.getSnapshot().receipts).toEqual([]);
    a.dispose();
    b.capturePublish('新增')({ result: {}, runtime });
    expect(b.getSnapshot().receipts).toEqual([runtime]);
    expect(a.getSnapshot().receipts).toEqual([]);
  });

  it('keeps a newer live receipt when an older metadata read finishes later', () => {
    const observer = createPublishRuntimeObserver();
    observer.acceptBootstrap(bootstrap());
    const failed = { ...runtime, status: 'failed', refreshRequested: false, failure: { phase: 'refresh', code: 'SOP_RUNTIME_REFRESH_FAILED' } };
    observer.capturePublish('新增')({ result: {}, runtime: failed });
    observer.acceptBootstrap(bootstrap('agent', [runtime]));
    expect(observer.getSnapshot().receipts[0]).toMatchObject(failed);
  });

  it('keeps publication success and sibling runtime separate across the browser gateway call', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ result: { sop: { skill_id: '新增' } }, runtime }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const observer = createPublishRuntimeObserver(); observer.acceptBootstrap(bootstrap());
    const result = await staffDeckSopManagementClient.call('publish', { sopId: '新增', draftId: 'selected' }, { onManagementEnvelope: observer.capturePublish('新增') });
    expect(result).toEqual({ sop: { skill_id: '新增' } });
    expect(observer.getSnapshot().receipts).toEqual([runtime]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/modules/sop/management/call');
  });

  it('observes the production editor publish path only after the selected draft read', async () => {
    const observer = createPublishRuntimeObserver(); observer.acceptBootstrap(bootstrap());
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      const input = JSON.parse(String(options?.body));
      if (input.operation === 'get_draft') return new Response(JSON.stringify({ result: {
        id: 'draft-row', sop_id: '新增', draft_version: '1.0.1', status: 'draft',
        updated_at: '2026-09-27T01:00:00Z', etag: '"draft-etag"',
        content: { skill_id: '新增', name: 'Original', nodes: [], edges: [] },
      } }));
      expect(observer.getSnapshot().error).toBe(false);
      expect(input).toEqual({ operation: 'publish', input: { sopId: '新增', draftId: 'draft-row' } });
      return new Response(JSON.stringify({ result: { sop: { skill_id: '新增' } }, runtime }));
    });
    vi.stubGlobal('fetch', fetch);
    const host = createPilotDeckDistillPageHost(undefined, observer);
    const signal = new AbortController().signal;
    await expect(host.api.postWithSignal('/api/enterprise/skills/%E6%96%B0%E5%A2%9E/publish?draft_id=draft-row', {}, signal))
      .resolves.toEqual({ sop: { skill_id: '新增' } });
    expect(observer.getSnapshot().receipts).toEqual([runtime]);
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).operation)).toEqual(['get_draft', 'publish']);
    expect(fetch.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
  });

  it('does not turn a rendering callback failure into a failed or repeated publish', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ result: { sop: { skill_id: '新增' } }, runtime }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(staffDeckSopManagementClient.call('publish', {}, { onManagementEnvelope() { throw new Error('UI callback failed'); } }))
      .resolves.toEqual({ sop: { skill_id: '新增' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('renders failed refresh alongside publication success in EN/ZH from one live publish', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/modules/sop/management' ? bootstrap() : {
      result: { sop: { skill_id: '新增' } }, runtime: { ...runtime, status: 'failed', refreshRequested: false, receiptPersisted: false, failure: { phase: 'refresh', code: 'SOP_RUNTIME_REFRESH_FAILED' } },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const i18n = createInstance();
    await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { staffdeck: en }, 'zh-CN': { staffdeck: zh } }, interpolation: { escapeValue: false } });
    function Action() {
      const observer = usePublishRuntimeObserver()!;
      return <button onClick={() => void staffDeckSopManagementClient.call('publish', { sopId: '新增', draftId: 'selected' }, { onManagementEnvelope: observer.capturePublish('新增') })}>Publish</button>;
    }
    render(<I18nextProvider i18n={i18n}><PublishRuntimeProvider><Action /><PublishRuntimeStatus /></PublishRuntimeProvider></I18nextProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Published successfully')).toBeTruthy();
    expect(screen.getByText(en.publishRuntime.failed)).toBeTruthy();
    expect(screen.getByText(en.publishRuntime.snapshotWritten)).toBeTruthy();
    expect(screen.getByText(en.publishRuntime.refreshMissing)).toBeTruthy();
    expect(screen.getByText(en.publishRuntime.receiptFailed)).toBeTruthy();
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(screen.getByText('发布成功')).toBeTruthy();
    expect(screen.getByText(zh.publishRuntime.failed)).toBeTruthy();
    expect(screen.getByText('新增').getAttribute('translate')).toBe('no');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/call'))).toHaveLength(1);
  });
});
