import { useTranslation } from 'react-i18next';
import type { CatalogProviderProtocol } from '../../../../shared/catalogProviders';
import type { LlmSetupController } from '../types';
import FooterActions from './FooterActions';
import { CaretIcon, WarningIcon } from './icons';

type ConnectionStepProps = {
  llm: LlmSetupController;
  onBack: () => void;
  onContinue: () => void | Promise<void>;
};

export default function ConnectionStep({ llm, onBack, onContinue }: ConnectionStepProps) {
  const { t } = useTranslation('onboarding');
  const protocolHelp =
    llm.effectiveProtocol === 'openai'
      ? t('connection.openaiUrlHint')
      : llm.effectiveProtocol === 'openai-responses'
        ? t('connection.responsesUrlHint')
        : llm.effectiveProtocol === 'google'
          ? t('connection.googleUrlHint')
          : '';

  const handleFieldChange = (updater: () => void) => {
    updater();
    llm.resetTest();
  };

  return (
    <div className="content-page connection-page">
      <header className="page-intro">
        <h1>{t('connection.title')}</h1>
        <p className="intro-copy">{t('connection.intro')}</p>
      </header>

      <div className="connection-layout">
        <div className="connection-form">
          {llm.isCustomMode && (
            <>
              <div className="field-row">
                <label className="field-group" htmlFor="custom-provider-id">
                  {t('connection.providerId')}
                  <input
                    id="custom-provider-id"
                    type="text"
                    value={llm.customProviderId}
                    onChange={(event) => handleFieldChange(() => llm.setCustomProviderId(event.target.value))}
                    placeholder="e.g. my-llm"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label className="field-group" htmlFor="custom-protocol">
                  {t('connection.protocol')}
                  <select
                    id="custom-protocol"
                    className="select-control"
                    value={llm.customProtocol}
                    onChange={(event) => handleFieldChange(() => llm.setCustomProtocol(event.target.value as CatalogProviderProtocol))}
                  >
                    <option value="openai">openai</option>
                    <option value="openai-responses">openai-responses</option>
                    <option value="anthropic">anthropic</option>
                    <option value="google">google</option>
                  </select>
                </label>
              </div>
              <label className="field-group" htmlFor="custom-base-url">
                {t('connection.baseUrl')}
                <input
                  id="custom-base-url"
                  type="text"
                  value={llm.customUrl}
                  onChange={(event) => handleFieldChange(() => llm.setCustomUrl(event.target.value))}
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {protocolHelp && <p className="field-help">{protocolHelp}</p>}
            </>
          )}

          <label className="field-group" htmlFor="llm-api-key">
            {llm.selectedProviderRequiresApiKey ? t('connection.apiKey') : t('connection.apiKeyOptional')}
            <input
              id="llm-api-key"
              type="password"
              value={llm.apiKey}
              onChange={(event) => handleFieldChange(() => llm.setApiKey(event.target.value))}
              placeholder={
                llm.selectedProviderRequiresApiKey
                  ? t('connection.apiKeyPlaceholder')
                  : t('connection.apiKeyOptionalPlaceholder')
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="field-group">
            <label htmlFor="llm-model">{t('connection.model')}</label>
            {llm.selectedModels.length > 0 ? (
              <select
                id="llm-model"
                className="select-control"
                value={llm.selectedModelId}
                onChange={(event) => handleFieldChange(() => {
                  llm.setSelectedModelId(event.target.value);
                  llm.setCustomModelId('');
                })}
              >
                {llm.selectedModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} ({model.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="llm-model"
                type="text"
                value={llm.customModelId}
                onChange={(event) => handleFieldChange(() => llm.setCustomModelId(event.target.value))}
                placeholder={t('connection.modelPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {llm.modelListStatus === 'loading' && (
              <p className="field-help">
                <span className="spin" aria-hidden="true" />
                {t('connection.fetchingModels')}
              </p>
            )}
            {llm.selectedProvider && (
              <p className="field-help">
                <button
                  type="button"
                  onClick={() => {
                    void llm.handleFetchModels();
                  }}
                  disabled={!llm.canFetchModels || llm.modelListStatus === 'loading'}
                >
                  {t('connection.fetchModels')}
                </button>
              </p>
            )}
            {llm.modelListMessage && (
              <p className="field-help">{llm.modelListMessage}</p>
            )}
            {llm.selectedModels.length > 0 && (
              <input
                type="text"
                value={llm.customModelId}
                onChange={(event) => handleFieldChange(() => llm.setCustomModelId(event.target.value))}
                placeholder={t('connection.customModelPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </div>

          {!llm.isCustomMode && (
            <div className={`advanced-settings${llm.showAdvanced ? ' open' : ''}`}>
              <button
                className="advanced-settings-toggle"
                type="button"
                onClick={() => llm.setShowAdvanced((current) => !current)}
              >
                {llm.showAdvanced ? t('connection.hideAdvanced') : t('connection.advanced')}
                <CaretIcon className="advanced-settings-caret" />
              </button>
              {llm.showAdvanced && (
                <div className="advanced-settings-panel">
                  <div className="advanced-setting-row">
                    <div className="advanced-setting-copy">
                      <strong>{t('connection.baseUrl')}</strong>
                      <small>{protocolHelp}</small>
                    </div>
                    <input
                      id="llm-url"
                      type="text"
                      value={llm.customUrl}
                      onChange={(event) => handleFieldChange(() => llm.setCustomUrl(event.target.value))}
                      placeholder={llm.selectedDefaultUrl}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <button
          className={`connection-test-button ${llm.testStatus}`}
          type="button"
          onClick={() => {
            void llm.handleTest();
          }}
          disabled={!llm.canTest || llm.testStatus === 'testing'}
        >
          {llm.testStatus === 'testing' ? (
            <>
              <span className="spin" aria-hidden="true" />
              {t('connection.testing')}
            </>
          ) : (
            t('connection.test')
          )}
        </button>
        {llm.testStatus !== 'success' && llm.testStatus !== 'error' && (
          <p className="connection-test-hint">{t('connection.testHint')}</p>
        )}
        {llm.testStatus === 'error' && llm.testMessage && (
          <div className="connection-failure-reason">
            <WarningIcon />
            <div>
              <strong>{t('connection.testFailed')}</strong>
              <span>{llm.testMessage}</span>
            </div>
          </div>
        )}
        {llm.testStatus === 'success' && llm.testMessage && (
          <p className="connection-test-hint">{llm.testMessage || t('connection.testSuccess')}</p>
        )}
      </div>

      <FooterActions
        backLabel={t('actions.back')}
        nextLabel={t('actions.next')}
        nextDisabled={llm.testStatus !== 'success'}
        nextBusy={llm.saving}
        onBack={onBack}
        onNext={() => {
          void onContinue();
        }}
      />
    </div>
  );
}
