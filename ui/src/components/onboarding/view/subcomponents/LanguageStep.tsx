import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, ChoiceCheckIcon, TranslateIcon, WelcomeWaveIcon } from './icons';

type LanguageStepProps = {
  onContinue: () => void;
};

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', nameKey: 'language.zh.name', hintKey: 'language.zh.hint' },
  { value: 'en', nameKey: 'language.en.name', hintKey: 'language.en.hint' },
] as const;

export default function LanguageStep({ onContinue }: LanguageStepProps) {
  const { t, i18n } = useTranslation('onboarding');
  const activeLanguage = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';

  return (
    <div className="content-page welcome-page">
      <div className="welcome-visual" aria-hidden="true">
        <WelcomeWaveIcon />
      </div>
      <header className="page-intro">
        <p className="eyebrow">{t('language.eyebrow')}</p>
        <h1>{t('language.title')}</h1>
        <p className="intro-copy">{t('language.intro')}</p>
      </header>
      <fieldset className="language-fieldset">
        <legend>{t('language.legend')}</legend>
        <div className="language-options">
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = activeLanguage === option.value;
            return (
              <button
                key={option.value}
                className={`language-option${selected ? ' selected' : ''}`}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  void i18n.changeLanguage(option.value);
                }}
              >
                <span className="language-icon">
                  <TranslateIcon />
                </span>
                <span>
                  <strong>{t(option.nameKey)}</strong>
                  <small>{t(option.hintKey)}</small>
                </span>
                {selected && <ChoiceCheckIcon className="choice-check" />}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="welcome-action">
        <button className="button primary large" type="button" onClick={onContinue}>
          {t('language.start')}
          <ArrowRightIcon />
        </button>
      </div>
    </div>
  );
}
