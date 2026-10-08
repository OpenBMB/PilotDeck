import { expect, it } from 'vitest';
import { buildModelRefOptions, ensureModelRefConfigured, splitModelRef } from './modelRefs';
import type { PilotDeckConfig } from '../types';
it('keeps model dots and additional slashes when resolving a configured provider',()=>{
 expect(splitModelRef('HX API/qwen3.6/27b')).toEqual({providerId:'HX API',modelId:'qwen3.6/27b'});
});
it('keeps null model definitions intact when selecting a model',()=>{
 const config={model:{providers:{custom:{models:{model:null}}}}} as PilotDeckConfig;
 expect(ensureModelRefConfigured(config,'custom/model')).toBe(config);
});
it('adds a selected catalog model without altering sibling or provider settings',()=>{
 const config={model:{providers:{custom:{url:'https://example.invalid/v1',models:{old:{}}}}}} as PilotDeckConfig;
 const next=ensureModelRefConfigured(config,'custom/new.model/v2');
 expect(next.model?.providers?.custom.models).toEqual({old:{},'new.model/v2':{}});
 expect(config.model?.providers?.custom.models).toEqual({old:{}});
 expect(next.model?.providers?.custom.url).toBe('https://example.invalid/v1');
 expect(buildModelRefOptions(next).map(option=>option.value)).toEqual(['custom/old','custom/new.model/v2']);
});
