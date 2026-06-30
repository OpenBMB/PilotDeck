import { describe, expect, it } from 'vitest';
import {
  getWebSearchTestApiKey,
  isMissingWebSearchCredentialError,
  isWebSearchTestDisabled,
} from './pilotDeckConfigForm';

describe('PilotDeckConfigTab web search test helpers', () => {
  it('sends only usable inline API keys to the backend', () => {
    expect(getWebSearchTestApiKey(' inline-key ')).toBe('inline-key');
    expect(getWebSearchTestApiKey('')).toBe('');
    expect(getWebSearchTestApiKey('********')).toBe('');
    expect(getWebSearchTestApiKey('PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE')).toBe('');
    expect(getWebSearchTestApiKey('PLACEHOLDER_WEB_SEARCH')).toBe('');
  });

  it('does not disable testing just because the inline API key is empty', () => {
    expect(isWebSearchTestDisabled('idle')).toBe(false);
    expect(isWebSearchTestDisabled('error')).toBe(false);
    expect(isWebSearchTestDisabled('success')).toBe(false);
    expect(isWebSearchTestDisabled('testing')).toBe(true);
  });

  it('maps the backend missing-key response to localizable UI copy', () => {
    expect(isMissingWebSearchCredentialError('API key is required.')).toBe(true);
    expect(isMissingWebSearchCredentialError(' API key is required. ')).toBe(true);
    expect(isMissingWebSearchCredentialError('Custom provider endpoint is required.')).toBe(false);
  });
});
