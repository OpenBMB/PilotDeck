// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const policy = vi.hoisted(() => ({ knowledge: false, versionManagement: false }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: async (url: string) => ({ ok: true, json: async () => url.endsWith('capabilities')
  ? { models: [], bindings: [], features: { ...policy } }
  : { data: [{ sop_id: 'example', name: 'Example', status: 'published', published_version: '1.0.0', content: { skill_id: 'example', version: '1.0.0', nodes: [], edges: [] } }], drafts: [] } }) }));
vi.mock('./staffdeck/vendor/DistillPage', () => ({ SkillFlow: (props: any) => <div data-testid="graph-policy">{JSON.stringify({ knowledge: props.knowledgeEnabled, versionManagement: props.versionManagement })}</div> }));
vi.mock('./staffdeck/vendor/SopVersionDetailDialog', () => ({ default: () => null }));
vi.mock('./staffdeck/vendor/FormalSopApprovalInbox', () => ({ default: () => null }));
vi.mock('./staffdeck/StaffDeckLocaleBoundary', () => ({ default: ({ children }: any) => children }));
import { PilotDeckSopPage } from './pilotdeck-sop';
afterEach(cleanup);
it('hides version controls while preserving editing when version management is disabled', async () => {
  Object.assign(policy, { knowledge: false, versionManagement: false });
  render(<PilotDeckSopPage />);
  await waitFor(() => expect(screen.getByText('编辑工作流')).toBeTruthy());
  expect(screen.queryByRole('button', { name: /^版本$/ })).toBeNull();
  expect(screen.queryByText('新版本草稿')).toBeNull();
  expect(screen.queryByText('1.0.0')).toBeNull();
});

it.each([[false, false], [false, true], [true, false], [true, true]])('applies knowledge=%s versions=%s to the editor and shared graph', async (knowledge, versionManagement) => {
  Object.assign(policy, { knowledge, versionManagement });
  render(<PilotDeckSopPage />);
  await screen.findByText(versionManagement ? '新版本草稿' : '编辑工作流');
  expect(Boolean(screen.queryByRole('button', { name: /^版本$/ }))).toBe(versionManagement);
  fireEvent.click(screen.getByRole('button', { name: /^新建$/ }));
  expect(Boolean(screen.queryByLabelText('版本号'))).toBe(versionManagement);
  expect(JSON.parse(screen.getByTestId('graph-policy').textContent!)).toEqual({ knowledge, versionManagement });
});
