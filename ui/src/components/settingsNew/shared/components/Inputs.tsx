import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils";
import {
  isMaskedSecret,
  secretDisplayValue,
} from "../utils/secret";

type InputSaveMode = "explicit" | "immediate";

const InputSaveModeContext = createContext<InputSaveMode>("explicit");

export function FieldSaveModeProvider({
  mode,
  children,
}: {
  mode: InputSaveMode;
  children: ReactNode;
}) {
  return (
    <InputSaveModeContext.Provider value={mode}>
      {children}
    </InputSaveModeContext.Provider>
  );
}

function CommitButtons({
  onSave,
  onCancel,
  canSave = true,
}: {
  onSave: () => void;
  onCancel: () => void;
  canSave?: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {t("settingsNew.actions.cancel")}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("settingsNew.actions.save")}
      </button>
    </div>
  );
}

function EditableInputShell({
  value,
  onCommit,
  canCommit,
  children,
}: {
  value: string;
  onCommit: (next: string) => void;
  canCommit?: (draft: string) => boolean;
  children: (args: {
    editing: boolean;
    draft: string;
    setDraft: (next: string) => void;
    onEditKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  }) => ReactNode;
}) {
  const { t } = useTranslation("settings");
  const mode = useContext(InputSaveModeContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const isCommitAllowed = canCommit ? canCommit(draft) : true;

  if (mode === "immediate") {
    return (
      <>
        {children({
          editing: true,
          draft: value,
          setDraft: onCommit,
          onEditKeyDown: () => undefined,
        })}
      </>
    );
  }

  const save = () => {
    if (!isCommitAllowed) return;
    onCommit(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        {children({
          editing,
          draft,
          setDraft,
          onEditKeyDown: handleKeyDown,
        })}
      </div>
      <div className="shrink-0">
        {editing ? (
          <CommitButtons
            onSave={save}
            onCancel={cancel}
            canSave={isCommitAllowed && draft !== value}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("settingsNew.actions.edit")}
          </button>
        )}
      </div>
    </div>
  );
}

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
  const stringValue = value === undefined ? "" : String(value);
  return (
    <EditableInputShell value={stringValue} onCommit={onChange}>
      {({ editing, draft, setDraft, onEditKeyDown }) => (
        <input
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEditKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          readOnly={!editing}
          className={cn(
            "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none",
            editing
              ? "border-primary/40 ring-1 ring-ring/40 focus:ring-1 focus:ring-ring"
              : "cursor-default bg-muted/40 text-muted-foreground",
            monospace && "font-mono text-xs",
            className,
          )}
        />
      )}
    </EditableInputShell>
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
  const stringValue = value === undefined ? "" : String(value);
  return (
    <EditableInputShell
      value={stringValue}
      canCommit={(s) => s === "" || Number.isFinite(Number(s))}
      onCommit={(s) => {
        if (s === "") {
          onChange(undefined);
          return;
        }
        const n = Number(s);
        if (Number.isFinite(n)) onChange(n);
      }}
    >
      {({ editing, draft, setDraft, onEditKeyDown }) => (
        <input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEditKeyDown}
          placeholder={placeholder}
          readOnly={!editing}
          className={cn(
            "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none",
            editing
              ? "border-primary/40 ring-1 ring-ring/40 focus:ring-1 focus:ring-ring"
              : "cursor-default bg-muted/40 text-muted-foreground",
          )}
        />
      )}
    </EditableInputShell>
  );
}

export function TextAreaInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const mode = useContext(InputSaveModeContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const readonlyValue = value ?? "";

  useEffect(() => {
    if (!editing) setDraft(readonlyValue);
  }, [editing, readonlyValue]);

  if (mode === "immediate") {
    return (
      <textarea
        value={readonlyValue}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={cn(
          "min-h-[100px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring",
          className,
        )}
      />
    );
  }

  const save = () => {
    onChange(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(readonlyValue);
    setEditing(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey
    ) {
      event.preventDefault();
      save();
    }
  };

  return (
    <div className="flex items-start gap-2">
      <textarea
        value={editing ? draft : readonlyValue}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        readOnly={!editing}
        spellCheck={false}
        className={cn(
          "min-h-[100px] min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none",
          editing
            ? "border-primary/40 ring-1 ring-ring/40 focus:ring-1 focus:ring-ring"
            : "cursor-default bg-muted/40 text-muted-foreground",
          className,
        )}
      />
      <div className="shrink-0">
        {editing ? (
          <CommitButtons
            onSave={save}
            onCancel={cancel}
            canSave={draft !== readonlyValue}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("settingsNew.actions.edit")}
          </button>
        )}
      </div>
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
}) {
  const selectedOption = options.find((opt) => opt.value === value);
  const selectedLabel = selectedOption?.label ?? "";
  return (
    <div className="relative min-w-0">
      <div
        className={cn(
          "pointer-events-none flex w-full min-w-0 items-center rounded-md border border-border bg-background px-2 py-1.5 pr-8 text-[13px] leading-5",
          selectedOption?.disabled || disabled
            ? "bg-muted/40 text-muted-foreground"
            : "text-foreground",
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
        disabled={disabled}
        className={cn(
          "absolute inset-0 h-full w-full opacity-0",
          disabled ? "cursor-default" : "cursor-pointer",
        )}
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
