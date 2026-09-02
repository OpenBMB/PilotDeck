import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogProviderProtocol } from '../../../../shared/catalogProviders';
import { CUSTOM_PROVIDER_ID, MAX_ONBOARDING_MODELS, PROVIDER_LOGOS } from '../constants';
import { uniqueModelIds } from '../llmSetupUtils';
import type { LlmSetupController } from '../types';
import FooterActions from './FooterActions';
import ImageCapabilityModal from './ImageCapabilityModal';
import {
  CloseIcon,
  EyeIcon,
  EyeSlashIcon,
  GearIcon,
  KeyIcon,
  LockSimpleIcon,
  CheckCircleFillIcon,
  PlugIcon,
  WarningCircleFillIcon,
  PlusIcon,
  WarningIcon,
} from './icons';

type ConnectionStepProps = {
  llm: LlmSetupController;
  onBack: () => void;
  onContinue: () => void | Promise<void>;
};

function modelIdInputWidth(value: string) {
  return `${Math.max(18, value.length + 2)}ch`;
}

export default function ConnectionStep({ llm, onBack, onContinue }: ConnectionStepProps) {
  const { t } = useTranslation('onboarding');
  const [showApiKey, setShowApiKey] = useState(false);
  const [extraAvailableIds, setExtraAvailableIds] = useState<string[]>([]);
  const [draftAvailableId, setDraftAvailableId] = useState<string | null>(null);

  const providerName = llm.isCustomMode
    ? t('provider.customTitle')
    : (llm.selectedProvider?.displayName ?? '');
  const providerLogo = llm.selectedProvider && llm.selectedProvider.id !== CUSTOM_PROVIDER_ID
    ? PROVIDER_LOGOS[llm.selectedProvider.id]
    : undefined;

  useEffect(() => {
    setExtraAvailableIds([]);
    setDraftAvailableId(null);
  }, [llm.effectiveProviderId, llm.effectiveProtocol, llm.effectiveUrl]);

  const handleFieldChange = (updater: () => void) => {
    updater();
    llm.resetTest();
  };

  const selectedIds = llm.effectiveModelIds;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const availableIds = useMemo(() => {
    const fromProvider = llm.selectedModels.map((model) => model.id);
    return uniqueModelIds([...fromProvider, ...extraAvailableIds]).filter((id) => !selectedIdSet.has(id));
  }, [extraAvailableIds, llm.selectedModels, selectedIdSet]);

  const modelTitle = (modelId: string) => (
    llm.selectedModels.find((model) => model.id === modelId)?.displayName || modelId
  );

  const selectAvailableModel = (modelId: string) => {
    llm.selectModelId(modelId);
  };

  const deselectSelectedModel = (modelId: string) => {
    const inProviderList = llm.selectedModels.some((model) => model.id === modelId);
    if (!inProviderList) {
      setExtraAvailableIds((current) => (current.includes(modelId) ? current : [...current, modelId]));
    }
    llm.deselectModelId(modelId);
  };

  const commitDraftAvailableId = () => {
    const nextId = draftAvailableId?.trim() ?? '';
    setDraftAvailableId(null);
    if (!nextId || selectedIdSet.has(nextId)) return;
    if (selectedIds.length >= MAX_ONBOARDING_MODELS) {
      setExtraAvailableIds((current) => (current.includes(nextId) ? current : [...current, nextId]));
      return;
    }
    llm.selectModelId(nextId);
  };

  const addModelId = () => {
    if (draftAvailableId != null) {
      commitDraftAvailableId();
      return;
    }
    setDraftAvailableId('');
  };

  return (
    <div className="content-page connection-page">
      <header className="page-intro">
        <h1>{t('connection.title')}</h1>
        <p className="intro-copy">{t('connection.intro')}</p>
      </header>

      <div className="connection-layout">
        <form className="connection-form" onSubmit={(event) => event.preventDefault()}>
          {llm.isCustomMode ? (
            <>
              <div className="field-row">
                <label className="field-group">
                  <span>{t('connection.provider')}</span>
                  <span className="select-control">
                    <GearIcon width={18} height={18} />
                    {providerName}
                  </span>
                </label>
                <label className="field-group compact-field" htmlFor="custom-protocol">
                  <span>{t('connection.protocol')}</span>
                  <select
                    id="custom-protocol"
                    className="select-control protocol-select"
                    value={llm.customProtocol}
                    onChange={(event) => handleFieldChange(() => llm.setCustomProtocol(event.target.value as CatalogProviderProtocol))}
                  >
                    <option value="openai">{t('connection.protocolOpenai')}</option>
                    <option value="openai-responses">{t('connection.protocolOpenaiResponses')}</option>
                    <option value="anthropic">{t('connection.protocolAnthropic')}</option>
                    <option value="google">{t('connection.protocolGoogle')}</option>
                  </select>
                </label>
              </div>
              <label className="field-group" htmlFor="custom-endpoint">
                <span>{t('connection.endpoint')}</span>
                <input
                  id="custom-endpoint"
                  type="text"
                  value={llm.customUrl}
                  onChange={(event) => handleFieldChange(() => llm.setCustomUrl(event.target.value))}
                  placeholder="https://your-endpoint.example/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <div className="field-row single-field">
              <div className="field-group">
                <span>{t('connection.provider')}</span>
                <span className="select-control">
                  {providerLogo ? (
                    <img src={providerLogo} alt="" width={18} height={18} />
                  ) : (
                    <GearIcon width={18} height={18} />
                  )}
                  {providerName}
                </span>
              </div>
            </div>
          )}

          <label className="field-group" htmlFor="llm-api-key">
            <span>{llm.selectedProviderRequiresApiKey ? t('connection.apiKey') : t('connection.apiKeyOptional')}</span>
            <span className="input-with-action">
              <KeyIcon />
              <input
                id="llm-api-key"
                type={showApiKey ? 'text' : 'password'}
                value={llm.apiKey}
                onChange={(event) => handleFieldChange(() => llm.setApiKey(event.target.value))}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                aria-label={showApiKey ? t('connection.hideKey') : t('connection.showKey')}
                onClick={() => setShowApiKey((current) => !current)}
              >
                {showApiKey ? <EyeSlashIcon /> : <EyeIcon />}
              </button>
            </span>
            <small className="field-help">
              <LockSimpleIcon />
              {t('connection.apiKeyHelp')}
            </small>
          </label>

          <fieldset className="field-group model-id-fieldset">
            <legend>{t('connection.modelId')}</legend>
            <div className="model-id-picker">
              <div className="model-id-section">
                <span className="model-id-section-label">{t('connection.selectedModels')}</span>
                <div className="model-id-chips">
                  {selectedIds.length === 0 ? (
                    <span className="model-id-empty">{t('connection.noSelectedModels')}</span>
                  ) : (
                    selectedIds.map((modelId) => (
                      <span className="model-chip selected" key={`selected-${modelId}`} title={modelTitle(modelId)}>
                        {modelId}
                        <button
                          type="button"
                          aria-label={t('connection.removeModelId')}
                          title={t('connection.removeModelId')}
                          onClick={() => deselectSelectedModel(modelId)}
                        >
                          <CloseIcon width={10} height={10} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="model-id-section available">
                <span className="model-id-section-label">{t('connection.availableModels')}</span>
                <div className="model-id-chips">
                  {availableIds.map((modelId) => (
                    <button
                      className="model-chip available"
                      type="button"
                      key={`available-${modelId}`}
                      title={modelTitle(modelId)}
                      onClick={() => selectAvailableModel(modelId)}
                      disabled={selectedIds.length >= MAX_ONBOARDING_MODELS}
                    >
                      {modelId}
                    </button>
                  ))}
                  {draftAvailableId != null && (
                    <input
                      className="model-chip-input"
                      type="text"
                      value={draftAvailableId}
                      placeholder={t('connection.modelIdPlaceholder')}
                      style={{ width: modelIdInputWidth(draftAvailableId) }}
                      onChange={(event) => setDraftAvailableId(event.target.value)}
                      onBlur={commitDraftAvailableId}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitDraftAvailableId();
                        }
                        if (event.key === 'Escape') {
                          setDraftAvailableId(null);
                        }
                      }}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={t('connection.modelId')}
                    />
                  )}
                  <button
                    className="add-model-button"
                    type="button"
                    onClick={addModelId}
                  >
                    <PlusIcon />
                    {t('connection.addModelId')}
                  </button>
                </div>
              </div>
            </div>
            {llm.modelListStatus === 'loading' && (
              <p className="field-help">
                <span className="spin" aria-hidden="true" />
                {t('connection.fetchingModels')}
              </p>
            )}
          </fieldset>
        </form>

        <button
          className={`connection-test-button ${llm.testStatus === 'manual' ? 'idle' : llm.testStatus}`}
          type="button"
          onClick={() => {
            void llm.handleTest();
          }}
          disabled={llm.testStatus === 'testing'}
        >
          {llm.testStatus === 'testing' ? (
            <>
              <span className="spin" aria-hidden="true" />
              <span>{t('connection.testing')}</span>
            </>
          ) : llm.testStatus === 'success' ? (
            <>
              <CheckCircleFillIcon />
              <span>{t('connection.testPassed')}</span>
            </>
          ) : llm.testStatus === 'error' ? (
            <>
              <WarningCircleFillIcon />
              <span>{t('connection.testFailedRetest')}</span>
            </>
          ) : (
            <>
              <PlugIcon />
              <span>{t('connection.test')}</span>
            </>
          )}
        </button>
        {llm.testStatus !== 'success' && llm.testStatus !== 'error' && llm.testStatus !== 'manual' && (
          <p className="connection-test-hint">
            {llm.unknownImageProbeCount > 0
              ? t('connection.testHint', { count: llm.unknownImageProbeCount })
              : t('connection.testHintKnown')}
          </p>
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
        nextDisabled={!llm.canContinue}
        nextBusy={llm.saving}
        onBack={onBack}
        onNext={() => {
          void onContinue();
        }}
      />
      {llm.testStatus === 'manual' && llm.manualModelIds.length > 0 && (
        <ImageCapabilityModal
          modelIds={llm.manualModelIds}
          onCancel={llm.cancelManualImageSupport}
          onConfirm={llm.submitManualImageSupport}
        />
      )}
    </div>
  );
}
