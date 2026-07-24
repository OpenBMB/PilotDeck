import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../../shared/view/ui";
import { cn } from "../../../../../lib/utils";
import type { KeyValueRow } from "../types/mcp";
import { INPUT_CLASS } from "../utils/constants";
import { newId } from "../utils/mcpServerForm";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
      onClick={onClick}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

export function StringListEditor({
  label,
  values,
  placeholder,
  addLabel,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder: string;
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
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
              className={INPUT_CLASS}
            />
            <IconButton onClick={() => onChange(values.filter((_, i) => i !== index))} />
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => onChange([...values, ""])}
        >
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
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
}: {
  label: string;
  rows: KeyValueRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
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
              className={INPUT_CLASS}
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
              className={INPUT_CLASS}
            />
            <IconButton onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))} />
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => onChange([...rows, { id: newId(), key: "", value: "" }])}
        >
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
