import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { KeyValueRow } from "../types/mcp";
import { newId } from "../utils/mcpServerForm";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="mcp-form-field">
      <span className="mcp-field-label">{label}</span>
      {children}
    </label>
  );
}

export function IconButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className="mcp-icon-button danger"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <Trash2 size={16} />
    </button>
  );
}

export function StringListEditor({
  label,
  values,
  placeholder,
  addLabel,
  onChange,
  disabled = false,
}: {
  label: string;
  values: string[];
  placeholder: string;
  addLabel: string;
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mcp-repeatable-field">
      <span className="mcp-field-label">{label}</span>
      <div className="mcp-repeatable-list">
        {values.length === 0 && disabled ? <span className="mcp-empty-field-value">无</span> : null}
        {values.map((value, index) => (
          <div key={index} className="mcp-repeatable-row single">
            <input
              value={value}
              onChange={(event) =>
                onChange(
                  values.map((entry, i) =>
                    i === index ? event.target.value : entry,
                  ),
                )
              }
              placeholder={placeholder}
              aria-label={`${label} ${index + 1}`}
              title={value}
              disabled={disabled}
            />
            <IconButton
              label={`${label} ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            />
          </div>
        ))}
        <button
          type="button"
          className="mcp-add-row-button"
          disabled={disabled}
          onClick={() => onChange([...values, ""])}
        >
          <Plus size={15} />
          {addLabel}
        </button>
      </div>
    </div>
  );
}

export function KeyValueEditor({
  label,
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onChange,
  disabled = false,
}: {
  label: string;
  rows: KeyValueRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onChange: (rows: KeyValueRow[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mcp-repeatable-field">
      <span className="mcp-field-label">{label}</span>
      <div className="mcp-repeatable-list">
        {rows.length === 0 && disabled ? <span className="mcp-empty-field-value">无</span> : null}
        {rows.map((row) => (
          <div key={row.id} className="mcp-repeatable-row pair">
            <input
              value={row.key}
              onChange={(event) =>
                onChange(
                  rows.map((entry) =>
                    entry.id === row.id
                      ? { ...entry, key: event.target.value }
                      : entry,
                  ),
                )
              }
              placeholder={keyPlaceholder}
              disabled={disabled}
            />
            <input
              value={row.value}
              onChange={(event) =>
                onChange(
                  rows.map((entry) =>
                    entry.id === row.id
                      ? { ...entry, value: event.target.value }
                      : entry,
                  ),
                )
              }
              placeholder={valuePlaceholder}
              disabled={disabled}
            />
            <IconButton
              label={label}
              disabled={disabled}
              onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            />
          </div>
        ))}
        <button
          type="button"
          className="mcp-add-row-button"
          disabled={disabled}
          onClick={() => onChange([...rows, { id: newId(), key: "", value: "" }])}
        >
          <Plus size={15} />
          {addLabel}
        </button>
      </div>
    </div>
  );
}
