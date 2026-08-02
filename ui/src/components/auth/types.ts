import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  displayName?: string;
  systemRole?: 'owner' | 'admin' | 'member';
  mustChangePassword?: boolean;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  csrfToken?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
  authDisabled?: boolean;
  authEnabled?: boolean;
  localUser?: AuthUser | null;
};

export type AuthUserPayload = {
  user?: AuthUser;
  csrfToken?: string;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

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
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
