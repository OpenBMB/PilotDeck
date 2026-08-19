import {
  CATALOG_PROVIDERS,
  type CatalogProvider,
} from '../../../shared/catalogProviders';

export const ONBOARDING_STEP_IDS = ['language', 'provider', 'connection', 'workspace'] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const CUSTOM_PROVIDER_ID = '__custom__';

export const CUSTOM_PROVIDER: CatalogProvider = {
  id: CUSTOM_PROVIDER_ID,
  displayName: 'Custom',
  protocol: 'openai',
  defaultUrl: '',
  models: [],
};

export const DEFAULT_PROVIDER =
  CATALOG_PROVIDERS.find((provider) => provider.id === 'openrouter') ?? CATALOG_PROVIDERS[0];

export const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';
export const MASKED_SECRET = '********';
