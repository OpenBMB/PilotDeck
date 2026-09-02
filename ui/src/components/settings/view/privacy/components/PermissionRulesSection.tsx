import { Check, CircleAlert, CircleCheck, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isImeEnterEvent } from "../../../../../utils/ime";

type PermissionRulesSectionProps = {
  mode: "allowed" | "approval";
  tools: string[];
  newValue: string;
  onNewValueChange: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  quickTools: string[];
};

export default function PermissionRulesSection({
  mode,
  tools,
  newValue,
  onNewValueChange,
  onAdd,
  onRemove,
  quickTools,
}: PermissionRulesSectionProps) {
  const { t } = useTranslation("settings");
  const isAllowed = mode === "allowed";
  const sectionKey = isAllowed ? "allowedTools" : "approvalTools";
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const availableQuickTools = quickTools.filter((tool) => !tools.includes(tool));

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const closeForm = () => {
    setAdding(false);
    onNewValueChange("");
  };

  const submit = () => {
    if (!newValue.trim()) return;
    onAdd(newValue);
    setAdding(false);
  };

  return (
    <section
      className={`security-permission-column ${isAllowed ? "allowed" : "approval"}`}
      aria-labelledby={`security-${sectionKey}-title`}
    >
      <header className="security-permission-heading">
        <span className="security-permission-icon" aria-hidden="true">
          {isAllowed ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
        </span>
        <h3 id={`security-${sectionKey}-title`}>
          {t(`permissions.${sectionKey}.title`)}
        </h3>
        <span className="security-permission-count">{tools.length}</span>
      </header>

      <div
        className="security-tool-flow"
        role="list"
        aria-label={t(`permissions.${sectionKey}.title`)}
      >
        {tools.length === 0 && !adding ? (
          <span className="security-tool-empty">{t(`permissions.${sectionKey}.empty`)}</span>
        ) : null}
        {tools.map((tool) => (
          <span className="security-tool-tag" role="listitem" key={tool}>
            <code title={tool}>{tool}</code>
            <button
              type="button"
              onClick={() => onRemove(tool)}
              aria-label={t("permissions.actions.removeTool", { tool })}
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {adding ? (
          <div className="security-add-form">
            <input
              ref={inputRef}
              value={newValue}
              onChange={(event) => onNewValueChange(event.target.value)}
              placeholder={t(`permissions.${sectionKey}.placeholder`)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (isImeEnterEvent(event)) return;
                  event.preventDefault();
                  submit();
                } else if (event.key === "Escape") {
                  closeForm();
                }
              }}
            />
            <button
              type="button"
              className="security-add-cancel"
              onClick={closeForm}
              aria-label={t("settingsPage.actions.cancel")}
            >
              <X size={14} />
            </button>
            <button
              type="button"
              className="security-add-confirm"
              onClick={submit}
              disabled={!newValue.trim()}
              aria-label={t("permissions.actions.add")}
            >
              <Check size={14} />
            </button>
          </div>
        ) : (
          <button
            className="security-add-button"
            type="button"
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
            {t("permissions.actions.add")}
          </button>
        )}
      </div>

      <div className="security-quick-add">
        <span>{t("permissions.quickAdd")}</span>
        <div>
          {availableQuickTools.length > 0 ? (
            availableQuickTools.map((tool) => (
              <button type="button" key={tool} onClick={() => onAdd(tool)}>
                {tool}
              </button>
            ))
          ) : (
            <small>{t("permissions.quickAddComplete")}</small>
          )}
        </div>
      </div>
    </section>
  );
}
