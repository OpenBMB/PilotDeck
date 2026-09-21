import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse, stringify } from 'yaml';
import type { SurfaceProps } from '../contracts';
import { usePilotDeckConfig } from '../../hooks/usePilotDeckConfig';

export function ModulePage({ title, detail, children }: SurfaceProps & { title: string; detail: string; children?: ReactNode }) {
  return <section className="mx-auto w-full max-w-4xl px-6 py-8">
    <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
    <p className="mt-1 text-sm text-neutral-500">{detail}</p>
    <div className="mt-6">{children}</div>
  </section>;
}

/** A revision-aware, profile-backed field consumed by its selected module. */
export function ProfileTextSetting({
  slot,
  field,
  label,
  description,
  valueType = 'text',
}: {
  slot: string;
  field: string;
  label: string;
  description: string;
  valueType?: 'text' | 'positiveInteger';
}) {
  const { raw, loading, saving, error, commitRaw, refresh } = usePilotDeckConfig();
  const config = useMemo(() => {
    try {
      const value = parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
    } catch {
      return null;
    }
  }, [raw]);
  const value = config?.modules && typeof config.modules === 'object'
    ? config.modules[slot]?.[field]
    : undefined;
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setDraft(value == null ? '' : String(value)), [value]);

  if (loading) return <p className="py-3 text-sm text-neutral-500">Loading configuration...</p>;
  if (!config) return <p role="alert" className="py-3 text-sm text-red-600">The current PilotDeck configuration is invalid.</p>;

  const save = async () => {
    setMessage(null);
    const numericValue = Number(draft);
    if (valueType === 'positiveInteger' && (!Number.isInteger(numericValue) || numericValue <= 0)) {
      setMessage('Enter a positive whole number.');
      return;
    }
    const normalized: string | number = valueType === 'positiveInteger' ? numericValue : draft.trim();
    const modules = { ...(config.modules as Record<string, any> || {}) };
    modules[slot] = { ...(modules[slot] || {}), [field]: normalized };
    const result = await commitRaw(stringify({ ...config, modules }));
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    await refresh();
    setMessage('Saved and reloaded. New runs use this value.');
  };

  return <section className="space-y-3 rounded-md border border-border p-4" data-testid={`module-profile-setting-${slot}-${field}`}>
    <div>
      <label className="text-sm font-medium text-foreground" htmlFor={`module-${slot}-${field}`}>{label}</label>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
    <div className="flex flex-col gap-2 sm:flex-row">
      <input id={`module-${slot}-${field}`} type={valueType === 'positiveInteger' ? 'number' : 'text'} min={valueType === 'positiveInteger' ? 1 : undefined} className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={saving || !draft.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
    {error || message ? <p role={error ? 'alert' : 'status'} className={error ? 'text-sm text-red-600' : 'text-sm text-emerald-700'}>{error || message}</p> : null}
  </section>;
}
