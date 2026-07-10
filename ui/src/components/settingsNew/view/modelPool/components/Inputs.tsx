import type { ReactNode } from "react";
import { cn } from "../../../../../lib/utils";
import { isMaskedSecret, secretDisplayValue } from "../utils/providerRefs";

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  monospace,
}: {
  value: string | number | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "number";
  className?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type={type}
      value={value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none",
        "focus:ring-1 focus:ring-ring",
        monospace && "font-mono text-xs",
        className,
      )}
    />
  );
}

export function SecretTextInput({
  value,
  onChange,
  placeholder,
  emptyPlaceholder,
  maskedPlaceholder,
  className,
  monospace,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  emptyPlaceholder?: string;
  maskedPlaceholder?: string;
  className?: string;
  monospace?: boolean;
}) {
  const masked = isMaskedSecret(value);
  return (
    <TextInput
      type="password"
      value={secretDisplayValue(value)}
      placeholder={
        placeholder ??
        (masked
          ? maskedPlaceholder ?? "Existing key kept — type to replace"
          : emptyPlaceholder)
      }
      monospace={monospace}
      className={className}
      onChange={onChange}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      type="number"
      value={value}
      placeholder={placeholder}
      onChange={(s) => {
        if (s === "") return onChange(undefined);
        const n = Number(s);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  const selectedOption = options.find((opt) => opt.value === value);
  const selectedLabel = selectedOption?.label ?? "";
  return (
    <div className="relative min-w-0">
      <div
        className={cn(
          "pointer-events-none flex w-full min-w-0 items-center rounded-md border border-border bg-background px-2 py-1.5 pr-8 text-[13px] leading-5",
          selectedOption?.disabled ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <span className="block min-w-0 truncate" title={selectedLabel}>
          {selectedLabel}
        </span>
      </div>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        ▾
      </span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={selectedLabel}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FormRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[180px_1fr] sm:gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5 text-foreground">
          {label}
        </div>
        {description && (
          <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
