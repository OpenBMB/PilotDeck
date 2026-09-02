import { useTranslation } from "react-i18next";
import {
  CATALOG_PROVIDERS,
  type CatalogProvider,
} from "../../../../../shared/catalogProviders";
import ProviderAvatar from "./ProviderAvatar";
import { XIcon } from "./icons";

type CatalogPickerProps = {
  open: boolean;
  existingIds: Set<string>;
  onPick: (catalog: CatalogProvider) => void;
  onCustom: () => void;
  onClose: () => void;
};

export default function CatalogPicker({
  open,
  existingIds,
  onPick,
  onCustom,
  onClose,
}: CatalogPickerProps) {
  const { t } = useTranslation("settings");
  if (!open) return null;

  const available = CATALOG_PROVIDERS.filter((p) => !existingIds.has(p.id));

  return (
    <div
      className="modal-backdrop provider-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="provider-picker" role="dialog" aria-modal="true" aria-labelledby="provider-picker-title">
        <header className="provider-picker-header">
          <div>
            <h2 id="provider-picker-title">{t("pilotDeckConfig.panels.models.addProviderTitle")}</h2>
            <p>{t("pilotDeckConfig.panels.models.providerPickerDescription")}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("pilotDeckConfig.panels.models.close")}
            onClick={onClose}
          >
            <XIcon size={20} />
          </button>
        </header>
        <div className="provider-picker-grid">
          <button
            type="button"
            className="provider-option selected"
            aria-pressed="true"
            onClick={() => {
              onCustom();
              onClose();
            }}
          >
            <ProviderAvatar
              providerId="__custom__"
              size={22}
              className="provider-option-icon"
            />
            <span className="provider-option-copy">
              <strong>{t("pilotDeckConfig.panels.models.customProvider")}</strong>
              <small>{t("pilotDeckConfig.panels.models.manualSetup")}</small>
            </span>
            <span className="provider-option-radio" aria-hidden="true" />
          </button>
          {available.map((p) => (
            <button
              key={p.id}
              type="button"
              className="provider-option"
              onClick={() => {
                onPick(p);
                onClose();
              }}
            >
              <ProviderAvatar
                providerId={p.id}
                catalogEntry={p}
                size={22}
                className="provider-option-icon"
              />
              <span className="provider-option-copy">
                <strong>{p.displayName}</strong>
              </span>
              <span className="provider-option-radio" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
