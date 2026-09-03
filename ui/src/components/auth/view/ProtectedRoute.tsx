import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import Onboarding from "../../onboarding/view/Onboarding";
import AuthLoadingScreen from "./AuthLoadingScreen";
import LoginForm from "./LoginForm";
import SetupForm from "./SetupForm";

type ProtectedRouteProps = {
  children: ReactNode;
};

/** TEMP for onboarding UI work. Set back to false when done. */
const FORCE_ONBOARDING_FOR_DEV = true;

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const {
    user,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    refreshOnboardingStatus,
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

  // if (!hasCompletedOnboarding) {
  //   return <Onboarding onComplete={refreshOnboardingStatus} />;
  // }
  if (FORCE_ONBOARDING_FOR_DEV || !hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
