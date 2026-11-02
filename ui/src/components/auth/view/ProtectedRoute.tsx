import type { ReactNode } from 'react';
import { useSettingsRouteMatch } from '../../app-shell/appRoutes';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import AuthLoadingScreen from './AuthLoadingScreen';
import GatewayRuntimeErrorScreen from './GatewayRuntimeErrorScreen';
import LoginForm from './LoginForm';
import ModelConfigurationErrorScreen from './ModelConfigurationErrorScreen';
import SetupForm from './SetupForm';
import StartupReady from './StartupReady';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const settingsRouteMatch = useSettingsRouteMatch();
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
    return <StartupReady><SetupForm /></StartupReady>;
  }

  if (!user) {
    return <StartupReady><LoginForm /></StartupReady>;
  }

  // Settings must remain reachable to repair an invalid model configuration.
  // Authentication above still applies when the Gateway cannot run.
  if (settingsRouteMatch) return <StartupReady>{children}</StartupReady>;

  if (modelConfiguration.state === 'loading') {
    return <AuthLoadingScreen />;
  }

  if (modelConfiguration.state === 'empty') return <StartupReady>{children}</StartupReady>;

  if (modelConfiguration.state === 'needs_configuration') {
    return <StartupReady><Onboarding onComplete={refreshOnboardingStatus} /></StartupReady>;
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
    return <AuthLoadingScreen gateway />;
  }

  if (gatewayRuntime.state === 'error') {
    return <GatewayRuntimeErrorScreen error={gatewayRuntime.error} onRetry={retryGateway} />;
  }

  return <StartupReady>{children}</StartupReady>;
}
