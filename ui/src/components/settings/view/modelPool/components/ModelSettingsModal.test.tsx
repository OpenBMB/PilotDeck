// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModelSettingsModal from './ModelSettingsModal';
vi.mock('react-i18next', () => ({useTranslation: () => ({t:(key:string)=>key})}));
afterEach(cleanup);
const initial = {maxOutputTokens:8192,maxContextTokens:128000,supportsImage:false};
const props = () => ({modelId:'one',initial,testDisabled:false,onTest:vi.fn(),onCancelTest:vi.fn(),onSave:vi.fn(async()=>({ok:true})),onClose:vi.fn()});
const task = (imageInput: string) => ({id:'task',modelId:'one',providerId:'HXAPI',status:'success' as const,result:{models:[{modelId:'one',textInput:'supported',imageInput}]}});
it('does not overwrite a manual choice made while testing or by repeated polling', () => {
  const p = props();
  const {rerender} = render(<ModelSettingsModal {...p} task={{...task('unknown'),status:'testing'}} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }));
  rerender(<ModelSettingsModal {...p} task={task('supported')} />);
  expect((screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }) as HTMLInputElement).checked).toBe(false);
  rerender(<ModelSettingsModal {...p} task={{...task('supported')}} />);
  expect((screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }) as HTMLInputElement).checked).toBe(false);
});
it('keeps the previous image flag for an unknown result and changes only the draft on success', () => {
  const p = {...props(),initial:{...initial,supportsImage:true}};
  const {rerender} = render(<ModelSettingsModal {...p} task={task('unknown')} />);
  expect((screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }) as HTMLInputElement).checked).toBe(true);
  rerender(<ModelSettingsModal {...p} task={{...task('unsupported'),id:'next'}} />);
  expect((screen.getByRole('checkbox', { name: 'pilotDeckConfig.panels.models.modelSettings.imageInput' }) as HTMLInputElement).checked).toBe(false);
  expect(p.onSave).not.toHaveBeenCalled();
});
it('validates positive integer token limits and keeps the dialog on save failure', async () => {
  const p = {...props(),onSave:vi.fn(async()=>({ok:false,error:'Conflict'}))};
  render(<ModelSettingsModal {...p} />);
  const save = screen.getByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.save'}) as HTMLButtonElement;
  const output = screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens');
  fireEvent.change(output,{target:{value:'1.5'}});expect(save.disabled).toBe(true);
  fireEvent.change(output,{target:{value:'0'}});expect(save.disabled).toBe(true);
  fireEvent.change(output,{target:{value:'16384'}});fireEvent.click(save);
  await screen.findByText('Conflict');expect(p.onClose).not.toHaveBeenCalled();
});
it('allows closing a running test without cancelling it', () => {
  const p = props();render(<ModelSettingsModal {...p} task={{...task('unknown'),status:'testing'}} />);
  fireEvent.click(screen.getByRole('button',{name:'confirmDialog.close'}));
  expect(p.onClose).toHaveBeenCalled();expect(p.onCancelTest).not.toHaveBeenCalled();
});
it('models default, enabled and disabled as mutually exclusive choices, preserving effort settings', async () => {
  const p = props();
  render(<ModelSettingsModal {...p} />);
  const enabled = screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.thinkingEnabled'}) as HTMLInputElement;
  const disabled = screen.getByRole('checkbox', {name:'pilotDeckConfig.panels.models.modelSettings.thinkingDisabled'}) as HTMLInputElement;
  expect(enabled.checked).toBe(false); expect(disabled.checked).toBe(false);
  expect(screen.queryByRole('checkbox', {name:'low'})).toBeNull();
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole('checkbox', {name:'low'}));
  fireEvent.click(screen.getByRole('checkbox', {name:'xhigh'}));
  fireEvent.click(disabled);
  expect(enabled.checked).toBe(false); expect(disabled.checked).toBe(true);
  expect(screen.queryByRole('checkbox', {name:'low'})).toBeNull();
  fireEvent.click(disabled);
  expect(disabled.checked).toBe(false); expect(enabled.checked).toBe(false);
  fireEvent.click(enabled);
  expect((screen.getByRole('checkbox', {name:'low'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('pilotDeckConfig.panels.models.modelSettings.thinkingFormat'), {target:{value:'qwen-local'}});
  fireEvent.click(screen.getByRole('button', {name:'pilotDeckConfig.panels.models.modelSettings.save'}));
  await waitFor(() => expect(p.onSave).toHaveBeenCalledWith({...initial, thinking:{state:'enabled',efforts:['low','xhigh'],format:'qwen-local'}}));
});
it('restricts advanced formats to the selected request protocol', () => {
  render(<ModelSettingsModal {...props()} protocol="anthropic" />);
  const select = screen.getByLabelText('pilotDeckConfig.panels.models.modelSettings.thinkingFormat') as HTMLSelectElement;
  expect([...select.options].map(option=>option.value)).toEqual(['provider','anthropic','server-default']);
});
