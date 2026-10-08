// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import ModelPoolSections from './index';
const mocks=vi.hoisted(()=>({commit:vi.fn()}));
vi.mock('../../../../hooks/usePilotDeckConfig',()=>({usePilotDeckConfig:()=>({
  raw:JSON.stringify({agent:{model:'HX API/old',maxContextTokens:128000},model:{providers:{'HX API':{protocol:'openai',url:'https://example.invalid/v1',models:{old:{},untested:{}}}}}}),
  loading:false,error:null,commitRaw:mocks.commit,acceptServerConfig:vi.fn(),
})}));
vi.mock('./components/ModelsSection',()=>({default:()=> <div data-testid="modern-provider-workspace"/>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('saves an untested primary model from the new model pool without altering providers',async()=>{
 mocks.commit.mockResolvedValue({ok:true});
 render(<ModelPoolSections title="Models"/>);
 const select=screen.getByLabelText('pilotDeckConfig.panels.agents.mainModel.label');
 fireEvent.change(select,{target:{value:'HX API/untested'}});
 await waitFor(()=>expect(mocks.commit).toHaveBeenCalledOnce());
 const next=parse(mocks.commit.mock.calls[0][0]);
 expect(next.agent.model).toBe('HX API/untested');
 expect(next.model.providers['HX API'].models).toEqual({old:{},untested:{}});
 expect(screen.getByTestId('modern-provider-workspace')).toBeTruthy();
 expect(document.querySelector('[data-model-reference="agent.model"]')).toBeTruthy();
});
it.each([['65536',65536],['',undefined]])('migrates the saved context override and saves %j without changing model capabilities',async(value,expected)=>{
 mocks.commit.mockResolvedValue({ok:true});
 render(<ModelPoolSections title="Models"/>);
 const input=screen.getByLabelText('pilotDeckConfig.panels.agents.mainModel.contextLimit') as HTMLInputElement;
 expect(input.value).toBe('128000');
 fireEvent.change(input,{target:{value}});
 fireEvent.blur(input);
 await waitFor(()=>expect(mocks.commit).toHaveBeenCalledOnce());
 const next=parse(mocks.commit.mock.calls[0][0]);
 expect(next.agent.model).toBe('HX API/old');
 expect(next.agent.maxContextTokens).toBe(expected);
 expect(next.model.providers['HX API'].models).toEqual({old:{},untested:{}});
});
