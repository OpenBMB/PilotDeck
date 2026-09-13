import { useTranslation } from "react-i18next";

type SubagentsPreviewProps = {
  text: string;
  invalid: boolean;
  disabled?: boolean;
};

const prefix = "pilotDeckConfig.panels.agentSubagents.preview";

export default function SubagentsPreview({ text, invalid, disabled }: SubagentsPreviewProps) {
  const { t } = useTranslation("settings");
  return (
    <section
      aria-label={t(`${prefix}.title`)}
      className="rounded-xl border border-border bg-card/50 p-4"
    >
      <h3 className="text-[13px] font-medium text-foreground">{t(`${prefix}.title`)}</h3>
      <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
        {t(`${prefix}.description`)}
      </p>
      {invalid ? (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          {t(`${prefix}.invalid`)}
        </p>
      ) : text ? (
        <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-4 text-foreground">
          {text}
        </pre>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">{t(`${prefix}.${disabled ? "disabled" : "empty"}`)}</p>
      )}
    </section>
  );
}
