import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import pilotdeckLogoDark from '../../../assets/pilotdeck-wordmark-dark.png';
import pilotdeckLogoLight from '../../../assets/pilotdeck-wordmark-light.png';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type SetupFormState = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  username: '',
  password: '',
  confirmPassword: '',
};

/**
 * Validates the account-setup form state.
 * @returns An error message string if validation fails, or `null` when the
 *   form is valid.
 */
function validateSetupForm(formState: SetupFormState, t: TFunction): string | null {
  if (!formState.username.trim() || !formState.password || !formState.confirmPassword) {
    return t('common:uiText.requiredFields');
  }

  if (formState.username.trim().length < 3) {
    return t('common:uiText.usernameLength');
  }

  if (formState.password.length < 6) {
    return t('common:uiText.passwordLength');
  }

  if (formState.password !== formState.confirmPassword) {
    return t('common:uiText.passwordMismatch');
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
  const { t } = useTranslation('common');
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

      const validationError = validateSetupForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await register(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register, t],
  );

  return (
    <AuthScreenLayout
      title={t('common:uiText.welcome')}
      description={t('common:uiText.setupDescription')}
      footerText={t('common:uiText.singleUser')}
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
        <AuthInputField
          id="username"
          name="username"
          label={t('common:uiText.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('common:uiText.enterUsername')}
          isDisabled={isSubmitting}
          autoComplete="username"
        />

        <AuthInputField
          id="password"
          name="password"
          label={t('common:uiText.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('common:uiText.enterPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('common:uiText.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('common:uiText.confirmPasswordPlaceholder')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
        />

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-[var(--pd-accent,#2563eb)] px-4 py-2 font-medium text-white transition-colors duration-200 hover:bg-[var(--pd-button-hover,#1d4ed8)] disabled:bg-[var(--pd-accent,#60a5fa)]"
        >
          {isSubmitting ? t('common:uiText.settingUp') : t('common:uiText.createAccount')}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
