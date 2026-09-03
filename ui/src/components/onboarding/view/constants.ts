import {
  type CatalogProvider,
} from '../../../shared/catalogProviders';

export const ONBOARDING_STEP_IDS = ['language', 'provider', 'connection', 'workspace'] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const CUSTOM_PROVIDER_ID = '__custom__';

export const RESERVED_CUSTOM_PROVIDER_IDS = new Set([
  'anthropic',
  'bailian',
  'custom',
  'dashscope',
  'deepseek',
  'gemini',
  'google',
  'kimi',
  'minimax',
  'moonshot',
  'ollama',
  'openai',
  'openai-responses',
  'openrouter',
  'volc_ark',
  'volcengine',
  'zhipu',
]);

export const CUSTOM_PROVIDER: CatalogProvider = {
  id: CUSTOM_PROVIDER_ID,
  displayName: 'Custom',
  protocol: 'openai',
  defaultUrl: '',
  models: [],
};

export const DEFAULT_PROVIDER = CUSTOM_PROVIDER;

export const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';
export const MASKED_SECRET = '********';

export const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: '/onboarding/providers/anthropic.svg',
  openai: '/onboarding/providers/openai.svg',
  'openai-responses': '/onboarding/providers/openai.svg',
  dashscope: '/onboarding/providers/bailian-color.svg',
  deepseek: '/onboarding/providers/deepseek-color.svg',
  google: '/onboarding/providers/gemini-color.svg',
  openrouter: '/onboarding/providers/openrouter-color.svg',
  ollama: '/onboarding/providers/ollama.svg',
  minimax: '/onboarding/providers/minimax-color.svg',
  moonshot: '/onboarding/providers/kimi.svg',
  volc_ark: '/onboarding/providers/volcengine-color.svg',
  zhipu: '/onboarding/providers/zhipu-color.svg',
};

export const MAX_ONBOARDING_MODELS = 10;
