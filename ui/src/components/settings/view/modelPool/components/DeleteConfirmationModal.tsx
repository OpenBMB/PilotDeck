import { useTranslation } from "react-i18next";
import { PendingIcon, XIcon } from "./icons";

export type ModelUsageReference = {
  path: string;
  value: string;
  kind: string;
};

type UsageItem = {
  modelName?: string;
  reference: ModelUsageReference;
};

type DeleteConfirmationModalProps = {
  kind: "model" | "provider";
  name: string;
  usages: UsageItem[];
  loading: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function routeName(value: string): string {
  if (value === "default") return "默认路由";
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function usageLabel(path: string): string {
  if (path === "agent.model") return "智能体 - 主智能体模型";
  if (path === "agent.subagents.default") return "智能体 - 子智能体模型";
  if (path === "memory.model") return "记忆 - 记忆模型";

  const scenario = /^router\.scenarios\.([^.]+)$/.exec(path);
  if (scenario) return `路由 - ${routeName(scenario[1])} - 首选模型`;

  const fallback = /^router\.fallback\.([^.]+)\.\d+$/.exec(path);
  if (fallback) return `路由 - ${routeName(fallback[1])} - 备选模型`;

  if (path === "router.tokenSaver.judge") return "路由 - Token 节省器 - 判断模型";
  const tier = /^router\.tokenSaver\.tiers\.([^.]+)\.model$/.exec(path);
  if (tier) return `路由 - Token 节省器 - ${routeName(tier[1])}`;
  if (path === "router.stats.baselineModel") return "路由 - 统计 - 基准模型";
  if (path.startsWith("router.stats.modelPricing.")) return "路由 - 统计 - 模型定价";
  return path;
}

export default function DeleteConfirmationModal({
  kind,
  name,
  usages,
  loading,
  error,
  onCancel,
  onConfirm,
}: DeleteConfirmationModalProps) {
  const { t } = useTranslation("settings");
  const inUse = usages.length > 0;
  const blocked = loading || Boolean(error) || inUse;
  const title = inUse
    ? kind === "model"
      ? t("pilotDeckConfig.panels.models.deleteDialog.modelBlockedTitle", { name })
      : t("pilotDeckConfig.panels.models.deleteDialog.providerTitle", { name })
    : kind === "model"
      ? t("pilotDeckConfig.panels.models.deleteDialog.modelTitle", { name })
      : t("pilotDeckConfig.panels.models.deleteDialog.providerTitle", { name });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section
        className={`modal ${kind}-delete-modal`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
      >
        <header className="modal-header">
          <h2 id="delete-modal-title">{title}</h2>
          <button className="icon-button" type="button" aria-label={t("pilotDeckConfig.panels.models.close")} onClick={onCancel}>
            <XIcon size={18} />
          </button>
        </header>

        <div className="modal-body">
          {loading ? (
            <p className="delete-dialog-status">{t("pilotDeckConfig.panels.models.deleteDialog.checking")}</p>
          ) : error ? (
            <div className="model-usage-intro">
              <PendingIcon size={22} />
              <p>{error}</p>
            </div>
          ) : inUse ? (
            <div className={`model-usage-warning${kind === "provider" ? " provider-usage-warning" : ""}`}>
              <div className="model-usage-intro">
                <PendingIcon size={22} />
                <p>
                  {t(`pilotDeckConfig.panels.models.deleteDialog.${kind}InUse`)}
                </p>
              </div>
              <ul
                className={`model-usage-list${kind === "provider" ? " provider-usage-list" : ""}`}
                aria-label={t("pilotDeckConfig.panels.models.deleteDialog.usageAria")}
              >
                {usages.map(({ modelName, reference }, index) => (
                  <li key={`${reference.path}:${reference.value}:${index}`}>
                    {modelName ? <span className="provider-usage-model">{modelName}</span> : null}
                    <strong>{usageLabel(reference.path)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="delete-confirm-copy">
              {t(`pilotDeckConfig.panels.models.deleteDialog.${kind}Confirm`, { name })}
            </p>
          )}
        </div>

        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onCancel}>
            {t("settingsPage.actions.cancel")}
          </button>
          <button className="button danger" type="button" disabled={blocked} onClick={onConfirm}>
            {t("pilotDeckConfig.panels.models.deleteDialog.delete")}
          </button>
        </footer>
      </section>
    </div>
  );
}
