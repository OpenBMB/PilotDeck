// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const mocks = vi.hoisted(() => ({
  commitRaw: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../hooks/usePilotDeckConfig', () => ({
  usePilotDeckConfig: () => ({
    raw: 'modules:\n  knowledge:\n    enabled: true\n    defaultBaseId: old-base\n',
    loading: false,
    saving: false,
    error: null,
    commitRaw: mocks.commitRaw,
    refresh: mocks.refresh,
  }),
}));

import { ProfileTextSetting } from './modules/shared';

afterEach(() => vi.clearAllMocks());

describe('profile-backed module settings', () => {
  it('reads, saves, and refreshes the real config-backed field', async () => {
    mocks.commitRaw.mockResolvedValue({ ok: true });
    mocks.refresh.mockResolvedValue(undefined);
    render(<ProfileTextSetting slot="knowledge" field="defaultBaseId" label="Default knowledge base" description="Used for query." />);
    const input = screen.getByLabelText('Default knowledge base');
    expect((input as HTMLInputElement).value).toBe('old-base');
    fireEvent.change(input, { target: { value: 'new-base' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.commitRaw).toHaveBeenCalledOnce());
    expect(parse(mocks.commitRaw.mock.calls[0][0]).modules.knowledge.defaultBaseId).toBe('new-base');
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('Saved and reloaded');
  });
});
