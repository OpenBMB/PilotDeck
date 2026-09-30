import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../../lib/utils";

export type ProfileRow = {
  id: string;
  description: string;
  model?: string;
  tools: string[];
  enabled: boolean;
  builtIn: boolean;
  readOnly: boolean;
};

type ProfileListProps = {
  rows: ProfileRow[];
  selectedId: string | null;
  hasOverride: (id: string) => boolean;
  isNew: (id: string) => boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReset: (id: string) => void;
};

function Badge({ label, tone }: { label: string; tone: "primary" | "muted" | "destructive" }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        tone === "primary" && "border-primary/30 bg-primary/10 text-primary",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
        tone === "destructive" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {label}
    </span>
  );
}

export default function ProfileList({
  rows,
  selectedId,
  hasOverride,
  isNew,
  onSelect,
  onDelete,
  onReset,
}: ProfileListProps) {
  const { t } = useTranslation("settings");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => setConfirmId(null), [selectedId]);

  return (
    <section aria-label={t("pilotDeckConfig.panels.agentSubagents.listTitle")}>
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const active = row.id === selectedId;
          return (
            <li
              key={row.id}
              className={cn(
                "flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center",
                active
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-background hover:bg-accent/40",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(row.id)}
                aria-pressed={active}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">{row.id}</span>
                  <Badge
                    label={t(
                      row.builtIn
                        ? "pilotDeckConfig.panels.agentSubagents.badgeBuiltin"
                        : "pilotDeckConfig.panels.agentSubagents.badgeCustom",
                    )}
                    tone={row.builtIn ? "primary" : "muted"}
                  />
                  {isNew(row.id) ? (
                    <Badge label={t("pilotDeckConfig.panels.agentSubagents.badgeNew")} tone="muted" />
                  ) : null}
                  {!row.enabled ? (
                    <Badge
                      label={t("pilotDeckConfig.panels.agentSubagents.badgeDisabled")}
                      tone="destructive"
                    />
                  ) : null}
                  {row.readOnly ? (
                    <Badge label={t("pilotDeckConfig.panels.agentSubagents.badgeReadOnly")} tone="muted" />
                  ) : null}
                  <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">
                    {row.model ?? t("pilotDeckConfig.panels.agentSubagents.modelInherit")}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                  {row.description}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {row.builtIn && hasOverride(row.id) ? (
                  <button
                    type="button"
                    onClick={() => onReset(row.id)}
                    aria-label={t("pilotDeckConfig.panels.agentSubagents.editor.resetAria")}
                    className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("pilotDeckConfig.panels.agentSubagents.editor.reset")}
                  </button>
                ) : null}
                {!row.builtIn ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirmId === row.id) {
                        setConfirmId(null);
                        onDelete(row.id);
                      } else {
                        setConfirmId(row.id);
                      }
                    }}
                    className={cn(
                      "rounded border px-2 py-1 text-[11px] transition-colors",
                      confirmId === row.id
                        ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                        : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {t(
                      confirmId === row.id
                        ? "pilotDeckConfig.panels.agentSubagents.editor.deleteConfirm"
                        : "pilotDeckConfig.panels.agentSubagents.editor.delete",
                    )}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
