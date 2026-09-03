import type { ReactNode } from 'react';
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

  if (modelConfiguration.state === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (modelConfiguration.state === 'needs_configuration') {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  if (modelConfiguration.state === 'invalid' || modelConfiguration.state === 'status_error') {
    return (
      <ModelConfigurationErrorScreen
        configuration={modelConfiguration}
        onRetry={refreshOnboardingStatus}
      />
    );
  }

  if (gatewayRuntime.state === 'stopped' || gatewayRuntime.state === 'starting') {
    return <AuthLoadingScreen />;
  }

  if (gatewayRuntime.state === 'error') {
    return <GatewayRuntimeErrorScreen error={gatewayRuntime.error} onRetry={retryGateway} />;
  }

  return <>{children}</>;
}
