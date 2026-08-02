import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import pilotdeckLogoDark from '../../../assets/pilotdeck-wordmark-dark.png';
import pilotdeckLogoLight from '../../../assets/pilotdeck-wordmark-light.png';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type SetupFormState = {
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  password: '',
  confirmPassword: '',
};

/**
 * Validates the account-setup form state.
 * @returns An error message string if validation fails, or `null` when the
 *   form is valid.
 */
function validateSetupForm(formState: SetupFormState): string | null {
  if (!formState.password || !formState.confirmPassword) {
    return 'Please fill in all fields.';
  }

  if (formState.password.length < 10) {
    return 'Password must be at least 10 characters long.';
  }

  if (formState.password !== formState.confirmPassword) {
    return 'Passwords do not match.';
  }

  return null;
}

/**
 * Account setup / registration form.
 * Uses `autoComplete="new-password"` on password fields so that password
 * managers recognise this as a registration flow and offer to save the new
 * credentials after submission.
 */
export default function SetupForm() {
  const { register } = useAuth();

  const [formState, setFormState] = useState<SetupFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof SetupFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateSetupForm(formState);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await register('owner', formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register],
  );

  return (
    <AuthScreenLayout
      title="Welcome to PilotDeck"
      description="Set up your account to get started"
      footerText="This creates the immutable owner account for this installation."
      logo={
        <div className="flex items-center justify-center gap-2">
          <img
            src={pilotdeckLogoLight}
            alt="PilotDeck"
            className="h-14 w-auto max-w-72 select-none object-contain dark:hidden"
            draggable={false}
          />
          <img
            src={pilotdeckLogoDark}
            alt="PilotDeck"
            className="hidden h-14 w-auto max-w-72 select-none object-contain dark:block"
            draggable={false}
          />
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800">
          Owner username: <span className="font-mono font-medium">owner</span>
        </div>

        <AuthInputField
          id="password"
          name="password"
          label="Password"
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder="Enter your password"
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label="Confirm Password"
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder="Confirm your password"
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? 'Setting up...' : 'Create Account'}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
