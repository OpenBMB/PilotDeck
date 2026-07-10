import { useTranslation } from "react-i18next";

type AdvancedJsonEditorProps = {
  value: string;
  onChange: (value: string) => void;
};

export default function AdvancedJsonEditor({
  value,
  onChange,
}: AdvancedJsonEditorProps) {
  const { t } = useTranslation("settings");

  return (
    <details className="rounded-lg border border-border bg-background">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
        {t("mcpConfig.advanced")}
      </summary>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="min-h-[260px] w-full resize-y border-t border-border bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none"
      />
    </details>
  );
}
