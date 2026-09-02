import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, WarningCircleFillIcon } from './icons';

type ImageCapabilityModalProps = {
  modelIds: string[];
  onCancel: () => void;
  onConfirm: (values: Record<string, boolean>) => void;
};

export default function ImageCapabilityModal({ modelIds, onCancel, onConfirm }: ImageCapabilityModalProps) {
  const { t } = useTranslation('onboarding');
  const [values, setValues] = useState<Record<string, boolean | undefined>>({});

  useEffect(() => {
    setValues({});
  }, [modelIds]);

  const complete = modelIds.length > 0 && modelIds.every((id) => typeof values[id] === 'boolean');

  return (
    <div className="image-capability-overlay" role="presentation" onClick={onCancel}>
      <div
        className="image-capability-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-capability-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="image-capability-header">
          <span className="image-capability-icon" aria-hidden="true">
            <WarningCircleFillIcon width={16} height={16} />
          </span>
          <h2 id="image-capability-title">{t('connection.manualTitle')}</h2>
          <button type="button" className="image-capability-close" aria-label={t('connection.manualCancel')} onClick={onCancel}>
            <CloseIcon width={14} height={14} />
          </button>
        </header>
        <div className="image-capability-list">
          {modelIds.map((modelId) => (
            <div className="image-capability-row" key={modelId}>
              <span className="image-capability-model">{modelId}</span>
              <label className="image-capability-choice">
                <input
                  type="radio"
                  name={`image-support-${modelId}`}
                  checked={values[modelId] === true}
                  onChange={() => setValues((current) => ({ ...current, [modelId]: true }))}
                />
                {t('connection.manualSupported')}
              </label>
              <label className="image-capability-choice">
                <input
                  type="radio"
                  name={`image-support-${modelId}`}
                  checked={values[modelId] === false}
                  onChange={() => setValues((current) => ({ ...current, [modelId]: false }))}
                />
                {t('connection.manualUnsupported')}
              </label>
            </div>
          ))}
        </div>
        <footer className="image-capability-actions">
          <button type="button" className="image-capability-cancel" onClick={onCancel}>
            {t('connection.manualCancel')}
          </button>
          <button
            type="button"
            className="image-capability-confirm"
            disabled={!complete}
            onClick={() => {
              if (!complete) return;
              const next: Record<string, boolean> = {};
              for (const modelId of modelIds) {
                next[modelId] = Boolean(values[modelId]);
              }
              onConfirm(next);
            }}
          >
            {t('connection.manualConfirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}
