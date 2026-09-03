import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import ModelConfigurationErrorScreen from './ModelConfigurationErrorScreen';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, modelConfiguration, refreshOnboardingStatus } = useAuth();

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

  return <>{children}</>;
}
