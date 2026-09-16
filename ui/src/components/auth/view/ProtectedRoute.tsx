import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import AuthLoadingScreen from './AuthLoadingScreen';
import GatewayRuntimeErrorScreen from './GatewayRuntimeErrorScreen';
import LoginForm from './LoginForm';
import ModelConfigurationErrorScreen from './ModelConfigurationErrorScreen';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { pathname } = useLocation();
  const {
    user,
    isLoading,
    needsSetup,
    modelConfiguration,
    gatewayRuntime,
    refreshOnboardingStatus,
    retryGateway,
  } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  // Settings must remain reachable to repair an invalid model configuration.
  // Authentication above still applies when the Gateway cannot run.
  if (pathname === '/settings' || pathname.startsWith('/settings/'))
    return <>{children}</>;

  if (modelConfiguration.state === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (modelConfiguration.state === 'empty') return <>{children}</>;

  if (modelConfiguration.state !== 'needs_configuration') {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  if (
    modelConfiguration.state === 'invalid' ||
    modelConfiguration.state === 'status_error'
  ) {
    return (
      <ModelConfigurationErrorScreen
        configuration={modelConfiguration}
        onRetry={refreshOnboardingStatus}
      />
    );
  }

  if (
    gatewayRuntime.state === 'stopped' ||
    gatewayRuntime.state === 'starting'
  ) {
    return <AuthLoadingScreen />;
  }

  if (gatewayRuntime.state === 'error') {
    return (
      <GatewayRuntimeErrorScreen
        error={gatewayRuntime.error}
        onRetry={retryGateway}
      />
    );
  }

  return <>{children}</>;
}
