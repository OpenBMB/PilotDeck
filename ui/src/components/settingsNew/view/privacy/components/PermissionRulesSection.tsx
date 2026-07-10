import type { LucideIcon } from "lucide-react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "../../../../../shared/view/ui";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { SettingsCard, SettingsSection } from "../../../shared/view";

type PermissionRulesSectionProps = {
  mode: "allowed" | "blocked";
  tools: string[];
  newValue: string;
  onNewValueChange: (value: string) => void;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  quickTools: string[];
  icon: LucideIcon;
};

export default function PermissionRulesSection({
  mode,
  tools,
  newValue,
  onNewValueChange,
  onAdd,
  onRemove,
  quickTools,
  icon: Icon,
}: PermissionRulesSectionProps) {
  const { t } = useTranslation("settings");
  const isAllowed = mode === "allowed";
  const sectionKey = isAllowed ? "allowedTools" : "blockedTools";

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-center gap-2">
          <Icon
            className={
              isAllowed
                ? "h-4 w-4 text-green-600 dark:text-green-400"
                : "h-4 w-4 text-red-600 dark:text-red-400"
            }
          />
          {t(`permissions.${sectionKey}.title`, {
            defaultValue: isAllowed ? "Allowed tools" : "Blocked tools",
          })}
        </span>
      }
      description={t(`permissions.${sectionKey}.description`, {
        defaultValue: isAllowed
          ? "Tools that auto-run without prompting."
          : "Tools the assistant is never allowed to use.",
      })}
    >
      <SettingsCard className="space-y-3 p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newValue}
            onChange={(event) => onNewValueChange(event.target.value)}
            placeholder={t(`permissions.${sectionKey}.placeholder`, {
              defaultValue: isAllowed ? 'e.g. "bash:git log:*" or "write_file"' : 'e.g. "Bash(rm:*)"',
            })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (isImeEnterEvent(event)) return;
                event.preventDefault();
                onAdd(newValue);
              }
            }}
            className="h-10 flex-1"
          />
          <Button
            onClick={() => onAdd(newValue)}
            disabled={!newValue.trim()}
            size="sm"
            className="h-10 px-4"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("permissions.actions.add", { defaultValue: "Add" })}
          </Button>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("permissions.allowedTools.quickAdd", { defaultValue: "Quick add:" })}
          </p>
          <div className="flex flex-wrap gap-2">
            {quickTools.map((tool) => (
              <Button
                key={tool}
                variant="outline"
                size="sm"
                onClick={() => onAdd(tool)}
                disabled={tools.includes(tool)}
                className="h-7 text-xs"
              >
                {tool}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {tools.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
              {t(`permissions.${sectionKey}.empty`, {
                defaultValue: isAllowed
                  ? "No allowed tools configured yet."
                  : "No blocked tools configured.",
              })}
            </div>
          ) : (
            tools.map((tool) => (
              <div
                key={tool}
                className={
                  isAllowed
                    ? "flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2 dark:border-green-900/50 dark:bg-green-950/30"
                    : "flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/30"
                }
              >
                <code
                  className={
                    isAllowed
                      ? "font-mono text-xs text-green-800 dark:text-green-200"
                      : "font-mono text-xs text-red-800 dark:text-red-200"
                  }
                >
                  {tool}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(tool)}
                  className={
                    isAllowed
                      ? "h-7 w-7 p-0 text-green-700 hover:text-green-900 dark:text-green-300"
                      : "h-7 w-7 p-0 text-red-700 hover:text-red-900 dark:text-red-300"
                  }
                  aria-label={t("permissions.actions.remove", { defaultValue: "Remove" })}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
