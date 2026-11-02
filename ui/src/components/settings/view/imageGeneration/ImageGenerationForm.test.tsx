// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImageGenerationForm } from './index';
import type { PilotDeckConfig } from '../modelPool/types';

vi.unmock('lucide-react');
afterEach(cleanup);
const config = { agent: { model: 'test/model' }, model: { providers: {} } } as PilotDeckConfig;

it('starts disabled, allows configuration before opting in, and preserves a masked key for same-address model edits', () => {
  const change = vi.fn();
  const { rerender } = render(<ImageGenerationForm config={config} onChange={change} />);
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
  const configured = { ...config, tools: { imageGeneration: { enabled: false, apiKey: '********', baseUrl: 'https://images.example/v1', model: 'image-model' } } };
  rerender(<ImageGenerationForm config={configured} onChange={change} />);
  fireEvent.click(screen.getByRole('switch'));
  expect(change.mock.calls.at(-1)?.[0].tools.imageGeneration.enabled).toBe(true);
  fireEvent.click(screen.getByText('settingsPage.actions.edit'));
  fireEvent.change(screen.getByLabelText('imageGeneration.model'), { target: { value: 'another-model' } });
  fireEvent.click(screen.getByText('settingsPage.actions.save'));
  expect(change.mock.calls.at(-1)?.[0].tools.imageGeneration).toMatchObject({ apiKey: '********', model: 'another-model', enabled: false });
});
