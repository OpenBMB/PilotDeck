import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from '../../../utils/api';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  setCsrfToken(null);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser, csrfToken?: string | null) => {
    setUser(nextUser);
    setToken('cookie-session');
    setCsrfToken(csrfToken || null);
    // Remove the obsolete browser-readable JWT when an installation upgrades.
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.authDisabled) {
        setUser(statusPayload.localUser || { username: 'local' });
        setToken('local-session');
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return;
      }

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setSession(userPayload.user, userPayload.csrfToken);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, setSession]);

  useEffect(() => {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    void checkAuthStatus();
  }, [checkAuthStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.csrfToken);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.csrfToken);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const logout = useCallback(() => {
    if (token) {
      void api.auth.logout().catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      }).finally(clearSession);
      return;
    }
    clearSession();
  }, [clearSession, token]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
