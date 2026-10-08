import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from '../../../../ui/ConfirmDialog';
import {
  applyModelRemoval,
  previewModelRemoval,
  type ModelRemovalAction,
  type ModelRemovalChange,
  type ModelRemovalConfigResponse,
  type ModelRemovalPlan,
  type ModelRemovalTarget,
} from "../utils/modelRemoval";
import { PendingIcon } from "./icons";
import { usageLabel } from "../utils/modelUsage";
import { getModelReferenceTab } from "../../../navigation";

type DeleteConfirmationModalProps = {
  kind: "model" | "provider";
  name: string;
  /**
   * Saved provider/model to remove on the server. `null` means the item only
   * exists in the local draft, so no configuration references it yet.
   */
  target: ModelRemovalTarget | null;
  /** Current main model; preselected as the replacement when it survives. */
  preferredReplacement?: string;
  /** Models the client considers usable (configured providers). */
  allowedReplacements?: string[];
  /** Remove the item from the local draft only. */
  onLocalConfirm: () => void;
  /** Called after the server removed the item and repaired every reference. */
  onRemoved: (response: ModelRemovalConfigResponse) => void | Promise<void>;
  onCancel: () => void;
  /** Open the settings page that owns a reference (settings tab slug). */
  onNavigate?: (tab: string) => void;
};

const GROUP_ORDER: ModelRemovalAction[] = ["replace", "inherit", "clear", "remove"];

/** Settings page (tab slug) where a referencing setting can be edited. */
export function settingsTabForPath(path: string): string | null {
  return getModelReferenceTab(path);
}

function usableOptions(plan: ModelRemovalPlan | null, allowed?: string[]): string[] {
  const options = plan?.replacementOptions ?? [];
  if (!allowed) return options;
  const configured = options.filter(option => allowed.includes(option));
  return configured.length ? configured : options;
}

export default function DeleteConfirmationModal({
  kind,
  name,
  target,
  preferredReplacement = "",
  allowedReplacements,
  onLocalConfirm,
  onRemoved,
  onCancel,
  onNavigate,
}: DeleteConfirmationModalProps) {
  const { t } = useTranslation("settings");
  const key = (suffix: string) => `pilotDeckConfig.panels.models.deleteDialog.${suffix}`;
  const [plan, setPlan] = useState<ModelRemovalPlan | null>(null);
  const [loading, setLoading] = useState(Boolean(target));
  const [loadError, setLoadError] = useState("");
  const [applyError, setApplyError] = useState("");
  const [notice, setNotice] = useState("");
  const [replacement, setReplacement] = useState("");
  const [applying, setApplying] = useState(false);
  const sequence = useRef(0);

  const load = async (choice: string, autoPick: boolean): Promise<void> => {
    if (!target) return;
    const id = ++sequence.current;
    setLoading(true);
    setLoadError("");
    const result = await previewModelRemoval(target, choice);
    if (id !== sequence.current) return;
    if (!result.ok) {
      setLoading(false);
      setPlan(null);
      setLoadError(result.message || t(key("checkFailed")));
      return;
    }
    const next = result.data;
    if (autoPick && !choice && next.blocked?.code === "REPLACEMENT_REQUIRED") {
      // Keep the main model when it survives (smart routing mirrors it into the
      // default route anyway), otherwise suggest the first usable model.
      const options = usableOptions(next, allowedReplacements);
      const initial = options.includes(preferredReplacement) ? preferredReplacement : options[0];
      if (initial) {
        setReplacement(initial);
        void load(initial, false);
        return;
      }
    }
    setLoading(false);
    setPlan(next);
  };

  useEffect(() => {
    void load("", true);
    return () => { sequence.current += 1; };
    // Only preview once per dialog; replacement changes call load directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changes = plan?.changes ?? [];
  const options = usableOptions(plan, allowedReplacements);
  const blocked = plan?.blocked ?? null;
  const showReplacement = Boolean(plan?.requiresReplacement && plan.replacementOptions.length > 0);
  const removesLocally = !target || (kind === "model" && plan !== null && !blocked && changes.length === 0);
  const confirmDisabled = applying || (target !== null && (loading || !plan || Boolean(blocked)));

  const chooseReplacement = (value: string) => {
    setReplacement(value);
    setApplyError("");
    setNotice("");
    void load(value, false);
  };

  const confirm = async () => {
    if (confirmDisabled) return;
    if (removesLocally || !target || !plan) {
      onLocalConfirm();
      return;
    }
    setApplying(true);
    setApplyError("");
    setNotice("");
    const result = await applyModelRemoval(target, plan.replacement, plan.revision);
    if (!result.ok) {
      setApplying(false);
      if (result.code === "CONFIG_CONFLICT") {
        setNotice(t(key("conflict")));
        void load(replacement, !replacement);
        return;
      }
      setApplyError(result.message || t(key("removeFailed")));
      return;
    }
    try {
      await onRemoved(result.data);
    } finally {
      setApplying(false);
    }
  };

  const title = t(key(kind === "model" ? "modelTitle" : "providerTitle"), { name });
  const confirmLabel = t(key(changes.some(change => change.action === "replace") ? "replaceAndDelete" : "delete"));

  const groupHeading = (action: ModelRemovalAction) => {
    if (action === "replace") return plan?.replacement ? t(key("groupReplace"), { model: plan.replacement }) : t(key("groupReplacePending"));
    if (action === "inherit") return t(key("groupInherit"));
    if (action === "clear") return t(key("groupClear"));
    return t(key("groupRemove"));
  };

  const renderChange = (change: ModelRemovalChange) => {
    const tab = settingsTabForPath(change.path);
    const showValue = kind === "provider" || change.reason === "redundant" || change.path.startsWith("router.stats.modelPricing.");
    return (
      <li key={`${change.path}:${change.reason ?? ""}`} data-reference-path={change.path} className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <strong className="font-medium text-foreground">{usageLabel(change.path, t)}</strong>
          {showValue && <span className="ml-2 break-all font-mono text-xs">{change.value}</span>}
          {change.reason === "redundant" && <span className="ml-2 text-xs">{t(key("redundant"))}</span>}
        </span>
        {tab && onNavigate && (
          <button type="button" className="shrink-0 text-xs text-primary hover:underline disabled:opacity-50"
            disabled={applying} onClick={() => onNavigate(tab)}>
            {t(key("openSettings"))}
          </button>
        )}
      </li>
    );
  };

  let body;
  if (target && loading && !plan) {
    body = <p className="text-sm">{t(key("checking"))}</p>;
  } else if (target && loadError) {
    body = (
      <div className="flex items-start gap-2">
        <PendingIcon size={22} />
        <p>{loadError}</p>
      </div>
    );
  } else if (!target || changes.length === 0) {
    body = blocked
      ? <p role="alert">{blocked.message}</p>
      : <p className="text-sm">{t(key(`${kind}Confirm`), { name })}</p>;
  } else {
    body = (
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <PendingIcon size={22} />
          <p>{t(key("inUse"), { name })}</p>
        </div>
        {blocked?.code === "ROUTER_REQUIRES_MODEL" && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">
            {t(key("routerRequiresModel"))}
          </p>
        )}
        {blocked && blocked.code !== "ROUTER_REQUIRES_MODEL" && blocked.code !== "REPLACEMENT_REQUIRED" && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-destructive">{blocked.message}</p>
        )}
        {showReplacement && (
          <label className="flex flex-col gap-2">
            <span>{t(key("replacementLabel"))}</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-foreground"
              value={replacement}
              disabled={applying}
              onChange={event => chooseReplacement(event.target.value)}
            >
              {!replacement && <option value="">{t(key("chooseReplacement"))}</option>}
              {options.map(ref => <option key={ref} value={ref}>{ref}</option>)}
            </select>
          </label>
        )}
        <div className="space-y-3" aria-label={t(key("usageAria"))} aria-busy={loading}>
          {GROUP_ORDER.map(action => {
            const items = changes.filter(change => change.action === action);
            if (!items.length) return null;
            return (
              <section key={action}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide">{groupHeading(action)}</h3>
                <ul className="space-y-1">{items.map(renderChange)}</ul>
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <ConfirmDialog
      title={title}
      destructive
      busy={applying}
      disabled={confirmDisabled}
      error={applyError || null}
      confirmLabel={confirmLabel}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      {body}
      {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}
    </ConfirmDialog>
  );
}
