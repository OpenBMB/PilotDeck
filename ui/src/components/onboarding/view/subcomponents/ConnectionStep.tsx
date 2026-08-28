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
  MagnifyingGlassIcon,
  WarningIcon,
} from './icons';

type ConnectionStepProps = {
  llm: LlmSetupController;
  onBack: () => void;
  onContinue: () => void | Promise<void>;
};

type ModelChipProps = {
  modelId: string;
  variant: 'selected' | 'available';
  title: string;
  removeLabel: string;
  onRemove: () => void;
  onSelect?: () => void;
  selectDisabled?: boolean;
};

function ModelChip({
  modelId,
  variant,
  title,
  removeLabel,
  onRemove,
  onSelect,
  selectDisabled,
}: ModelChipProps) {
  return (
    <span className={`model-chip ${variant}`} title={title}>
      {variant === 'available' ? (
        <button
          className="model-chip-label"
          type="button"
          onClick={onSelect}
          disabled={selectDisabled}
        >
          {modelId}
        </button>
      ) : (
        <span className="model-chip-label">{modelId}</span>
      )}
      <button
        className="model-chip-remove"
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemove();
        }}
      >
        <CloseIcon width={8} height={8} />
      </button>
    </span>
  );
}

export default function ConnectionStep({ llm, onBack, onContinue }: ConnectionStepProps) {
  const { t } = useTranslation('onboarding');
  const [showApiKey, setShowApiKey] = useState(false);
  const [extraAvailableIds, setExtraAvailableIds] = useState<string[]>([]);
  const [hiddenAvailableIds, setHiddenAvailableIds] = useState<string[]>([]);
  const [draftAvailableId, setDraftAvailableId] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState('');

  const providerName = llm.isCustomMode
    ? t('provider.customTitle')
    : (llm.selectedProvider?.displayName ?? '');
  const providerLogo = llm.selectedProvider && llm.selectedProvider.id !== CUSTOM_PROVIDER_ID
    ? PROVIDER_LOGOS[llm.selectedProvider.id]
    : undefined;

  useEffect(() => {
    setExtraAvailableIds([]);
    setHiddenAvailableIds([]);
    setDraftAvailableId(null);
    setModelQuery('');
  }, [llm.effectiveProviderId, llm.effectiveProtocol, llm.effectiveUrl]);

  const handleFieldChange = (updater: () => void) => {
    updater();
    llm.resetTest();
  };

  const selectedIds = llm.effectiveModelIds;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hiddenIdSet = useMemo(() => new Set(hiddenAvailableIds), [hiddenAvailableIds]);
  const availableIds = useMemo(() => {
    const fromProvider = llm.selectedModels.map((model) => model.id);
    return uniqueModelIds([...fromProvider, ...extraAvailableIds]).filter(
      (id) => !selectedIdSet.has(id) && !hiddenIdSet.has(id),
    );
  }, [extraAvailableIds, hiddenIdSet, llm.selectedModels, selectedIdSet]);
  const filteredAvailableIds = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return availableIds;
    return availableIds.filter((id) => id.toLowerCase().includes(query));
  }, [availableIds, modelQuery]);

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
    setHiddenAvailableIds((current) => current.filter((id) => id !== modelId));
    llm.deselectModelId(modelId);
  };

  const hideAvailableModel = (modelId: string) => {
    setExtraAvailableIds((current) => current.filter((id) => id !== modelId));
    setHiddenAvailableIds((current) => (current.includes(modelId) ? current : [...current, modelId]));
  };

  const commitDraftAvailableId = () => {
    const nextId = draftAvailableId?.trim() ?? '';
    setDraftAvailableId(null);
    if (!nextId || selectedIdSet.has(nextId)) return;
    setHiddenAvailableIds((current) => current.filter((id) => id !== nextId));
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
                      <ModelChip
                        key={`selected-${modelId}`}
                        modelId={modelId}
                        variant="selected"
                        title={modelTitle(modelId)}
                        removeLabel={t('connection.removeModelId')}
                        onRemove={() => deselectSelectedModel(modelId)}
                      />
                    ))
                  )}
                </div>
              </div>
              <div className="model-id-section available">
                <span className="model-id-section-label">{t('connection.availableModels')}</span>
                <div className="model-id-available-body">
                  <label className="model-id-search" htmlFor="available-model-search">
                    <MagnifyingGlassIcon width={15} height={15} />
                    <input
                      id="available-model-search"
                      type="text"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder={t('connection.searchModelId')}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="model-id-chips">
                    <button
                      className="add-model-button"
                      type="button"
                      onClick={addModelId}
                    >
                      <PlusIcon />
                      {t('connection.addModelId')}
                    </button>
                    {draftAvailableId != null && (
                      <input
                        className="model-chip-input"
                        type="text"
                        value={draftAvailableId}
                        placeholder={t('connection.modelIdPlaceholder')}
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
                    {filteredAvailableIds.map((modelId) => (
                      <ModelChip
                        key={`available-${modelId}`}
                        modelId={modelId}
                        variant="available"
                        title={modelTitle(modelId)}
                        removeLabel={`${t('connection.hideAvailableModelId')} ${modelId}`}
                        onRemove={() => hideAvailableModel(modelId)}
                        onSelect={() => selectAvailableModel(modelId)}
                        selectDisabled={selectedIds.length >= MAX_ONBOARDING_MODELS}
                      />
                    ))}
                  </div>
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
