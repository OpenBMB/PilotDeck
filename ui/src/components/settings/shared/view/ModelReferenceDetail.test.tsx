// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModelReferenceDetail, { modelReferencePath } from './ModelReferenceDetail';
import type { PilotDeckConfig } from '../../view/modelPool/types';
afterEach(cleanup);
const config = { agent: { model: 'other/new' }, model: { providers: { 'HX API': { models: { 'qwen3.6/27b': {} } }, other: { models: { new: {} } } } } } as PilotDeckConfig;
it('keeps dots and slashes in pricing model IDs as one path key', () => {
  const reference = 'router.stats.modelPricing.HX API/qwen3.6/27b';
  expect(modelReferencePath(reference)).toEqual(['router','stats','modelPricing','HX API/qwen3.6/27b']);
  render(<ModelReferenceDetail config={{...config,router:{enabled:false,stats:{modelPricing:{'HX API/qwen3.6/27b':{input:2,output:3}}}}}} reference={reference} onChange={vi.fn()} />);
  expect(screen.getByText('2')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('edits the exact fallback slot and preserves the remaining configuration', async () => {
  const next={...config,router:{fallback:{coding:['HX API/qwen3.6/27b','other/new']}}};
  const save=vi.fn();
  render(<ModelReferenceDetail config={next} reference="router.fallback.coding.0" onChange={save} />);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'other/new'}});
  await waitFor(()=>expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].router.fallback.coding).toEqual(['other/new','other/new']);
  expect(save.mock.calls[0][0].model).toEqual(config.model);
  expect(next.router.fallback.coding).toEqual(['HX API/qwen3.6/27b','other/new']);
});
it('preserves object reference metadata and updates both ID and provider/model', async () => {
  const next={...config,agent:{model:'HX API/qwen3.6/27b'},router:{scenarios:{default:{id:'HX API/qwen3.6/27b',provider:'HX API',model:'qwen3.6/27b',tag:'keep'}}}} as unknown as PilotDeckConfig;
  const save=vi.fn();
  render(<ModelReferenceDetail config={next} reference="router.scenarios.default" onChange={save} />);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'other/new'}});
  await waitFor(()=>expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].router.scenarios.default).toEqual({id:'other/new',provider:'other',model:'new',tag:'keep'});
  expect(save.mock.calls[0][0].agent.model).toBe('other/new');
});
it('saves the default route together with the canonical main model', async () => {
  const next = { ...config, agent: { model: 'HX API/qwen3.6/27b', subagents: { default: 'inherit' } }, router: { enabled: true, scenarios: { default: 'HX API/qwen3.6/27b' } } };
  const save = vi.fn();
  render(<ModelReferenceDetail config={next} reference="router.scenarios.default" onChange={save} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other/new' } });
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].agent).toEqual({ model: 'other/new', subagents: { default: 'inherit' } });
  expect(save.mock.calls[0][0].router.scenarios.default).toBe('other/new');
  expect(next.agent.model).toBe('HX API/qwen3.6/27b');
});
it('keeps the main model when editing a non-default legacy scenario', async () => {
  const next = { ...config, router: { scenarios: { default: 'other/new', coding: 'other/new' } } };
  const save = vi.fn();
  render(<ModelReferenceDetail config={next} reference="router.scenarios.coding" onChange={save} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HX API/qwen3.6/27b' } });
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0].agent.model).toBe('other/new');
  expect(save.mock.calls[0][0].router.scenarios.default).toBe('other/new');
  expect(save.mock.calls[0][0].router.scenarios.coding).toBe('HX API/qwen3.6/27b');
});
it('blocks a second edit during saving and displays a save failure', async () => {
  let reject!: (error: Error)=>void;
  const save=vi.fn(()=>new Promise<void>((_,r)=>{reject=r;}));
  render(<ModelReferenceDetail config={{...config,router:{enabled:false,tokenSaver:{judge:'HX API/qwen3.6/27b'}}}} reference="router.tokenSaver.judge" onChange={save} />);
  const select=screen.getByRole('combobox') as HTMLSelectElement;
  fireEvent.change(select,{target:{value:'other/new'}});
  expect(select.disabled).toBe(true);
  reject(new Error('Save rejected'));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toBe('Save rejected');
  expect(select.disabled).toBe(false);
});
