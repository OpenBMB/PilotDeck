import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";

export function McpCodeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path
        d="M152,32V96a16,16,0,0,1-16,16H32A16,16,0,0,1,16,96V32A16,16,0,0,1,32,16H136A16,16,0,0,1,152,32Z"
        opacity="0.2"
      />
      <path d="M58.34,101.66l-32-32a8,8,0,0,1,0-11.32l32-32A8,8,0,0,1,69.66,37.66L43.31,64,69.66,90.34a8,8,0,0,1-11.32,11.32Zm40,0a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0,0-11.32l-32-32A8,8,0,0,0,98.34,37.66L124.69,64,98.34,90.34A8,8,0,0,0,98.34,101.66ZM200,40H176a8,8,0,0,0,0,16h24V200H56V136a8,8,0,0,0-16,0v64a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Z" />
    </svg>
  );
}

type AdvancedJsonEditorProps = {
  value: string;
  resetValue: string;
  onChange: (value: string) => void;
  label: string;
  path?: string;
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
};

export default function AdvancedJsonEditor({
  value,
  resetValue,
  onChange,
  label,
  path,
  onSave,
  saving = false,
  disabled = false,
}: AdvancedJsonEditorProps) {
  const { t } = useTranslation("settings");

  return (
    <details className="mcp-raw-editor">
      <summary className="mcp-raw-trigger">
        <span>
          <ChevronRight size={14} />
          <McpCodeIcon />
          {label}
        </span>
        <small>{path || t("mcpConfig.noPath")}</small>
      </summary>
      <div className="mcp-raw-body">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
        <div className="mcp-raw-actions">
          <span>{t("mcpConfig.applyJsonHint")}</span>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => onChange(resetValue)}
            disabled={saving || disabled || value === resetValue}
          >
            {t("mcpConfig.resetJson")}
          </button>
          <button
            type="button"
            className="button primary compact"
            onClick={onSave}
            disabled={saving || disabled}
          >
            {t("mcpConfig.applyJson")}
          </button>
        </div>
      </div>
    </details>
  );
}
