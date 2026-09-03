import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
  authDisabled?: boolean;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
  configuration?: ServerModelConfigurationState;
  gateway?: GatewayRuntimeState;
  error?: string;
};

export type ModelConfigurationReason =
  | 'missing_config'
  | 'missing_model'
  | 'missing_credential'
  | 'legacy_placeholder';

type ModelConfigurationBase = {
  configPath: string | null;
  revision: string;
};

export type ServerModelConfigurationState = ModelConfigurationBase & (
  | { state: 'needs_configuration'; reason: ModelConfigurationReason }
  | { state: 'ready'; modelRef: string }
  | { state: 'invalid'; errors: string[] }
);

export type ModelConfigurationState =
  | { state: 'loading' }
  | ServerModelConfigurationState
  | { state: 'status_error'; error: string };

export type GatewayRuntimeState =
  | { state: 'unmanaged' | 'stopped' | 'starting' | 'ready' }
  | { state: 'error'; error: string };

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  modelConfiguration: ModelConfigurationState;
  gatewayRuntime: GatewayRuntimeState;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
  retryGateway: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
