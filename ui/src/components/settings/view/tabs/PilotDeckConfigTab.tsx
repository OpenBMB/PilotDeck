import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  Code2,
  FileCog,
  FolderOpen,
  Info,
  LayoutList,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Button } from '../../../../shared/view/ui';
import { usePilotDeckConfig, type ConfigReload } from '../../../../hooks/usePilotDeckConfig';
import {
  getAlwaysOnProjectRoot,
  isAlwaysOnProjectEnabled,
  setAlwaysOnProjectEnabled,
} from '../../../../utils/alwaysOnConfigPatch';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { cn } from '../../../../lib/utils';
import type { SettingsProject } from '../../types/types';

// ── Types ──────────────────────────────────────────────────────────────

type Provider = {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

type ModelEntry = {
  provider?: string;
  name?: string;
  contextWindow?: number;
};

type PilotDeckConfig = {
  version?: number;
  runtime?: {
    host?: string;
    serverPort?: number;
    vitePort?: number;
    proxyPort?: number;
    contextWindow?: number;
    apiTimeoutMs?: number;
    databasePath?: string;
    workspacesRoot?: string;
  };
  models?: {
    providers?: Record<string, Provider>;
    entries?: Record<string, ModelEntry>;
  };
  agents?: {
    main?: { model?: string; params?: Record<string, unknown> };
    subagents?: { default?: string; params?: Record<string, unknown> };
  };
  alwaysOn?: {
    enabled?: boolean;
    trigger?: {
      enabled?: boolean;
      tickIntervalMinutes?: number;
      cooldownMinutes?: number;
      dailyBudget?: number;
      heartbeatStaleSeconds?: number;
      recentUserMsgMinutes?: number;
      preferChannel?: string;
    };
    dormancy?: {
      enabled?: boolean;
      debounceMs?: number;
      ignoreGlobs?: string[];
    };
    workspace?: {
      gitWorktreeBaseDir?: string;
      snapshotBaseDir?: string;
      snapshotMaxBytes?: number;
      gitLfs?: boolean;
    };
    execution?: {
      maxTurns?: number;
      maxToolCalls?: number;
      timeoutMinutes?: number;
    };
    projects?: Record<string, { enabled?: boolean }>;
  };
  customEnv?: Record<string, string>;
  memory?: { enabled?: boolean; model?: string; params?: Record<string, unknown> };
  router?: { enabled?: boolean } & Record<string, unknown>;
  gateway?: { enabled?: boolean; home?: string } & Record<string, unknown>;
};

type SectionId = 'runtime' | 'models' | 'agents' | 'customEnv' | 'alwaysOn' | 'memory' | 'router' | 'gateway';

const SECTIONS: Array<{ id: SectionId; labelKey: string; descriptionKey: string }> = [
  { id: 'runtime', labelKey: 'runtime',  descriptionKey: 'runtime' },
  { id: 'models',  labelKey: 'models',   descriptionKey: 'models' },
  { id: 'agents',  labelKey: 'agents',   descriptionKey: 'agents' },
  { id: 'customEnv', labelKey: 'customEnv', descriptionKey: 'customEnv' },
  { id: 'alwaysOn', labelKey: 'alwaysOn', descriptionKey: 'alwaysOn' },
  { id: 'memory',  labelKey: 'memory',   descriptionKey: 'memory' },
  { id: 'router',  labelKey: 'router',   descriptionKey: 'router' },
  { id: 'gateway', labelKey: 'gateway',  descriptionKey: 'gateway' },
];

// ── Reload-status presentation (kept identical to legacy raw view) ──────

type SubsystemKey = 'processEnv' | 'memory' | 'router' | 'gateway' | 'proxy';
const SUBSYSTEM_LABELS: Record<SubsystemKey, string> = {
  processEnv: 'Process Env',
  memory: 'Memory',
  router: 'Router (CCR)',
  gateway: 'Gateway',
  proxy: 'Proxy',
};

type SubsystemResult = {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
};

function classifySubsystem(result: SubsystemResult | undefined): 'ok' | 'skipped' | 'error' | 'unknown' {
  if (!result) return 'unknown';
  if (result.error) return 'error';
  if (result.reloaded) return 'ok';
  if (result.skipped) return 'skipped';
  return 'unknown';
}

function subsystemBadgeClasses(state: 'ok' | 'skipped' | 'error' | 'unknown'): string {
  if (state === 'ok') return 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300';
  if (state === 'skipped') return 'border-border bg-muted text-muted-foreground';
  if (state === 'error') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function SubsystemIcon({ state }: { state: 'ok' | 'skipped' | 'error' | 'unknown' }) {
  if (state === 'ok') return <CheckCircle2 className="h-4 w-4" />;
  if (state === 'error') return <XCircle className="h-4 w-4" />;
  if (state === 'skipped') return <Info className="h-4 w-4" />;
  return <Info className="h-4 w-4 opacity-50" />;
}

function ReloadSummary({ reload }: { reload: ConfigReload | null }) {
  if (!reload) {
    return <div className="text-sm text-muted-foreground">No reload has run yet.</div>;
  }
  const keys: SubsystemKey[] = ['processEnv', 'memory', 'router', 'gateway', 'proxy'];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {keys.map((key) => {
        const result = reload[key] as SubsystemResult | undefined;
        const state = classifySubsystem(result);
        const detail = result?.error || result?.reason || result?.note || (state === 'ok' ? 'Reloaded' : state === 'unknown' ? 'No data' : '');
        return (
          <div key={key} className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs ${subsystemBadgeClasses(state)}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <SubsystemIcon state={state} />
              <span>{SUBSYSTEM_LABELS[key]}</span>
            </div>
            {detail && <div className="text-[11px] opacity-80">{detail}</div>}
          </div>
        );
      })}
    </div>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'ui-save':   return 'UI save';
    case 'ui-reload': return 'UI reload';
    case 'watcher':   return 'External file edit';
    case 'refresh':   return 'Manual refresh';
    default:          return source;
  }
}

// ── Form-mode helpers ──────────────────────────────────────────────────

function safeParseYaml(text: string): PilotDeckConfig | null {
  try {
    const value = parseYaml(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as PilotDeckConfig;
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a new YAML string with the patched config — everything else (top-
 * level shape, formatting defaults) flows through `yaml`'s round-trip.
 *
 * Note: comments and key ordering are not preserved across this trip. Users
 * who care about hand-formatted YAML should use the Raw YAML tab — that mode
 * just edits the textarea and never reserializes.
 */
function configToYamlString(config: PilotDeckConfig): string {
  return stringifyYaml(config, { indent: 2, lineWidth: 0 });
}

type Path = readonly (string | number)[];

function patch<T extends PilotDeckConfig>(config: T, path: Path, value: unknown): T {
  // Immutable deep set. Each key cloned along the way so React picks up the
  // change. Numeric segments materialise arrays; everything else materialises
  // objects.
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === 'number';
  const current: any = config ?? (isArrayKey ? [] : {});
  const next: any = isArrayKey ? [...(current as unknown[])] : { ...(current as object) };
  next[head as string | number] = rest.length === 0 ? value : patch(current?.[head as string | number] ?? (typeof rest[0] === 'number' ? [] : {}), rest, value);
  return next as T;
}

const MASK = '********';

// ── Reusable inputs ────────────────────────────────────────────────────

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
  monospace,
}: {
  value: string | number | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
  className?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type={type}
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={cn(
        'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none',
        'focus:ring-1 focus:ring-ring',
        monospace && 'font-mono text-xs',
        className,
      )}
    />
  );
}

function NumberInput({
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
        if (s === '') return onChange(undefined);
        const n = Number(s);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function FormRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-4 py-3 sm:grid-cols-[200px_1fr] sm:gap-4 sm:py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Section components ─────────────────────────────────────────────────

function RuntimeSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const r = config.runtime ?? {};
  const set = <K extends keyof NonNullable<PilotDeckConfig['runtime']>>(key: K, value: NonNullable<PilotDeckConfig['runtime']>[K]) =>
    onChange(patch(config, ['runtime', key as string], value));
  return (
    <SettingsSection title="Runtime" description="Ports the server binds to and request timeouts.">
      <SettingsCard divided>
        <FormRow label="Host" description="Bind interface for the HTTP/WebSocket server.">
          <TextInput value={r.host} placeholder="0.0.0.0" onChange={(v) => set('host', v)} />
        </FormRow>
        <FormRow label="Server port" description="Express + WebSocket port.">
          <NumberInput value={r.serverPort} placeholder="3001" onChange={(v) => set('serverPort', v as any)} />
        </FormRow>
        <FormRow label="Vite port" description="Frontend dev server (only used when running `npm run dev`).">
          <NumberInput value={r.vitePort} placeholder="5173" onChange={(v) => set('vitePort', v as any)} />
        </FormRow>
        <FormRow label="Proxy port" description="Local LLM proxy (Claude Agent SDK target).">
          <NumberInput value={r.proxyPort} placeholder="18080" onChange={(v) => set('proxyPort', v as any)} />
        </FormRow>
        <FormRow label="Context window" description="Default token budget for new sessions.">
          <NumberInput value={r.contextWindow} placeholder="160000" onChange={(v) => set('contextWindow', v as any)} />
        </FormRow>
        <FormRow label="API timeout (ms)" description="Per-request upstream timeout.">
          <NumberInput value={r.apiTimeoutMs} placeholder="120000" onChange={(v) => set('apiTimeoutMs', v as any)} />
        </FormRow>
        <FormRow label="Database path" description="SQLite auth/projects database (~ expands to home).">
          <TextInput value={r.databasePath} placeholder="~/.pilotdeck/auth.db" monospace onChange={(v) => set('databasePath', v)} />
        </FormRow>
        <FormRow label="Workspaces root" description="Directory under which projects are scanned.">
          <TextInput value={r.workspacesRoot} placeholder="~" monospace onChange={(v) => set('workspacesRoot', v)} />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function ProvidersEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const providers = config.models?.providers ?? {};
  const ids = Object.keys(providers);

  const setProvider = (id: string, prov: Provider) => onChange(patch(config, ['models', 'providers', id], prov));
  const removeProvider = (id: string) => {
    const next = { ...providers };
    delete next[id];
    onChange(patch(config, ['models', 'providers'], next));
  };
  const renameProvider = (oldId: string, newId: string) => {
    if (!newId || newId === oldId || providers[newId]) return;
    const next: Record<string, Provider> = {};
    for (const [k, v] of Object.entries(providers)) next[k === oldId ? newId : k] = v;
    onChange(patch(config, ['models', 'providers'], next));
  };
  const addProvider = () => {
    let i = 1;
    while (providers[`provider${i}`]) i++;
    setProvider(`provider${i}`, { type: 'openai-chat', baseUrl: '', apiKey: '' });
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Providers</div>
          <div className="text-xs text-muted-foreground">Upstream LLM endpoints. The provider id is referenced by model entries.</div>
        </div>
        <Button variant="outline" size="sm" onClick={addProvider}>+ Add provider</Button>
      </div>
      {ids.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No providers configured.
        </div>
      )}
      {ids.map((id) => {
        const p = providers[id] ?? {};
        const isMaskedKey = p.apiKey === MASK;
        return (
          <div key={id} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">id</span>
              <input
                value={id}
                onChange={(e) => renameProvider(id, e.target.value.trim())}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <Button variant="ghost" size="sm" onClick={() => removeProvider(id)} className="text-destructive hover:text-destructive">Remove</Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Type</span>
                <Select
                  value={p.type ?? 'openai-chat'}
                  onChange={(v) => setProvider(id, { ...p, type: v })}
                  options={[
                    { value: 'openai-chat',     label: 'openai-chat' },
                    { value: 'openai-responses', label: 'openai-responses' },
                    { value: 'anthropic',       label: 'anthropic' },
                    { value: 'litellm',         label: 'litellm' },
                    { value: 'ccr',             label: 'ccr' },
                  ]}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Base URL</span>
                <TextInput value={p.baseUrl} placeholder="https://api.example.com" monospace onChange={(v) => setProvider(id, { ...p, baseUrl: v })} />
              </label>
            </div>
            <label className="block text-xs text-muted-foreground">
              <span className="mb-1 block">API key</span>
              <TextInput
                type="password"
                value={p.apiKey}
                placeholder={isMaskedKey ? 'Existing key kept — type to replace' : 'sk-...'}
                onChange={(v) => setProvider(id, { ...p, apiKey: v })}
              />
              {isMaskedKey && (
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  Key hidden; leave as-is to keep, retype to replace.
                </span>
              )}
            </label>
          </div>
        );
      })}
    </SettingsCard>
  );
}

function EntriesEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const entries = config.models?.entries ?? {};
  const providerIds = Object.keys(config.models?.providers ?? {});
  const ids = Object.keys(entries);

  const setEntry = (id: string, e: ModelEntry) => onChange(patch(config, ['models', 'entries', id], e));
  const removeEntry = (id: string) => {
    const next = { ...entries };
    delete next[id];
    onChange(patch(config, ['models', 'entries'], next));
  };
  const renameEntry = (oldId: string, newId: string) => {
    if (!newId || newId === oldId || entries[newId]) return;
    const next: Record<string, ModelEntry> = {};
    for (const [k, v] of Object.entries(entries)) next[k === oldId ? newId : k] = v;
    onChange(patch(config, ['models', 'entries'], next));
  };
  const addEntry = () => {
    const baseId = entries.default ? 'entry' : 'default';
    let id = baseId;
    let i = 1;
    while (entries[id]) { id = `${baseId}${i++}`; }
    setEntry(id, { provider: providerIds[0] ?? '', name: '' });
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Model entries</div>
          <div className="text-xs text-muted-foreground">Named model bindings — agents reference these by id.</div>
        </div>
        <Button variant="outline" size="sm" onClick={addEntry} disabled={providerIds.length === 0}>+ Add entry</Button>
      </div>
      {providerIds.length === 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Add at least one provider before creating model entries.
        </div>
      )}
      {ids.length === 0 && providerIds.length > 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No entries yet.
        </div>
      )}
      {ids.map((id) => {
        const entry = entries[id] ?? {};
        return (
          <div key={id} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">id</span>
              <input
                value={id}
                onChange={(e) => renameEntry(id, e.target.value.trim())}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <Button variant="ghost" size="sm" onClick={() => removeEntry(id)} className="text-destructive hover:text-destructive">Remove</Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Provider</span>
                <Select
                  value={entry.provider}
                  onChange={(v) => setEntry(id, { ...entry, provider: v })}
                  options={[
                    { value: '', label: '— pick provider —' },
                    ...providerIds.map((pid) => ({ value: pid, label: pid })),
                  ]}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">Model name</span>
                <TextInput value={entry.name} placeholder="claude-sonnet-4-5" monospace onChange={(v) => setEntry(id, { ...entry, name: v })} />
              </label>
            </div>
            <label className="block text-xs text-muted-foreground">
              <span className="mb-1 block">Context window (optional)</span>
              <NumberInput value={entry.contextWindow} placeholder="160000" onChange={(v) => setEntry(id, { ...entry, contextWindow: v })} />
            </label>
          </div>
        );
      })}
    </SettingsCard>
  );
}

function ModelsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  return (
    <SettingsSection title="Models" description="Define upstream providers and the named model entries that agents bind to.">
      <div className="space-y-4">
        <ProvidersEditor config={config} onChange={onChange} />
        <EntriesEditor  config={config} onChange={onChange} />
      </div>
    </SettingsSection>
  );
}

function AgentsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const entries = config.models?.entries ?? {};
  const entryIds = Object.keys(entries);
  const main = config.agents?.main ?? {};
  const subagents = config.agents?.subagents ?? {};

  const entryOptions = [
    { value: '', label: '— pick model entry —' },
    ...entryIds.map((id) => ({ value: id, label: id })),
  ];
  const subOptions = [
    { value: 'inherit', label: 'inherit (use main agent\'s model)' },
    ...entryIds.map((id) => ({ value: id, label: id })),
  ];

  return (
    <SettingsSection title="Agents" description="Bind agent roles to named model entries.">
      <SettingsCard divided>
        <FormRow label="Main agent model" description="Used by the primary chat agent.">
          <Select value={main.model} options={entryOptions} onChange={(v) => onChange(patch(config, ['agents', 'main', 'model'], v))} />
        </FormRow>
        <FormRow label="Subagents default" description="Used by tool-spawned subagents (e.g. tasks).">
          <Select value={subagents.default} options={subOptions} onChange={(v) => onChange(patch(config, ['agents', 'subagents', 'default'], v))} />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const WELL_KNOWN_ENV_KEYS = [
  { key: 'TAVILY_API_KEY', hint: 'Tavily web search API key' },
  { key: 'FIRECRAWL_API_KEY', hint: 'Firecrawl web scraping API key' },
  { key: 'SERPER_API_KEY', hint: 'Serper search API key' },
  { key: 'BROWSERBASE_API_KEY', hint: 'Browserbase API key' },
];

function CustomEnvSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const envMap = config.customEnv ?? {};
  const entries = Object.entries(envMap);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const setEnv = (key: string, value: string) => {
    onChange(patch(config, ['customEnv', key], value));
  };
  const removeEnv = (key: string) => {
    const next = { ...envMap };
    delete next[key];
    onChange(patch(config, ['customEnv'], next));
  };
  const addEntry = () => {
    const key = newKey.trim();
    if (!key) return;
    onChange(patch(config, ['customEnv', key], newValue));
    setNewKey('');
    setNewValue('');
  };
  const addWellKnown = (key: string) => {
    if (envMap[key] !== undefined) return;
    onChange(patch(config, ['customEnv', key], ''));
  };

  const unusedWellKnown = WELL_KNOWN_ENV_KEYS.filter((wk) => envMap[wk.key] === undefined);

  return (
    <SettingsSection
      title="Environment Variables"
      description="Custom env vars injected into every agent session. Persisted in config.yaml — no need to reconfigure after switching sessions."
    >
      <SettingsCard className="space-y-3 p-4">
        {entries.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No custom environment variables configured.
          </div>
        )}
        {entries.map(([key, value]) => {
          const isMasked = value === MASK;
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  value={key}
                  readOnly
                  className="w-[200px] shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none"
                />
                <span className="text-muted-foreground">=</span>
                <TextInput
                  type="password"
                  value={value}
                  placeholder={isMasked ? 'Existing value kept — type to replace' : 'value'}
                  monospace
                  onChange={(v) => setEnv(key, v)}
                />
                <button
                  type="button"
                  onClick={() => removeEnv(key)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {isMasked && (
                <div className="ml-[216px] flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  Value hidden; leave as-is to keep, retype to replace.
                </div>
              )}
            </div>
          );
        })}

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-xs font-medium text-foreground">Add variable</div>
          <div className="flex items-center gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="KEY_NAME"
              className="w-[200px] shrink-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-muted-foreground">=</span>
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              type="password"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === 'Enter') addEntry(); }}
            />
            <Button variant="outline" size="sm" onClick={addEntry} disabled={!newKey.trim()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        </div>

        {unusedWellKnown.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-xs text-muted-foreground">Quick add common keys:</div>
            <div className="flex flex-wrap gap-1.5">
              {unusedWellKnown.map((wk) => (
                <button
                  key={wk.key}
                  type="button"
                  onClick={() => addWellKnown(wk.key)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
                  title={wk.hint}
                >
                  <Plus className="h-3 w-3" />
                  {wk.key}
                </button>
              ))}
            </div>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function AlwaysOnSection({
  config,
  projects,
  onChange,
}: {
  config: PilotDeckConfig;
  projects: SettingsProject[];
  onChange: (next: PilotDeckConfig) => void;
}) {
  const ao = config.alwaysOn ?? {};
  const trigger = ao.trigger ?? {};
  const dormancy = ao.dormancy ?? {};
  const workspace = ao.workspace ?? {};
  const execution = ao.execution ?? {};
  const enabled = ao.enabled === true;

  const projectRows = projects
    .map(project => ({ project, root: getAlwaysOnProjectRoot(project) }))
    .filter(item => item.root.length > 0);

  return (
    <SettingsSection
      title="Always-On"
      description="Configure automatic discovery globally and opt individual workspaces in."
    >
      <div className="space-y-4">
        {/* General */}
        <SettingsCard>
          <SettingsRow
            label="Enabled"
            description="Master switch for Always-On background agent."
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel="Toggle Always-On"
              onChange={(value) => onChange(patch(config, ['alwaysOn', 'enabled'], value))}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            {/* Trigger */}
            <SettingsSection title="Trigger" description="Controls when and how often discovery runs fire.">
              <SettingsCard divided>
                <SettingsRow
                  label="Auto discovery"
                  description="When enabled, Always-On periodically inspects opted-in workspaces and proposes follow-up plans."
                >
                  <SettingsToggle
                    checked={trigger.enabled === true}
                    ariaLabel="Toggle automatic discovery"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label="Tick interval (minutes)" description="How often the daemon checks opted-in workspaces.">
                  <NumberInput
                    value={trigger.tickIntervalMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'tickIntervalMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Cooldown (minutes)" description="Minimum time between discovery runs per workspace.">
                  <NumberInput
                    value={trigger.cooldownMinutes}
                    placeholder="60"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'cooldownMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Daily budget" description="Maximum automatic discovery runs per workspace per day.">
                  <NumberInput
                    value={trigger.dailyBudget}
                    placeholder="4"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'dailyBudget'], value))}
                  />
                </FormRow>
                <FormRow label="Heartbeat stale (seconds)" description="Heartbeats older than this are considered stale.">
                  <NumberInput
                    value={trigger.heartbeatStaleSeconds}
                    placeholder="90"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'heartbeatStaleSeconds'], value))}
                  />
                </FormRow>
                <FormRow label="Recent user msg (minutes)" description="Only fire if the user sent a message within this window.">
                  <NumberInput
                    value={trigger.recentUserMsgMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'recentUserMsgMinutes'], value))}
                  />
                </FormRow>
                <FormRow label="Preferred channel" description="Channel the discovery agent prefers to interact through.">
                  <Select
                    value={trigger.preferChannel}
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'preferChannel'], value))}
                    options={[
                      { value: 'web', label: 'Web UI' },
                      { value: 'tui', label: 'TUI' },
                    ]}
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Dormancy */}
            <SettingsSection title="Dormancy" description="File-system watcher that pauses discovery while the user is actively editing.">
              <SettingsCard divided>
                <SettingsRow
                  label="Enabled"
                  description="Suppress discovery fires while the workspace has recent file changes."
                >
                  <SettingsToggle
                    checked={dormancy.enabled !== false}
                    ariaLabel="Toggle dormancy"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label="Debounce (ms)" description="Wait this long after the last file change before resuming.">
                  <NumberInput
                    value={dormancy.debounceMs}
                    placeholder="2000"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'debounceMs'], value))}
                  />
                </FormRow>
                <FormRow label="Ignore globs" description="File patterns excluded from dormancy detection, one per line.">
                  <textarea
                    value={(dormancy.ignoreGlobs ?? []).join('\n')}
                    placeholder={"**/.git/**\n**/node_modules/**\n**/.pilotdeck/**\n**/dist/**\n**/.DS_Store"}
                    onChange={(e) => {
                      const globs = e.target.value.split('\n').filter((s) => s.trim().length > 0);
                      onChange(patch(config, ['alwaysOn', 'dormancy', 'ignoreGlobs'], globs));
                    }}
                    spellCheck={false}
                    className="min-h-[100px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Workspace */}
            <SettingsSection title="Workspace" description="Isolated workspace strategy for Always-On runs.">
              <SettingsCard divided>
                <FormRow label="Git worktree base dir" description="Root directory for git worktree-based isolation.">
                  <TextInput
                    value={workspace.gitWorktreeBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitWorktreeBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label="Snapshot base dir" description="Root directory for snapshot-based isolation.">
                  <TextInput
                    value={workspace.snapshotBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label="Snapshot max bytes" description="Maximum size of a workspace snapshot.">
                  <NumberInput
                    value={workspace.snapshotMaxBytes}
                    placeholder="1073741824"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotMaxBytes'], value))}
                  />
                </FormRow>
                <SettingsRow
                  label="Git LFS"
                  description="Include Git LFS objects in workspace snapshots."
                >
                  <SettingsToggle
                    checked={workspace.gitLfs === true}
                    ariaLabel="Toggle Git LFS"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitLfs'], value))}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            {/* Execution */}
            <SettingsSection title="Execution" description="Safety limits for each Always-On run.">
              <SettingsCard divided>
                <FormRow label="Max turns" description="Maximum number of agent turns per run.">
                  <NumberInput
                    value={execution.maxTurns}
                    placeholder="30"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxTurns'], value))}
                  />
                </FormRow>
                <FormRow label="Max tool calls" description="Maximum total tool calls per run.">
                  <NumberInput
                    value={execution.maxToolCalls}
                    placeholder="200"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxToolCalls'], value))}
                  />
                </FormRow>
                <FormRow label="Timeout (minutes)" description="Hard timeout for each run.">
                  <NumberInput
                    value={execution.timeoutMinutes}
                    placeholder="20"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'timeoutMinutes'], value))}
                  />
                </FormRow>
              </SettingsCard>
            </SettingsSection>

            {/* Workspace opt-in */}
            <SettingsSection
              title="Workspace opt-in"
              description="Only enabled workspaces receive Always-On heartbeats and scheduled discovery checks."
            >
              <SettingsCard divided>
                {projectRows.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    No recognized projects yet. Add or open a workspace first.
                  </div>
                ) : (
                  projectRows.map(({ project, root }) => (
                    <SettingsRow
                      key={root}
                      label={project.displayName || project.name}
                      description={root}
                    >
                      <SettingsToggle
                        checked={isAlwaysOnProjectEnabled(config, project)}
                        ariaLabel={`Toggle Always-On for ${project.displayName || project.name}`}
                        onChange={(en) => onChange(setAlwaysOnProjectEnabled(config, project, en))}
                      />
                    </SettingsRow>
                  ))
                )}
              </SettingsCard>
            </SettingsSection>
          </>
        )}
      </div>
    </SettingsSection>
  );
}

function MemorySection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const m = config.memory ?? {};
  const entryIds = Object.keys(config.models?.entries ?? {});
  const options = [
    { value: 'inherit', label: 'inherit (use main agent\'s model)' },
    ...entryIds.map((id) => ({ value: id, label: id })),
  ];
  return (
    <SettingsSection title="Memory" description="PilotDeck memory service — embeddings & summarisation pipelines.">
      <SettingsCard>
        <SettingsRow label="Enabled" description="Toggles the memory service. Disabled by default.">
          <SettingsToggle
            checked={Boolean(m.enabled)}
            ariaLabel="Toggle memory service"
            onChange={(v) => onChange(patch(config, ['memory', 'enabled'], v))}
          />
        </SettingsRow>
        {m.enabled && (
          <FormRow label="Memory model" description="Model used by the memory pipeline.">
            <Select value={m.model ?? 'inherit'} options={options} onChange={(v) => onChange(patch(config, ['memory', 'model'], v))} />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function RouterSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const r = config.router ?? {};
  return (
    <SettingsSection title="Router" description="Embedded Claude Code Router (CCR) for fan-out across providers.">
      <SettingsCard>
        <SettingsRow
          label="Enabled"
          description="When on, agents use the router instead of the configured provider directly. Detailed routes still live in the YAML — toggle this and use the Raw YAML tab to fine-tune."
        >
          <SettingsToggle
            checked={Boolean(r.enabled)}
            ariaLabel="Toggle router"
            onChange={(v) => onChange(patch(config, ['router', 'enabled'], v))}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function GatewaySection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const g = config.gateway ?? {};
  return (
    <SettingsSection title="Gateway" description="Messaging gateway (Feishu / Telegram / Discord / Slack) — channel-level secrets are best edited via Raw YAML.">
      <SettingsCard divided>
        <SettingsRow label="Enabled" description="When on, the gateway home is generated and channels with credentials come online.">
          <SettingsToggle
            checked={Boolean(g.enabled)}
            ariaLabel="Toggle gateway"
            onChange={(v) => onChange(patch(config, ['gateway', 'enabled'], v))}
          />
        </SettingsRow>
        {g.enabled && (
          <FormRow label="Gateway home" description="Working directory for gateway state and per-channel configs.">
            <TextInput value={g.home} placeholder="~/.pilotdeck/gateway" monospace onChange={(v) => onChange(patch(config, ['gateway', 'home'], v))} />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// ── Raw YAML view (kept very close to the original textarea panel) ──────

function RawYamlView({
  raw, setRaw, validation, error, message, isDirty, externalChangeNotice, dismissExternalNotice,
}: {
  raw: string;
  setRaw: (value: string) => void;
  validation: { valid: boolean; errors: string[]; warnings: string[] } | null;
  error: string | null;
  message: string | null;
  isDirty: boolean;
  externalChangeNotice: string | null;
  dismissExternalNotice: () => void;
}) {
  return (
    <div className="space-y-4">
      {externalChangeNotice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex-1">{externalChangeNotice}</div>
          <button
            type="button"
            onClick={dismissExternalNotice}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
          >
            Dismiss
          </button>
        </div>
      )}
      <SettingsCard className="overflow-hidden">
        <textarea
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          spellCheck={false}
          className="min-h-[480px] w-full resize-y border-0 bg-background p-4 font-mono text-xs leading-5 text-foreground outline-none"
        />
      </SettingsCard>

      <div className="flex items-center gap-2">
        {validation?.valid ? (
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Config is valid {isDirty && <span className="text-muted-foreground">(unsaved)</span>}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            Config has validation errors
          </div>
        )}
      </div>

      {validation && validation.errors.length > 0 && (
        <div className="text-destructive">
          <div className="mb-1 text-xs font-semibold">Errors</div>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {validation.errors.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      {validation && validation.warnings.length > 0 && (
        <div className="text-amber-600 dark:text-amber-400">
          <div className="mb-1 text-xs font-semibold">Warnings</div>
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {validation.warnings.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">{message}</div>}
    </div>
  );
}

// ── Main tab ───────────────────────────────────────────────────────────

type ViewMode = 'form' | 'raw';

export default function PilotDeckConfigTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const { t } = useTranslation('settings');
  const {
    path,
    raw,
    setRaw,
    exists,
    validation,
    reload,
    lastReloadInfo,
    isDirty,
    externalChangeNotice,
    dismissExternalNotice,
    loading,
    saving,
    opening,
    error,
    message,
    refresh,
    save,
    reloadConfig,
    openFile,
  } = usePilotDeckConfig();

  // View mode persists across mounts so power users who prefer the textarea
  // don't get bumped back to form-mode every time they re-open Settings.
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof localStorage === 'undefined') return 'form';
    return (localStorage.getItem('pilotdeck:configView') as ViewMode) || 'form';
  });
  useEffect(() => {
    try { localStorage.setItem('pilotdeck:configView', view); } catch { /* swallow */ }
  }, [view]);

  // Active form section. Keeping it local — sections aren't deep-linkable
  // since the surrounding modal already owns its own URL.
  const [activeSection, setActiveSection] = useState<SectionId>('runtime');

  // Parse `raw` into a typed config for the form. Memoised so we don't
  // reparse on every keystroke unrelated to YAML, but raw IS the source of
  // truth — every form patch reserialises back into raw, which keeps the
  // existing save/watcher pipeline (and hot-reload) functional unchanged.
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const parseError = !parsedConfig && raw.trim().length > 0;

  // Form patches: take the next config, stringify back into YAML, push into
  // the existing `setRaw`. This is what keeps the save+reload pipeline a
  // single code path: server-side validation, watcher debouncing, and
  // subsystem hot-reload all work whether the edit came from the form, the
  // textarea, or an external editor.
  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
    } catch (caught) {
      // Should be unreachable — every patch produces a serializable shape.
      // Fall through silently; the existing error banner will surface any
      // server-side problem on save.
      console.error('Failed to serialise config patch', caught);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('edgeClawConfig.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header card: file path, view-mode toggle, reveal/refresh actions. */}
      <SettingsCard className="space-y-3 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FileCog className="h-4 w-4" />
              {exists ? t('edgeClawConfig.header.configFile') : t('edgeClawConfig.header.configPreview')}
              {isDirty && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  {t('edgeClawConfig.header.unsaved')}
                </span>
              )}
            </div>
            <code className="mt-1 block truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
              {path}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Mode pill — Form / Raw YAML. Same visual idiom Cursor uses
                for its "Edit in JSON" affordance. */}
            <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
              <button
                type="button"
                onClick={() => setView('form')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs',
                  view === 'form' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutList className="h-3.5 w-3.5" />
                {t('edgeClawConfig.viewMode.form')}
              </button>
              <button
                type="button"
                onClick={() => setView('raw')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs',
                  view === 'raw' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                {t('edgeClawConfig.viewMode.rawYaml')}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={openFile} disabled={opening}>
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {opening ? t('edgeClawConfig.actions.opening') : t('edgeClawConfig.actions.revealFile')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('edgeClawConfig.actions.refresh')}
            </Button>
          </div>
        </div>

        {/* External-change banner — relevant in both views. */}
        {externalChangeNotice && view === 'form' && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <div className="flex-1">{externalChangeNotice}</div>
            <button
              type="button"
              onClick={dismissExternalNotice}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
            >
              Dismiss
            </button>
          </div>
        )}
        {parseError && view === 'form' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            YAML on disk failed to parse — switch to Raw YAML to fix it.
          </div>
        )}
      </SettingsCard>

      {view === 'form' ? (
        // Form-mode body: split nav (left) + sections (right). On narrow
        // viewports nav becomes a horizontal scroller above the body so we
        // never hide it behind a hamburger.
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr]">
          <aside className="md:sticky md:top-0 md:self-start">
            <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    'whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors md:whitespace-normal',
                    activeSection === s.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  {t(`edgeClawConfig.sections.${s.labelKey}.label`)}
                </button>
              ))}
            </nav>
          </aside>
          <main className="min-w-0 space-y-6">
            {parsedConfig ? (
              <>
                {activeSection === 'runtime' && <RuntimeSection config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'models'  && <ModelsSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'agents'  && <AgentsSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'customEnv' && <CustomEnvSection config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'alwaysOn' && <AlwaysOnSection config={parsedConfig} projects={projects} onChange={onFormChange} />}
                {activeSection === 'memory'  && <MemorySection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'router'  && <RouterSection  config={parsedConfig} onChange={onFormChange} />}
                {activeSection === 'gateway' && <GatewaySection config={parsedConfig} onChange={onFormChange} />}
              </>
            ) : (
              <SettingsCard className="p-6 text-sm text-muted-foreground">
                Could not parse the YAML on disk. Switch to <strong className="font-medium text-foreground">Raw YAML</strong> to inspect and fix it.
              </SettingsCard>
            )}

            {/* Validation summary lives below the form so users see it after
                tweaking values. Errors/warnings are server-validated — not a
                client mirror — so this stays accurate for cross-section
                rules (e.g. agents.main.model must reference a known entry). */}
            <div className="space-y-2">
              {validation?.valid ? (
                <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Config is valid {isDirty && <span className="text-muted-foreground">(unsaved)</span>}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Config has validation errors — see below
                </div>
              )}
              {validation && validation.errors.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-destructive">
                  {validation.errors.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {validation && validation.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-4 text-xs text-amber-600 dark:text-amber-400">
                  {validation.warnings.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
              {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              {message && <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">{message}</div>}
            </div>
          </main>
        </div>
      ) : (
        <RawYamlView
          raw={raw}
          setRaw={setRaw}
          validation={validation}
          error={error}
          message={message}
          isDirty={isDirty}
          externalChangeNotice={externalChangeNotice}
          dismissExternalNotice={dismissExternalNotice}
        />
      )}

      {/* Subsystem reload card — same in both modes, stays at the bottom so
          users always see the impact of their last save. */}
      <SettingsSection
        title="Subsystem reload status"
        description={lastReloadInfo
          ? `Last reload: ${sourceLabel(lastReloadInfo.source)} at ${new Date(lastReloadInfo.at).toLocaleTimeString()}`
          : 'Reload status will appear after the first save or external edit.'}
      >
        <SettingsCard className="p-4">
          <ReloadSummary reload={reload} />
        </SettingsCard>
      </SettingsSection>

      {/* Sticky save bar. Save & Reload routes through the same PUT endpoint
          regardless of which view edited `raw` — that's how form edits and
          textarea edits both pick up the unified hot-reload. */}
      <div className="sticky bottom-0 flex items-center justify-end gap-2 rounded-xl border border-border bg-card/90 p-3 backdrop-blur">
        <Button variant="outline" size="sm" onClick={reloadConfig} disabled={saving}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Reload current
        </Button>
        <Button size="sm" onClick={save} disabled={saving || !isDirty}>
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {saving ? 'Saving...' : 'Save & reload'}
        </Button>
      </div>
    </div>
  );
}
