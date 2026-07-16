import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileCog,
  FileText,
  FolderOpen,
  Gauge,
  Image as ImageIcon,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  Server,
  Trash2,
  Upload,
  Wifi,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import { isImeEnterEvent } from '../../../../utils/ime';
import {
  normalizeOfficePreviewService,
  readOfficePreviewStatus,
  type OfficePreviewService,
  type OfficePreviewStatus,
} from '../../../../utils/officePreviewStatus';
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
import {
  CATALOG_PROVIDERS,
  findCatalogProviderById,
  type CatalogProvider,
  type CatalogProviderProtocol,
  type CatalogModel,
} from '../../../../shared/catalogProviders';
import { fetchProviderModels, fetchRemoteDefaultModels, type ApiModelListItem } from '../../../../shared/modelListApi';
import type { SettingsProject } from '../../types/types';
import { isCronConfigEnabled, patch } from './pilotDeckConfigForm';

// ── V2 schema types ────────────────────────────────────────────────────
// Schema mirrors ~/.pilotdeck/pilotdeck.yaml exactly. No more
// pre-/post-translation in the backend — disk shape === UI shape.

type MemoryReasoningMode = 'answer_first' | 'accuracy_first';

type V2Provider = {
  protocol?: CatalogProviderProtocol;
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  models?: Record<string, Record<string, unknown> | null>;
  retry?: {
    requestMaxRetries?: number;
    streamMaxRetries?: number;
    streamIdleTimeoutMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

type PilotDeckConfig = {
  schemaVersion?: number;
  agent?: {
    model?: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    params?: Record<string, unknown>;
    subagents?: { default?: string; params?: Record<string, unknown> };
  };
  model?: {
    providers?: Record<string, V2Provider>;
  };
  memory?: {
    enabled?: boolean;
    model?: string;
    apiType?: string;
    reasoningMode?: MemoryReasoningMode;
    autoIndexIntervalMinutes?: number;
    autoDreamIntervalMinutes?: number;
    captureStrategy?: string;
    includeAssistant?: boolean;
    maxMessageChars?: number;
    heartbeatBatchSize?: number;
  };
  proxy?: {
    url?: string;
    noProxy?: string;
  };
  webui?: {
    runtime?: {
      host?: string;
      serverPort?: number;
      vitePort?: number;
      apiTimeoutMs?: number;
      databasePath?: string;
      workspacesRoot?: string;
    };
    officePreview?: {
      service?: 'none' | 'libreoffice' | string;
      binaryPath?: string;
    };
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
      maxPlansPerCycle?: number;
    };
    execution?: {
      maxTurns?: number;
      maxToolCalls?: number;
      timeoutMinutes?: number;
    };
    projects?: Record<string, { enabled?: boolean }>;
  };
  cron?: {
    enabled?: boolean;
    timezone?: string;
    maxConcurrentRuns?: number;
  };
  customEnv?: Record<string, string>;
  router?: {
    enabled?: boolean;
    scenarios?: Record<string, string>;
    fallback?: Record<string, string[]>;
    zeroUsageRetry?: {
      enabled?: boolean;
      maxAttempts?: number;
    };
    transientRetry?: {
      enabled?: boolean;
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
    tokenSaver?: {
      enabled?: boolean;
      judge?: string;
      defaultTier?: string;
      judgeTimeoutMs?: number;
      tiers?: Record<string, { model?: string; description?: string }>;
      rules?: string[];
      subagent?: { policy?: string };
    };
    autoOrchestrate?: {
      enabled?: boolean;
      triggerTiers?: string[];
      slimSystemPrompt?: boolean;
    };
    stats?: {
      enabled?: boolean;
      modelPricing?: Record<string, { input?: number; output?: number; cacheRead?: number }>;
    };
  } & Record<string, unknown>;
  gateway?: { enabled?: boolean; home?: string } & Record<string, unknown>;
  tools?: {
    webSearch?: {
      provider?: 'glm' | 'tavily' | 'custom';
      apiKey?: string;
      endpoint?: string;
      customProvider?: {
        name?: string;
        auth?: 'bearer' | 'bodyApiKey' | 'queryApiKey' | 'none';
        method?: 'GET' | 'POST';
        queryParam?: string;
        apiKeyParam?: string;
        resultsPath?: string;
        titleField?: string;
        urlField?: string;
        snippetField?: string;
        sourceField?: string;
        publishedAtField?: string;
      };
    };
  };
};

type SectionId = 'models' | 'agents' | 'memory' | 'tools' | 'router' | 'gateway' | 'officePreview' | 'customEnv' | 'alwaysOn' | 'cron' | 'advanced';

const SECTIONS: Array<{ id: SectionId; labelKey: string; descriptionKey: string }> = [
  { id: 'advanced',  labelKey: 'runtime',   descriptionKey: 'runtime' },
  { id: 'models',    labelKey: 'models',    descriptionKey: 'models' },
  { id: 'agents',    labelKey: 'agents',    descriptionKey: 'agents' },
  { id: 'alwaysOn',  labelKey: 'alwaysOn',  descriptionKey: 'alwaysOn' },
  { id: 'cron',      labelKey: 'cron',      descriptionKey: 'cron' },
  { id: 'memory',    labelKey: 'memory',    descriptionKey: 'memory' },
  { id: 'tools',     labelKey: 'tools',     descriptionKey: 'tools' },
  { id: 'router',    labelKey: 'router',    descriptionKey: 'router' },
  { id: 'gateway',   labelKey: 'gateway',   descriptionKey: 'gateway' },
  { id: 'officePreview', labelKey: 'officePreview', descriptionKey: 'officePreview' },
  { id: 'customEnv', labelKey: 'customEnv', descriptionKey: 'customEnv' },
];

const SECTION_GROUPS: Array<{ id: 'basic' | 'features' | 'extensions' | 'advanced'; sections: SectionId[] }> = [
  { id: 'basic', sections: ['models', 'agents'] },
  { id: 'features', sections: ['router', 'memory', 'tools', 'alwaysOn', 'cron', 'gateway'] },
  { id: 'extensions', sections: ['officePreview'] },
  { id: 'advanced', sections: ['advanced', 'customEnv'] },
];

const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  models: Database,
  agents: Bot,
  router: Route,
  memory: Brain,
  tools: Search,
  alwaysOn: Zap,
  cron: Clock,
  gateway: Wifi,
  officePreview: FileText,
  advanced: Server,
  customEnv: FileCog,
};

// ── Config status presentation ──────────────────────────────────────────

type SubsystemKey = 'processEnv' | 'memory' | 'router' | 'gateway';
type StatusState = 'ok' | 'skipped' | 'error' | 'unknown';

type SubsystemResult = {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
};

const STATUS_ITEMS: Array<{ key: SubsystemKey; labelKey: string }> = [
  { key: 'processEnv', labelKey: 'processEnv' },
  { key: 'memory', labelKey: 'memory' },
  { key: 'router', labelKey: 'router' },
  { key: 'gateway', labelKey: 'gateway' },
];

function classifySubsystem(result: SubsystemResult | undefined): StatusState {
  if (!result) return 'unknown';
  if (result.error) return 'error';
  if (result.reloaded) return 'ok';
  if (result.skipped) return 'skipped';
  return 'unknown';
}

function statusDotClasses(state: StatusState): string {
  if (state === 'ok') return 'bg-green-500';
  if (state === 'error') return 'bg-destructive';
  return 'bg-muted-foreground/60';
}

function fallbackSubsystemStatus(key: SubsystemKey, config: PilotDeckConfig | null): { state: StatusState; detailKey: string } {
  if (!config) {
    return { state: 'unknown', detailKey: 'pending' };
  }
  if (key === 'processEnv') {
    return { state: 'ok', detailKey: 'processEnv.applied' };
  }
  if (key === 'memory') {
    return config?.memory?.enabled === false
      ? { state: 'skipped', detailKey: 'memory.disabled' }
      : { state: 'ok', detailKey: 'memory.enabled' };
  }
  if (key === 'router') {
    return config?.router?.enabled === false
      ? { state: 'skipped', detailKey: 'router.disabled' }
      : { state: 'ok', detailKey: 'router.enabled' };
  }
  return config?.gateway?.enabled
    ? { state: 'ok', detailKey: 'gateway.enabled' }
    : { state: 'skipped', detailKey: 'gateway.disabled' };
}

function subsystemStatus(key: SubsystemKey, config: PilotDeckConfig | null, reload: ConfigReload | null): { state: StatusState; detailKey: string; detail?: string } {
  const fallback = fallbackSubsystemStatus(key, config);
  const result = reload?.[key] as SubsystemResult | undefined;

  if (!result) return fallback;
  if (result.error) return { state: 'error', detailKey: fallback.detailKey, detail: result.error };
  if ((key === 'memory' || key === 'router' || key === 'gateway') && fallback.state === 'skipped') {
    return fallback;
  }

  const state = classifySubsystem(result);
  if (state === 'unknown') return fallback;
  if (state === 'skipped') return fallback;
  return { state, detailKey: fallback.detailKey, detail: result.note };
}

function ConfigStatusGrid({
  config,
  reload,
}: {
  config: PilotDeckConfig | null;
  reload: ConfigReload | null;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {STATUS_ITEMS.map((item) => {
        const status = subsystemStatus(item.key, config, reload);
        return (
          <div key={item.key} className="rounded-lg bg-muted/30 px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-[13px] font-semibold leading-5 text-foreground">
              <span className={cn('h-2.5 w-2.5 rounded-full', statusDotClasses(status.state))} />
              <span>{t(`pilotDeckConfig.status.subsystems.${item.labelKey}.label`)}</span>
            </div>
            <div className={cn('mt-0.5 text-[11px] leading-4', status.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {status.detail ?? t(`pilotDeckConfig.status.subsystems.${status.detailKey}`)}
            </div>
          </div>
        );
      })}
    </div>
  );
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

function rewriteProviderRef(value: unknown, oldProviderId: string, newProviderId: string): unknown {
  const oldPrefix = `${oldProviderId}/`;
  if (typeof value !== 'string' || !value.startsWith(oldPrefix)) return value;
  return `${newProviderId}/${value.slice(oldPrefix.length)}`;
}

function rewriteProviderRefs(config: PilotDeckConfig, oldProviderId: string, newProviderId: string): PilotDeckConfig {
  let next = config;

  const agentModel = rewriteProviderRef(next.agent?.model, oldProviderId, newProviderId);
  if (agentModel !== next.agent?.model) {
    next = patch(next, ['agent', 'model'], agentModel);
  }

  const subagentDefault = rewriteProviderRef(next.agent?.subagents?.default, oldProviderId, newProviderId);
  if (subagentDefault !== next.agent?.subagents?.default) {
    next = patch(next, ['agent', 'subagents', 'default'], subagentDefault);
  }

  const memoryModel = rewriteProviderRef(next.memory?.model, oldProviderId, newProviderId);
  if (memoryModel !== next.memory?.model) {
    next = patch(next, ['memory', 'model'], memoryModel);
  }

  const memoryLlm = (next.memory as Record<string, unknown> | undefined)?.llm;
  if (memoryLlm && typeof memoryLlm === 'object' && !Array.isArray(memoryLlm)) {
    const llm = memoryLlm as Record<string, unknown>;
    if (llm.provider === oldProviderId) {
      next = patch(next, ['memory', 'llm', 'provider'], newProviderId);
    }
  }

  const scenarios = next.router?.scenarios;
  if (scenarios) {
    const rewritten = Object.fromEntries(
      Object.entries(scenarios).map(([key, ref]) => [key, rewriteProviderRef(ref, oldProviderId, newProviderId) as string]),
    );
    if (Object.entries(scenarios).some(([key, ref]) => rewritten[key] !== ref)) {
      next = patch(next, ['router', 'scenarios'], rewritten);
    }
  }

  const fallback = next.router?.fallback;
  if (fallback) {
    const rewritten = Object.fromEntries(
      Object.entries(fallback).map(([key, refs]) => [
        key,
        refs.map((ref) => rewriteProviderRef(ref, oldProviderId, newProviderId) as string),
      ]),
    );
    if (Object.entries(fallback).some(([key, refs]) => rewritten[key].some((ref, index) => ref !== refs[index]))) {
      next = patch(next, ['router', 'fallback'], rewritten);
    }
  }

  const judge = rewriteProviderRef(next.router?.tokenSaver?.judge, oldProviderId, newProviderId);
  if (judge !== next.router?.tokenSaver?.judge) {
    next = patch(next, ['router', 'tokenSaver', 'judge'], judge);
  }

  const tiers = next.router?.tokenSaver?.tiers;
  if (tiers) {
    const rewritten = Object.fromEntries(
      Object.entries(tiers).map(([key, tier]) => [
        key,
        {
          ...tier,
          model: rewriteProviderRef(tier.model, oldProviderId, newProviderId) as string | undefined,
        },
      ]),
    );
    if (Object.entries(tiers).some(([key, tier]) => rewritten[key].model !== tier.model)) {
      next = patch(next, ['router', 'tokenSaver', 'tiers'], rewritten);
    }
  }

  return next;
}

function replaceFallbackModelRef(config: PilotDeckConfig, oldRef: string, newRef: string): PilotDeckConfig {
  const fallback = config.router?.fallback;
  if (!fallback || !oldRef || oldRef === newRef) return config;

  let changed = false;
  const rewritten = Object.fromEntries(
    Object.entries(fallback).map(([key, refs]) => {
      const nextRefs = refs.map((ref) => {
        if (ref !== oldRef) return ref;
        changed = true;
        return newRef;
      });
      return [key, nextRefs];
    }),
  );

  return changed ? patch(config, ['router', 'fallback'], rewritten) : config;
}

const MASK = '********';

function isMaskedSecret(value: string | undefined): boolean {
  return value === MASK;
}

/** Password fields must not bind MASK/placeholders as value — browsers render them as bullets. */
function secretDisplayValue(value: string | undefined): string {
  if (!value) return '';
  if (isMaskedSecret(value)) return '';
  if (value === 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE') return '';
  if (value.startsWith('PLACEHOLDER_')) return '';
  return value;
}

function hasUsableSecret(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return Boolean(trimmed) && !isMaskedSecret(trimmed) && trimmed !== 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE' && !trimmed.startsWith('PLACEHOLDER_');
}

function providerDisplayName(providerId: string, catalogEntry?: CatalogProvider, emptyFallback = 'Custom Provider'): string {
  if (catalogEntry?.displayName) return catalogEntry.displayName;
  const normalized = providerId.trim();
  if (!normalized) return emptyFallback;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

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
        'w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none',
        'focus:ring-1 focus:ring-ring',
        monospace && 'font-mono text-xs',
        className,
      )}
    />
  );
}

function SecretTextInput({
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
      placeholder={placeholder ?? (masked ? (maskedPlaceholder ?? 'Existing key kept — type to replace') : emptyPlaceholder)}
      monospace={monospace}
      className={className}
      onChange={onChange}
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
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  const selectedOption = options.find((opt) => opt.value === value);
  const selectedLabel = selectedOption?.label ?? '';
  return (
    <div className="relative min-w-0">
      <div className={cn(
        'pointer-events-none flex w-full min-w-0 items-center rounded-md border border-border bg-background px-2 py-1.5 pr-8 text-[13px] leading-5',
        selectedOption?.disabled ? 'text-muted-foreground' : 'text-foreground',
      )}>
        <span className="block min-w-0 truncate" title={selectedLabel}>{selectedLabel}</span>
      </div>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">▾</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={selectedLabel}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function ModelRefInput({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  const selected = value ?? '';
  const hasSelected = !selected || options.some((opt) => opt.value === selected);
  const selectOptions = [
    { value: '', label: placeholder ?? 'Select a configured model' },
    ...options,
    ...(!hasSelected ? [{ value: selected, label: `Missing: ${selected}` }] : []),
  ];
  return (
    <Select value={selected} onChange={onChange} options={selectOptions} />
  );
}

function FormRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 px-4 py-2.5 sm:grid-cols-[180px_1fr] sm:gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5 text-foreground">{label}</div>
        {description && <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── Section components ─────────────────────────────────────────────────

function getOfficePreviewService(config: PilotDeckConfig): OfficePreviewService {
  return normalizeOfficePreviewService(config.webui?.officePreview?.service);
}

function ServiceSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const r = config.webui?.runtime ?? {};
  const set = (key: string, value: unknown) =>
    onChange(patch(config, ['webui', 'runtime', key], value));
  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.runtime.title')}
      description={t('pilotDeckConfig.panels.runtime.description')}
    >
      <SettingsCard>
        <div className="divide-y divide-border">
          <FormRow label={t('pilotDeckConfig.panels.runtime.fields.host.label')} description={t('pilotDeckConfig.panels.runtime.fields.host.description')}>
            <TextInput value={r.host} placeholder="0.0.0.0" onChange={(v) => set('host', v)} />
          </FormRow>
          <FormRow label={t('pilotDeckConfig.panels.runtime.fields.serverPort.label')} description={t('pilotDeckConfig.panels.runtime.fields.serverPort.description')}>
            <NumberInput value={r.serverPort} placeholder="3001" onChange={(v) => set('serverPort', v)} />
          </FormRow>
          <FormRow label={t('pilotDeckConfig.panels.runtime.fields.workspacesRoot.label')} description={t('pilotDeckConfig.panels.runtime.fields.workspacesRoot.description')}>
            <TextInput value={r.workspacesRoot} placeholder="~" monospace onChange={(v) => set('workspacesRoot', v)} />
          </FormRow>
        </div>
        <div className="border-t border-border px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowAdvanced((next) => !next)}
            aria-expanded={showAdvanced}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-180')} />
            {t('pilotDeckConfig.panels.runtime.advancedToggle')}
          </button>
        </div>
        {showAdvanced && (
          <div className="divide-y divide-border border-t border-border">
            <FormRow label={t('pilotDeckConfig.panels.runtime.fields.vitePort.label')} description={t('pilotDeckConfig.panels.runtime.fields.vitePort.description')}>
              <NumberInput value={r.vitePort} placeholder="5173" onChange={(v) => set('vitePort', v)} />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.runtime.fields.apiTimeout.label')} description={t('pilotDeckConfig.panels.runtime.fields.apiTimeout.description')}>
              <NumberInput value={r.apiTimeoutMs} placeholder="120000" onChange={(v) => set('apiTimeoutMs', v)} />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.runtime.fields.databasePath.label')} description={t('pilotDeckConfig.panels.runtime.fields.databasePath.description')}>
              <TextInput value={r.databasePath} placeholder="~/.pilotdeck/auth.db" monospace onChange={(v) => set('databasePath', v)} />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.runtime.fields.proxyUrl.label')} description={t('pilotDeckConfig.panels.runtime.fields.proxyUrl.description')}>
              <TextInput value={config.proxy?.url} placeholder="http://127.0.0.1:7890" monospace onChange={(v) => onChange(patch(config, ['proxy', 'url'], v))} />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.runtime.fields.proxyNoProxy.label')} description={t('pilotDeckConfig.panels.runtime.fields.proxyNoProxy.description')}>
              <TextInput value={config.proxy?.noProxy} placeholder="127.0.0.1,localhost" monospace onChange={(v) => onChange(patch(config, ['proxy', 'noProxy'], v))} />
            </FormRow>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function OfficePreviewSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusReloadKey, setStatusReloadKey] = useState(0);
  const [scanListOpen, setScanListOpen] = useState(false);
  const service = getOfficePreviewService(config);

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);

    readOfficePreviewStatus({ refresh: statusReloadKey > 0 })
      .then((body: OfficePreviewStatus) => {
        if (cancelled) return;
        setStatus(body);
        setStatusError(body.statusError || null);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatusError(error.message || t('pilotDeckConfig.panels.officePreview.status.error'));
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [statusReloadKey, t]);

  const libreOfficeStatusKnown = status?.libreOffice?.available !== undefined;
  const libreOfficeAvailable = status?.libreOffice?.available === true;
  const libreOfficeUnavailable = !statusLoading && status?.libreOffice?.available === false;
  const showLibreOfficeStatus = service === 'libreoffice' && libreOfficeStatusKnown;
  const libreOfficeUnknown = showLibreOfficeStatus && !statusLoading && !statusError && !libreOfficeStatusKnown;
  const configuredBinaryPath = config.webui?.officePreview?.binaryPath ?? '';
  const detectedBinaryPaths = status?.libreOffice?.candidates ?? [];
  const setService = (next: OfficePreviewService) =>
    onChange(patch(config, ['webui', 'officePreview', 'service'], next));
  const setBinaryPath = (next: string) =>
    onChange(patch(config, ['webui', 'officePreview', 'binaryPath'], next));
  const selectBinaryPath = (next: string) => {
    setBinaryPath(next);
    setScanListOpen(false);
  };
  const scanLibreOfficePaths = () => {
    setScanListOpen(true);
    setStatusReloadKey((value) => value + 1);
  };

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.officePreview.title')}
      description={t('pilotDeckConfig.panels.officePreview.description')}
    >
      <SettingsCard>
        <div className="divide-y divide-border">
          <FormRow
            label={t('pilotDeckConfig.panels.officePreview.fields.service.label')}
            description={t('pilotDeckConfig.panels.officePreview.fields.service.description')}
          >
            <div className="max-w-xs">
              <Select
                value={service}
                onChange={(value) => setService(value as OfficePreviewService)}
                options={[
                  { value: 'none', label: t('pilotDeckConfig.panels.officePreview.options.none') },
                  {
                    value: 'libreoffice',
                    label: libreOfficeUnavailable
                      ? t('pilotDeckConfig.panels.officePreview.options.libreOfficeUnavailable')
                      : t('pilotDeckConfig.panels.officePreview.options.libreOffice'),
                  },
                ]}
              />
            </div>
          </FormRow>
          {service === 'libreoffice' && (
            <FormRow
              label={t('pilotDeckConfig.panels.officePreview.fields.binaryPath.label')}
              description={t('pilotDeckConfig.panels.officePreview.fields.binaryPath.description')}
            >
              <div className="relative space-y-2">
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <TextInput
                      value={configuredBinaryPath}
                      placeholder={t('pilotDeckConfig.panels.officePreview.fields.binaryPath.placeholder')}
                      monospace
                      onChange={setBinaryPath}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={scanLibreOfficePaths}
                    className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', scanListOpen && statusLoading && 'animate-spin')} />
                    {t('pilotDeckConfig.panels.officePreview.scan.button')}
                  </button>
                </div>
                {scanListOpen && (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                    <div className="border-b border-border px-3 py-2 text-[12px] font-medium text-foreground">
                      {t('pilotDeckConfig.panels.officePreview.scan.title')}
                    </div>
                    <button
                      type="button"
                      onClick={() => selectBinaryPath('')}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] transition-colors hover:bg-accent"
                    >
                      <span className="min-w-0 truncate text-foreground">
                        {t('pilotDeckConfig.panels.officePreview.options.autoDetect')}
                      </span>
                      {!configuredBinaryPath && <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />}
                    </button>
                    {statusLoading ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        {t('pilotDeckConfig.panels.officePreview.scan.scanning')}
                      </div>
                    ) : detectedBinaryPaths.length > 0 ? (
                      <div className="max-h-64 overflow-auto border-t border-border">
                        {detectedBinaryPaths.map((candidate) => (
                          <button
                            key={candidate.binaryPath}
                            type="button"
                            disabled={!candidate.available}
                            onClick={() => selectBinaryPath(candidate.binaryPath)}
                            className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-mono text-[11px] text-foreground" title={candidate.binaryPath}>
                                {candidate.binaryPath}
                              </span>
                              <span className={cn(
                                'mt-0.5 block truncate text-[11px]',
                                candidate.available ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground',
                              )}>
                                {candidate.available
                                  ? t('pilotDeckConfig.panels.officePreview.options.candidateAvailableShort')
                                  : t('pilotDeckConfig.panels.officePreview.options.candidateUnavailableShort')}
                                {candidate.version ? ` · ${candidate.version}` : ''}
                              </span>
                            </span>
                            {configuredBinaryPath === candidate.binaryPath && (
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="border-t border-border px-3 py-3 text-[12px] leading-5 text-muted-foreground">
                        {t('pilotDeckConfig.panels.officePreview.status.noDetectedPaths')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </FormRow>
          )}

          <div className="space-y-2 px-4 py-3">
            {showLibreOfficeStatus && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
                  <span className={cn(
                    'h-2 w-2 flex-shrink-0 rounded-full',
                    libreOfficeAvailable ? 'bg-green-500' : libreOfficeUnavailable || statusError ? 'bg-muted-foreground/60' : 'bg-amber-500',
                  )} />
                  <span className="min-w-0 truncate">
                    {statusLoading
                      ? t('pilotDeckConfig.panels.officePreview.status.checking')
                      : statusError
                        ? t('pilotDeckConfig.panels.officePreview.status.error')
                        : libreOfficeAvailable
                          ? t('pilotDeckConfig.panels.officePreview.status.available')
                          : libreOfficeUnavailable
                            ? t('pilotDeckConfig.panels.officePreview.status.unavailable')
                            : libreOfficeUnknown
                              ? t('pilotDeckConfig.panels.officePreview.status.unknown')
                              : t('pilotDeckConfig.panels.officePreview.status.unavailable')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setStatusReloadKey((value) => value + 1)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', statusLoading && 'animate-spin')} />
                  {t('pilotDeckConfig.panels.officePreview.status.refresh')}
                </button>
              </div>
            )}

            {service === 'libreoffice' && libreOfficeAvailable && (
              <div className="space-y-1 rounded-md bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                {status?.libreOffice?.binaryPath && (
                  <div className="truncate" title={status.libreOffice.binaryPath}>
                    {t('pilotDeckConfig.panels.officePreview.status.path', { path: status.libreOffice.binaryPath })}
                  </div>
                )}
                {status?.libreOffice?.version && (
                  <div className="truncate" title={status.libreOffice.version}>
                    {t('pilotDeckConfig.panels.officePreview.status.version', { version: status.libreOffice.version })}
                  </div>
                )}
              </div>
            )}

            {service === 'none' && (
              <div className="rounded-md bg-muted/30 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
                {t('pilotDeckConfig.panels.officePreview.disabledNote')}
              </div>
            )}

            {service === 'libreoffice' && libreOfficeUnavailable && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>{t('pilotDeckConfig.panels.officePreview.unavailableWarning')}</div>
              </div>
            )}

            {service === 'libreoffice' && statusError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
                {statusError}
              </div>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function ProviderCard({
  providerId,
  provider,
  onChange,
  onRemove,
  onRename,
  catalogEntry,
}: {
  providerId: string;
  provider: V2Provider;
  onChange: (next: V2Provider) => void;
  onRemove: () => void;
  onRename: (newId: string) => boolean;
  catalogEntry?: CatalogProvider;
}) {
  const { t } = useTranslation('settings');
  const isMaskedKey = isMaskedSecret(provider.apiKey);
  const protocol = provider.protocol ?? catalogEntry?.protocol ?? 'openai';
  const effectiveUrl = provider.url || catalogEntry?.defaultUrl || '';
  const enabledModels = Object.keys(provider.models ?? {});
  const [newModelId, setNewModelId] = useState('');
  const [showProviderAdvanced, setShowProviderAdvanced] = useState(false);
  const [providerIdDraft, setProviderIdDraft] = useState(providerId);
  const [providerIdError, setProviderIdError] = useState('');
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [apiModelsStatus, setApiModelsStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [apiModelsError, setApiModelsError] = useState('');
  const displayName = providerDisplayName(
    providerIdDraft || providerId,
    catalogEntry,
    t('pilotDeckConfig.panels.models.customProvider'),
  );

  useEffect(() => {
    setProviderIdDraft(providerId);
    setProviderIdError('');
  }, [providerId]);

  const update = (patch: Partial<V2Provider>) => onChange({ ...provider, ...patch });
  const commitProviderId = () => {
    const nextId = providerIdDraft.trim();
    if (!nextId || nextId === providerId) {
      setProviderIdDraft(providerId);
      setProviderIdError('');
      return;
    }
    if (onRename(nextId)) {
      setProviderIdError('');
    } else {
      setProviderIdDraft(providerId);
      setProviderIdError(t('pilotDeckConfig.panels.models.providerIdDuplicate'));
    }
  };

  const addModel = (mid: string) => {
    const id = mid.trim();
    if (!id) return;
    if (provider.models && id in provider.models) return;
    update({ models: { ...(provider.models ?? {}), [id]: {} } });
    setNewModelId('');
  };
  const removeModel = (mid: string) => {
    const next = { ...(provider.models ?? {}) };
    delete next[mid];
    update({ models: next });
  };
  const toggleCatalogModel = (mid: string) => {
    if (provider.models && mid in provider.models) {
      removeModel(mid);
    } else {
      addModel(mid);
    }
  };
  const visibleModels: Array<ApiModelListItem | CatalogModel> = apiModels ?? catalogEntry?.models ?? [];
  const hasProviderApiKey = Boolean(provider.apiKey) && !isMaskedKey;
  const canFetchModels = Boolean(effectiveUrl);
  const refreshModels = async () => {
    if (!canFetchModels) return;
    setApiModelsStatus('loading');
    setApiModelsError('');
    try {
      const models = hasProviderApiKey || !catalogEntry || ![catalogEntry.defaultUrl, catalogEntry.modelListUrl].includes(effectiveUrl)
        ? await fetchProviderModels({ protocol, baseUrl: effectiveUrl, apiKey: hasProviderApiKey ? provider.apiKey : '', providerId })
        : await fetchRemoteDefaultModels(providerId);
      setApiModels(!hasProviderApiKey && catalogEntry && models.length === 0 ? catalogEntry.models : models);
      setApiModelsStatus('idle');
    } catch (error) {
      setApiModelsStatus('error');
      setApiModelsError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!catalogEntry || hasProviderApiKey) return;
    const catalogModels = catalogEntry.models;
    const controller = new AbortController();
    setApiModelsStatus('loading');
    setApiModelsError('');
    fetchRemoteDefaultModels(providerId)
      .then((models) => {
        if (controller.signal.aborted) return;
        setApiModels(models.length > 0 ? models : catalogModels);
        setApiModelsStatus('idle');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setApiModels(catalogModels);
        setApiModelsStatus('idle');
        const message = error instanceof Error ? error.message : String(error);
        setApiModelsError(`Using bundled model list. Remote model list unavailable: ${message}`);
      });
    return () => controller.abort();
  }, [catalogEntry, hasProviderApiKey, providerId]);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4 transition-colors">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{displayName}</div>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t('pilotDeckConfig.panels.models.providerId')}</span>
            <input
              value={providerIdDraft}
              onChange={(e) => {
                setProviderIdDraft(e.target.value);
                setProviderIdError('');
              }}
              onBlur={commitProviderId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                  setProviderIdDraft(providerId);
                  setProviderIdError('');
                  e.currentTarget.blur();
                }
              }}
              className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {providerIdError && (
            <div className="mt-1 text-[10px] text-destructive">{providerIdError}</div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">{t('pilotDeckConfig.panels.models.protocol')}</span>
          <Select
            value={protocol}
            onChange={(v) => update({ protocol: v as CatalogProviderProtocol })}
            options={[
              { value: 'openai',    label: t('pilotDeckConfig.panels.models.protocolOptions.openai') },
              { value: 'openai-responses', label: t('pilotDeckConfig.panels.models.protocolOptions.openaiResponses') },
              { value: 'anthropic', label: t('pilotDeckConfig.panels.models.protocolOptions.anthropic') },
              { value: 'google',    label: t('pilotDeckConfig.panels.models.protocolOptions.google') },
            ]}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="mb-1 block">{t('pilotDeckConfig.panels.models.baseUrl')}</span>
          <TextInput
            value={provider.url}
            placeholder={catalogEntry?.defaultUrl || 'https://api.example.com/v1'}
            monospace
            onChange={(v) => update({ url: v })}
          />
          <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
            {t('pilotDeckConfig.panels.models.baseUrlHint')}
          </span>
          {!provider.url && catalogEntry && (
            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
              {t('pilotDeckConfig.panels.models.defaultsTo')}{' '}
              <code className="font-mono">{catalogEntry.defaultUrl}</code>
              {' '}{t('pilotDeckConfig.panels.models.fromCatalog')}
            </span>
          )}
          {effectiveUrl && provider.url && (
            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
              {t('pilotDeckConfig.panels.models.effective')}{' '}
              <code className="font-mono">{effectiveUrl}</code>
            </span>
          )}
        </label>
      </div>

      {/* API key — the only required field */}
      <label className="block text-xs text-muted-foreground">
        <span className="mb-1 block">{t('pilotDeckConfig.panels.models.apiKey')}</span>
        <SecretTextInput
          value={provider.apiKey}
          emptyPlaceholder="sk-..."
          maskedPlaceholder={t('pilotDeckConfig.panels.models.maskedKeyPlaceholder')}
          onChange={(v) => update({ apiKey: v })}
        />
        {isMaskedKey && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" />
            {t('pilotDeckConfig.panels.models.keyHidden')}
          </span>
        )}
      </label>

      {/* Models — chip-style toggles for catalog models + a free-form input. */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{t('pilotDeckConfig.panels.models.enabledModels')}</span>
          <span className="text-[10px] text-muted-foreground/60">
            · <ImageIcon className="inline h-2.5 w-2.5" /> {t('pilotDeckConfig.panels.models.supportsImageInput')}
          </span>
          <button
            type="button"
            onClick={refreshModels}
            disabled={!canFetchModels || apiModelsStatus === 'loading'}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn('h-2.5 w-2.5', apiModelsStatus === 'loading' && 'animate-spin')} />
            {hasProviderApiKey || !catalogEntry ? 'Fetch API models' : 'Fetch remote models'}
          </button>
        </div>
        {apiModelsStatus === 'error' && apiModelsError && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
            {apiModelsError}
          </div>
        )}
        {apiModelsStatus === 'idle' && apiModelsError && (
          <div className="mb-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
            {apiModelsError}
          </div>
        )}
        {visibleModels.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {visibleModels.map((m) => {
              const on = provider.models && m.id in provider.models;
              return (
                <div
                  key={m.id}
                  className={cn(
                    'group inline-flex items-center rounded-md border text-[11px] transition-colors',
                    on
                      ? 'border-foreground/30 bg-muted/60 text-foreground'
                      : 'border-border bg-muted text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleCatalogModel(m.id)}
                    className="inline-flex items-center gap-1 px-2 py-1"
                    title={on ? t('pilotDeckConfig.panels.models.clickDisable') : t('pilotDeckConfig.panels.models.clickEnable')}
                  >
                    {on && <Check className="h-3 w-3 text-foreground" strokeWidth={2.5} />}
                    {m.displayName}
                    {'supportsImage' in m && m.supportsImage && (
                      <ImageIcon
                        className="h-3 w-3 text-muted-foreground/70"
                        strokeWidth={2}
                      />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {/* Custom (off-catalog) models currently enabled */}
        {enabledModels.filter((mid) => !visibleModels.some((m) => m.id === mid)).map((mid) => {
          return (
            <div key={mid} className="mb-1 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]">
              <code className="flex-1 truncate font-mono">{mid}</code>
              <button
                type="button"
                onClick={() => removeModel(mid)}
                className="text-muted-foreground hover:text-destructive"
                title={t('pilotDeckConfig.actions.remove')}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {/* Add custom model */}
        <div className="flex items-center gap-2">
          <input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder={t('pilotDeckConfig.panels.models.customModelPlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addModel(newModelId); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => addModel(newModelId)} disabled={!newModelId.trim()}>
            <Plus className="mr-1 h-3 w-3" />
            {t('pilotDeckConfig.actions.add')}
          </Button>
        </div>
      </div>

      {/* ── Advanced (per-provider retry) ─────────────────────── */}
      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={() => setShowProviderAdvanced((v) => !v)}
          aria-expanded={showProviderAdvanced}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showProviderAdvanced && 'rotate-180')} />
          {t('pilotDeckConfig.panels.models.providerAdvancedToggle')}
        </button>
        {showProviderAdvanced && (
          <div className="mt-3 space-y-3 divide-y divide-border rounded-md border border-border p-3">
            <FormRow label={t('pilotDeckConfig.panels.models.providerRetry.requestMaxRetries.label')} description={t('pilotDeckConfig.panels.models.providerRetry.requestMaxRetries.description')}>
              <NumberInput
                value={provider.retry?.requestMaxRetries}
                placeholder="2"
                onChange={(v) => onChange({ ...provider, retry: { ...provider.retry, requestMaxRetries: v } })}
              />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.models.providerRetry.streamMaxRetries.label')} description={t('pilotDeckConfig.panels.models.providerRetry.streamMaxRetries.description')}>
              <NumberInput
                value={provider.retry?.streamMaxRetries}
                placeholder="3"
                onChange={(v) => onChange({ ...provider, retry: { ...provider.retry, streamMaxRetries: v } })}
              />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.models.providerRetry.streamIdleTimeoutMs.label')} description={t('pilotDeckConfig.panels.models.providerRetry.streamIdleTimeoutMs.description')}>
              <NumberInput
                value={provider.retry?.streamIdleTimeoutMs}
                placeholder="30000"
                onChange={(v) => onChange({ ...provider, retry: { ...provider.retry, streamIdleTimeoutMs: v } })}
              />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.models.providerRetry.baseDelayMs.label')} description={t('pilotDeckConfig.panels.models.providerRetry.baseDelayMs.description')}>
              <NumberInput
                value={provider.retry?.baseDelayMs}
                placeholder="1000"
                onChange={(v) => onChange({ ...provider, retry: { ...provider.retry, baseDelayMs: v } })}
              />
            </FormRow>
            <FormRow label={t('pilotDeckConfig.panels.models.providerRetry.maxDelayMs.label')} description={t('pilotDeckConfig.panels.models.providerRetry.maxDelayMs.description')}>
              <NumberInput
                value={provider.retry?.maxDelayMs}
                placeholder="60000"
                onChange={(v) => onChange({ ...provider, retry: { ...provider.retry, maxDelayMs: v } })}
              />
            </FormRow>
          </div>
        )}
      </div>
    </div>
  );
}

function CatalogPicker({
  existingIds,
  onPick,
  onCustom,
}: {
  existingIds: Set<string>;
  onPick: (catalog: CatalogProvider) => void;
  onCustom: () => void;
}) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const available = CATALOG_PROVIDERS.filter((p) => !existingIds.has(p.id));
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t('pilotDeckConfig.panels.models.addProvider')}
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">{t('pilotDeckConfig.panels.models.addProviderTitle')}</div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('pilotDeckConfig.panels.models.cancel')}</Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {available.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { onPick(p); setOpen(false); }}
            className="rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
          >
            <div className="font-medium text-foreground">{p.displayName}</div>
          </button>
        ))}
        <button
          type="button"
          onClick={() => { onCustom(); setOpen(false); }}
          className="rounded-md border border-dashed border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-foreground/40 hover:bg-muted"
        >
          <div className="font-medium text-foreground">+ {t('pilotDeckConfig.panels.models.customProvider')}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{t('pilotDeckConfig.panels.models.manualSetup')}</div>
        </button>
      </div>
    </div>
  );
}

function ModelsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const providers = config.model?.providers ?? {};
  const ids = Object.keys(providers);

  const setProvider = (id: string, prov: V2Provider) =>
    onChange(patch(config, ['model', 'providers', id], prov));
  const removeProvider = (id: string) => {
    const next = { ...providers };
    delete next[id];
    onChange(patch(config, ['model', 'providers'], next));
  };
  const renameProvider = (oldId: string, newId: string) => {
    const id = newId.trim();
    if (!id || id === oldId) return true;
    if (providers[id]) return false;
    const next: Record<string, V2Provider> = {};
    for (const [k, v] of Object.entries(providers)) next[k === oldId ? id : k] = v;
    onChange(rewriteProviderRefs(patch(config, ['model', 'providers'], next), oldId, id));
    return true;
  };

  const handleCatalogPick = (cp: CatalogProvider) => {
    if (providers[cp.id]) return;
    setProvider(cp.id, {
      apiKey: '',
      // protocol and url are stored explicitly so the saved yaml carries
      // them — backend catalog auto-fill kicks in only when the disk
      // value is missing, which is what we want for user-edited configs.
      protocol: cp.protocol,
      url: cp.defaultUrl,
      models: {},
    });
  };

  const handleCustom = () => {
    let i = 1;
    while (providers[`provider${i}`]) i++;
    setProvider(`provider${i}`, {
      protocol: 'openai',
      url: '',
      apiKey: '',
      models: {},
    });
  };

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.models.title')}
      description={t('pilotDeckConfig.panels.models.description')}
    >
      <div className="space-y-3">
        <div className="flex justify-start">
          <CatalogPicker
            existingIds={new Set(ids)}
            onPick={handleCatalogPick}
            onCustom={handleCustom}
          />
        </div>
        {ids.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('pilotDeckConfig.panels.models.emptyProviders')}
          </div>
        )}
        {ids.map((id) => (
          <ProviderCard
            key={id}
            providerId={id}
            provider={providers[id] ?? {}}
            catalogEntry={findCatalogProviderById(id)}
            onChange={(next) => setProvider(id, next)}
            onRemove={() => removeProvider(id)}
            onRename={(newId) => renameProvider(id, newId)}
          />
        ))}
      </div>
    </SettingsSection>
  );
}

function splitModelRef(ref: string | undefined): { providerId: string; modelId: string } | null {
  const value = ref?.trim() ?? '';
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function ensureModelRefConfigured<T extends PilotDeckConfig>(config: T, ref: string | undefined): T {
  const parsed = splitModelRef(ref);
  if (!parsed) return config;

  const provider = config.model?.providers?.[parsed.providerId];
  if (!provider) return config;
  if (provider.models && Object.prototype.hasOwnProperty.call(provider.models, parsed.modelId)) return config;

  return patch(config, ['model', 'providers', parsed.providerId, 'models', parsed.modelId], {});
}

function ensureModelRefsConfigured<T extends PilotDeckConfig>(config: T, refs: Array<string | undefined>): T {
  return refs.reduce((next, ref) => ensureModelRefConfigured(next, ref), config);
}

// Build the "provider/model" options for agent / memory / router model dropdowns
// from configured providers. Catalog providers expose every catalog model, while
// custom/off-catalog models come from the provider's saved models map.
function buildModelRefOptions(config: PilotDeckConfig): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const providers = config.model?.providers ?? {};
  for (const [pid, prov] of Object.entries(providers)) {
    const catalog = findCatalogProviderById(pid);
    const seen = new Set<string>();

    if (catalog) {
      for (const model of catalog.models) {
        seen.add(model.id);
        out.push({
          value: `${pid}/${model.id}`,
          label: `${catalog.displayName}: ${model.displayName}`,
        });
      }
    }

    for (const mid of Object.keys(prov.models ?? {})) {
      if (seen.has(mid)) continue;
      out.push({
        value: `${pid}/${mid}`,
        label: catalog ? `${catalog.displayName}: ${mid}` : `${pid}/${mid}`,
      });
    }
  }
  return out;
}

function defaultCapabilitiesForProtocol(protocol?: CatalogProviderProtocol): {
  maxContextTokens: number;
  maxOutputTokens: number;
} {
  if (protocol === 'google') {
    return { maxContextTokens: 1_048_576, maxOutputTokens: 65_536 };
  }
  if (protocol === 'anthropic') {
    return { maxContextTokens: 200_000, maxOutputTokens: 65_536 };
  }
  return { maxContextTokens: 128_000, maxOutputTokens: 65_536 };
}

function readPositiveCapability(capabilities: unknown, key: 'maxContextTokens' | 'maxOutputTokens'): number | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const value = (capabilities as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function activeModelCapabilities(config: PilotDeckConfig): {
  ref: string;
  providerId: string;
  modelId: string;
  catalogModel?: CatalogModel;
  catalogProvider?: CatalogProvider;
  multimodalInput: string[] | null;
  maxContextTokens: number;
  maxOutputTokens: number;
} | null {
  const ref = config.agent?.model ?? '';
  if (!ref) return null;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = config.model?.providers?.[providerId];
  if (!provider) return null;
  const userDef = provider.models?.[modelId];
  const userMultimodal = userDef && typeof userDef === 'object'
    ? (userDef as Record<string, unknown>).multimodal
    : null;
  let multimodalInput: string[] | null = null;
  if (userMultimodal && typeof userMultimodal === 'object') {
    const input = (userMultimodal as Record<string, unknown>).input;
    if (Array.isArray(input)) multimodalInput = input.filter((s): s is string => typeof s === 'string');
  }
  const userCapabilities = userDef && typeof userDef === 'object'
    ? (userDef as Record<string, unknown>).capabilities
    : null;
  const catalogProvider = findCatalogProviderById(providerId);
  const catalogModel = catalogProvider?.models.find((m) => m.id === modelId);
  const protocolDefaults = defaultCapabilitiesForProtocol(provider.protocol ?? catalogProvider?.protocol);
  const maxContextTokens = readPositiveCapability(userCapabilities, 'maxContextTokens')
    ?? catalogModel?.maxContextTokens
    ?? protocolDefaults.maxContextTokens;
  const maxOutputTokens = readPositiveCapability(userCapabilities, 'maxOutputTokens')
    ?? catalogModel?.maxOutputTokens
    ?? protocolDefaults.maxOutputTokens;
  return { ref, providerId, modelId, catalogModel, catalogProvider, multimodalInput, maxContextTokens, maxOutputTokens };
}

function AgentsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const refOptions = buildModelRefOptions(config);
  const mainRef = config.agent?.model ?? '';
  const subDefault = config.agent?.subagents?.default ?? 'inherit';

  const mainOptions = [
    { value: '', label: '— pick a model —' },
    ...refOptions,
  ];
  const subOptions = [
    { value: 'inherit', label: t('pilotDeckConfig.panels.agents.subagents.inherit') },
    ...refOptions,
  ];

  const caps = activeModelCapabilities(config);
  // True when the *effective* config (catalog ∪ user override) supports image.
  const supportsImageEffective = caps
    ? caps.multimodalInput
      ? caps.multimodalInput.includes('image')
      : Boolean(caps.catalogModel?.supportsImage)
    : false;
  // True only when the user explicitly wrote a multimodal.input override.
  const userOverrideActive = caps?.multimodalInput != null;

  const setImageOverride = (enable: boolean) => {
    if (!caps) return;
    const { providerId, modelId } = caps;
    const providers = config.model?.providers ?? {};
    const provider = providers[providerId] ?? {};
    const models = { ...(provider.models ?? {}) };
    const existingDef = models[modelId];
    const def: Record<string, unknown> = existingDef && typeof existingDef === 'object'
      ? { ...(existingDef as Record<string, unknown>) }
      : {};

    const catalogDefault = Boolean(caps.catalogModel?.supportsImage);
    if (enable === catalogDefault) {
      delete def.multimodal;
    } else {
      def.multimodal = { input: enable ? ['text', 'image'] : ['text'] };
    }
    models[modelId] = def as Record<string, unknown>;
    onChange(patch(config, ['model', 'providers', providerId, 'models'], models));
  };

  const setAgentTokenOverride = (key: 'maxContextTokens' | 'maxOutputTokens', value: number | undefined) => {
    const next = { ...(config.agent ?? {}) };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(patch(config, ['agent'], next));
  };

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.agents.title')}
      description={t('pilotDeckConfig.panels.agents.description')}
    >
      <SettingsCard divided>
        <FormRow label={t('pilotDeckConfig.panels.agents.mainModel.label')} description={t('pilotDeckConfig.panels.agents.mainModel.description')}>
          <Select
            value={mainRef}
            options={mainOptions}
            onChange={(v) => onChange(patch(ensureModelRefConfigured(config, v), ['agent', 'model'], v))}
          />
        </FormRow>

        {caps && (
          <div className="px-4 py-3">
            <div className="rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="mb-2 text-xs font-medium text-foreground">
                {t('pilotDeckConfig.panels.agents.capabilities.title')}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5" />
                  {t('pilotDeckConfig.panels.agents.capabilities.imageInput')}
                </span>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={supportsImageEffective}
                    onChange={(e) => setImageOverride(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border"
                  />
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                    supportsImageEffective
                      ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : 'border border-border bg-muted text-muted-foreground',
                  )}>
                    {supportsImageEffective ? t('pilotDeckConfig.panels.agents.capabilities.enabled') : t('pilotDeckConfig.panels.agents.capabilities.disabled')}
                  </span>
                </label>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {userOverrideActive
                  ? t('pilotDeckConfig.panels.agents.capabilities.overrideActive')
                  : caps.catalogModel
                    ? (caps.catalogModel.supportsImage ? t('pilotDeckConfig.panels.agents.capabilities.catalogSupportsImage') : t('pilotDeckConfig.panels.agents.capabilities.catalogTextOnly'))
                    : t('pilotDeckConfig.panels.agents.capabilities.noCatalog')}
                {' '}{t('pilotDeckConfig.panels.agents.capabilities.imageWarning')}
              </p>

              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" />
                    {t('pilotDeckConfig.panels.agents.capabilities.maxOutputTokens')}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={config.agent?.maxOutputTokens ?? ''}
                    placeholder={String(caps.maxOutputTokens)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return setAgentTokenOverride('maxOutputTokens', undefined);
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) setAgentTokenOverride('maxOutputTokens', Math.floor(n));
                    }}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {t('pilotDeckConfig.panels.agents.capabilities.maxOutputDescription')}
                </p>
              </div>

              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" />
                    {t('pilotDeckConfig.panels.agents.capabilities.maxContextTokens')}
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={config.agent?.maxContextTokens ?? ''}
                    placeholder={String(caps.maxContextTokens)}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '') return setAgentTokenOverride('maxContextTokens', undefined);
                      const n = Number(v);
                      if (Number.isFinite(n) && n > 0) {
                        setAgentTokenOverride('maxContextTokens', Math.floor(n));
                      }
                    }}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {t('pilotDeckConfig.panels.agents.capabilities.maxContextDescription')}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowAdvanced((next) => !next)}
            aria-expanded={showAdvanced}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-180')} />
            {t('pilotDeckConfig.panels.agents.advancedToggle')}
          </button>
        </div>

        {showAdvanced && (
          <div className="divide-y divide-border">
            <FormRow label={t('pilotDeckConfig.panels.agents.subagents.label')} description={t('pilotDeckConfig.panels.agents.subagents.description')}>
              <Select
                value={subDefault}
                options={subOptions}
                onChange={(v) => onChange(patch(ensureModelRefConfigured(config, v), ['agent', 'subagents', 'default'], v))}
              />
            </FormRow>
            <div className="flex gap-2 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <p>{t('pilotDeckConfig.panels.agents.subagents.routerNote')}</p>
            </div>
          </div>
        )}
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
  const { t } = useTranslation('settings');
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
      title={t('pilotDeckConfig.panels.customEnv.title')}
      description={t('pilotDeckConfig.panels.customEnv.description')}
    >
      <SettingsCard className="space-y-3 p-4">
        {entries.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('pilotDeckConfig.panels.customEnv.empty')}
          </div>
        )}
        {entries.map(([key, value]) => {
          const isMasked = isMaskedSecret(value);
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  value={key}
                  readOnly
                  className="w-[200px] shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none"
                />
                <span className="text-muted-foreground">=</span>
                <SecretTextInput
                  value={value}
                  placeholder={isMasked ? t('pilotDeckConfig.panels.customEnv.existingValueKept') : 'value'}
                  monospace
                  className="min-w-0 flex-1"
                  onChange={(v) => setEnv(key, v)}
                />
                <button
                  type="button"
                  onClick={() => removeEnv(key)}
                  className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title={t('pilotDeckConfig.actions.remove')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {isMasked && (
                <div className="ml-[216px] flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  {t('pilotDeckConfig.panels.customEnv.valueHidden')}
                </div>
              )}
            </div>
          );
        })}

        <div className="border-t border-border pt-3">
          <div className="mb-2 text-xs font-medium text-foreground">{t('pilotDeckConfig.panels.customEnv.addVariable')}</div>
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
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addEntry(); }}
            />
            <Button variant="outline" size="sm" className="shrink-0" onClick={addEntry} disabled={!newKey.trim()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('pilotDeckConfig.panels.customEnv.add')}
            </Button>
          </div>
        </div>

        {unusedWellKnown.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-xs text-muted-foreground">{t('pilotDeckConfig.panels.customEnv.quickAddKeys')}</div>
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
  const { t } = useTranslation('settings');
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
      title={t('pilotDeckConfig.panels.alwaysOn.title')}
      description={t('pilotDeckConfig.panels.alwaysOn.description')}
    >
      <div className="space-y-4">
        {/* General */}
        <SettingsCard>
          <SettingsRow
            label={t('pilotDeckConfig.panels.alwaysOn.enabled.label')}
            description={t('pilotDeckConfig.panels.alwaysOn.enabled.description')}
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel={t('pilotDeckConfig.panels.alwaysOn.enabled.label')}
              onChange={(value) => onChange(patch(config, ['alwaysOn', 'enabled'], value))}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            {/* Trigger */}
            <SettingsSection
              title={t('pilotDeckConfig.panels.alwaysOn.trigger.title')}
              description={t('pilotDeckConfig.panels.alwaysOn.trigger.description')}
            >
              <SettingsCard divided>
                <SettingsRow
                  label={t('pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.label')}
                  description={t('pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.description')}
                >
                  <SettingsToggle
                    checked={trigger.enabled === true}
                    ariaLabel={t('pilotDeckConfig.panels.alwaysOn.trigger.autoDiscovery.label')}
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.tickInterval.description')}>
                  <NumberInput
                    value={trigger.tickIntervalMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'tickIntervalMinutes'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.cooldown.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.cooldown.description')}>
                  <NumberInput
                    value={trigger.cooldownMinutes}
                    placeholder="60"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'cooldownMinutes'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.dailyBudget.description')}>
                  <NumberInput
                    value={trigger.dailyBudget}
                    placeholder="4"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'dailyBudget'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.heartbeatStale.description')}>
                  <NumberInput
                    value={trigger.heartbeatStaleSeconds}
                    placeholder="90"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'heartbeatStaleSeconds'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.recentUserMsg.description')}>
                  <NumberInput
                    value={trigger.recentUserMsgMinutes}
                    placeholder="5"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'trigger', 'recentUserMsgMinutes'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.label')} description={t('pilotDeckConfig.panels.alwaysOn.trigger.preferChannel.description')}>
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
            <SettingsSection
              title={t('pilotDeckConfig.panels.alwaysOn.dormancy.title')}
              description={t('pilotDeckConfig.panels.alwaysOn.dormancy.description')}
            >
              <SettingsCard divided>
                <SettingsRow
                  label={t('pilotDeckConfig.panels.alwaysOn.dormancy.enabled.label')}
                  description={t('pilotDeckConfig.panels.alwaysOn.dormancy.enabled.description')}
                >
                  <SettingsToggle
                    checked={dormancy.enabled !== false}
                    ariaLabel={t('pilotDeckConfig.panels.alwaysOn.dormancy.enabled.label')}
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'enabled'], value))}
                  />
                </SettingsRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.dormancy.debounce.label')} description={t('pilotDeckConfig.panels.alwaysOn.dormancy.debounce.description')}>
                  <NumberInput
                    value={dormancy.debounceMs}
                    placeholder="2000"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'dormancy', 'debounceMs'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.dormancy.ignoreGlobs.label')} description={t('pilotDeckConfig.panels.alwaysOn.dormancy.ignoreGlobs.description')}>
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
            <SettingsSection
              title={t('pilotDeckConfig.panels.alwaysOn.workspace.title')}
              description={t('pilotDeckConfig.panels.alwaysOn.workspace.description')}
            >
              <SettingsCard divided>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.workspace.gitWorktree.label')} description={t('pilotDeckConfig.panels.alwaysOn.workspace.gitWorktree.description')}>
                  <TextInput
                    value={workspace.gitWorktreeBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitWorktreeBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.workspace.snapshotDir.label')} description={t('pilotDeckConfig.panels.alwaysOn.workspace.snapshotDir.description')}>
                  <TextInput
                    value={workspace.snapshotBaseDir}
                    placeholder="(auto)"
                    monospace
                    onChange={(v) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotBaseDir'], v || undefined))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.workspace.snapshotMaxBytes.label')} description={t('pilotDeckConfig.panels.alwaysOn.workspace.snapshotMaxBytes.description')}>
                  <NumberInput
                    value={workspace.snapshotMaxBytes}
                    placeholder="1073741824"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'snapshotMaxBytes'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.workspace.maxPlansPerCycle.label')} description={t('pilotDeckConfig.panels.alwaysOn.workspace.maxPlansPerCycle.description')}>
                  <NumberInput
                    value={workspace.maxPlansPerCycle}
                    placeholder="3"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'maxPlansPerCycle'], value))}
                  />
                </FormRow>
                <SettingsRow
                  label={t('pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.label')}
                  description={t('pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.description')}
                >
                  <SettingsToggle
                    checked={workspace.gitLfs === true}
                    ariaLabel={t('pilotDeckConfig.panels.alwaysOn.workspace.gitLfs.label')}
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'workspace', 'gitLfs'], value))}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            {/* Execution */}
            <SettingsSection
              title={t('pilotDeckConfig.panels.alwaysOn.execution.title')}
              description={t('pilotDeckConfig.panels.alwaysOn.execution.description')}
            >
              <SettingsCard divided>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.execution.maxTurns.label')} description={t('pilotDeckConfig.panels.alwaysOn.execution.maxTurns.description')}>
                  <NumberInput
                    value={execution.maxTurns}
                    placeholder="30"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxTurns'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.execution.maxToolCalls.label')} description={t('pilotDeckConfig.panels.alwaysOn.execution.maxToolCalls.description')}>
                  <NumberInput
                    value={execution.maxToolCalls}
                    placeholder="200"
                    onChange={(value) => onChange(patch(config, ['alwaysOn', 'execution', 'maxToolCalls'], value))}
                  />
                </FormRow>
                <FormRow label={t('pilotDeckConfig.panels.alwaysOn.execution.timeout.label')} description={t('pilotDeckConfig.panels.alwaysOn.execution.timeout.description')}>
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
              title={t('pilotDeckConfig.panels.alwaysOn.workspaceOptIn.title')}
              description={t('pilotDeckConfig.panels.alwaysOn.workspaceOptIn.description')}
            >
              <SettingsCard divided>
                {projectRows.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    {t('pilotDeckConfig.panels.alwaysOn.workspaceOptIn.empty')}
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

function CronSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const cron = config.cron ?? {};
  const enabled = isCronConfigEnabled(config);

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.cron.title')}
      description={t('pilotDeckConfig.panels.cron.description')}
    >
      <SettingsCard divided>
        <SettingsRow
          label={t('pilotDeckConfig.panels.cron.enabled.label')}
          description={t('pilotDeckConfig.panels.cron.enabled.description')}
        >
          <SettingsToggle
            checked={enabled}
            ariaLabel={t('pilotDeckConfig.panels.cron.enabled.label')}
            onChange={(value) => onChange(patch(config, ['cron', 'enabled'], value))}
          />
        </SettingsRow>
        <FormRow
          label={t('pilotDeckConfig.panels.cron.timezone.label')}
          description={t('pilotDeckConfig.panels.cron.timezone.description')}
        >
          <TextInput
            value={cron.timezone}
            placeholder="Asia/Shanghai"
            monospace
            onChange={(value) => onChange(patch(config, ['cron', 'timezone'], value || undefined))}
          />
        </FormRow>
        <FormRow
          label={t('pilotDeckConfig.panels.cron.maxConcurrentRuns.label')}
          description={t('pilotDeckConfig.panels.cron.maxConcurrentRuns.description')}
        >
          <NumberInput
            value={cron.maxConcurrentRuns}
            placeholder="2"
            onChange={(value) => onChange(patch(config, ['cron', 'maxConcurrentRuns'], value))}
          />
        </FormRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const MEMORY_ALL_TARGET = 'all_memory';

type MemoryActionState = {
  kind: 'idle' | 'busy' | 'success' | 'error';
  message?: string;
};

type MemoryProjectTarget = {
  value: string;
  label: string;
  path: string;
};

function memoryProjectPath(project: SettingsProject): string {
  return (project.fullPath || project.path || '').trim();
}

function memoryProjectLabel(project: SettingsProject, fallback: string): string {
  const direct = (project.displayName || project.name || '').trim();
  if (direct) return direct;

  const root = memoryProjectPath(project);
  const tail = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
  return tail || fallback;
}

function memoryProjectTargetValue(projectPath: string): string {
  return `project:${projectPath}`;
}

function memoryProjectPathFromTarget(target: string): string {
  return target.startsWith('project:') ? target.slice('project:'.length) : '';
}

function withMemoryProjectPath(url: string, projectPath: string): string {
  if (!projectPath) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

function parseMemoryJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function memoryApiErrorMessage(response: Response, raw: string, body: Record<string, unknown> | null): string {
  const bodyError = typeof body?.error === 'string' ? body.error : '';
  return bodyError || raw || `Request failed: ${response.status}`;
}

function downloadMemoryText(raw: string, fileName: string) {
  const blob = new Blob([raw], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(href);
}

function safeDownloadToken(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'memory';
}

function MemorySection({
  config,
  projects,
  onChange,
}: {
  config: PilotDeckConfig;
  projects: SettingsProject[];
  onChange: (next: PilotDeckConfig) => void;
}) {
  const { t } = useTranslation('settings');
  const m = config.memory ?? {};
  const importInputRef = useRef<HTMLInputElement>(null);
  const [memoryAction, setMemoryAction] = useState<MemoryActionState>({ kind: 'idle' });
  // Memory uses a "provider/model" reference, or "inherit" to fall back
  // to agent.model. The backend treats `undefined` and `"inherit"` the
  // same way, so we map both to the inherit option in the UI.
  const refOptions = buildModelRefOptions(config);
  const options = [
    { value: 'inherit', label: t('pilotDeckConfig.panels.memory.model.inherit') },
    ...refOptions,
  ];
  const selected = m.model && m.model.trim() ? m.model : 'inherit';

  const projectTargets = useMemo(() => {
    const seen = new Set<string>();
    const fallback = t('pilotDeckConfig.panels.memory.data.target.projectFallback');
    return projects.reduce<MemoryProjectTarget[]>((items, project) => {
      const path = memoryProjectPath(project);
      if (!path || seen.has(path)) return items;
      seen.add(path);
      items.push({
        value: memoryProjectTargetValue(path),
        label: memoryProjectLabel(project, fallback),
        path,
      });
      return items;
    }, []);
  }, [projects, t]);

  const [selectedMemoryTarget, setSelectedMemoryTarget] = useState(() =>
    projectTargets[0]?.value ?? MEMORY_ALL_TARGET,
  );

  const memoryTargetOptions = useMemo(
    () => [
      ...projectTargets.map((target) => ({ value: target.value, label: target.label })),
      { value: MEMORY_ALL_TARGET, label: t('pilotDeckConfig.panels.memory.data.target.all') },
    ],
    [projectTargets, t],
  );

  useEffect(() => {
    if (!memoryTargetOptions.some((option) => option.value === selectedMemoryTarget)) {
      setSelectedMemoryTarget(projectTargets[0]?.value ?? MEMORY_ALL_TARGET);
    }
  }, [memoryTargetOptions, projectTargets, selectedMemoryTarget]);

  const targetIsAllMemory = selectedMemoryTarget === MEMORY_ALL_TARGET;
  const selectedProjectPath = targetIsAllMemory ? '' : memoryProjectPathFromTarget(selectedMemoryTarget);
  const selectedProjectTarget = projectTargets.find((target) => target.path === selectedProjectPath) ?? null;
  const dashboardProjectPath = selectedProjectPath || projectTargets[0]?.path || '';
  const selectedTargetLabel = targetIsAllMemory
    ? t('pilotDeckConfig.panels.memory.data.target.all')
    : selectedProjectTarget?.label ?? t('pilotDeckConfig.panels.memory.data.target.projectFallback');
  const actionBusy = memoryAction.kind === 'busy';
  const canManageTarget = targetIsAllMemory || Boolean(selectedProjectPath);

  const setMemoryField = (field: keyof NonNullable<PilotDeckConfig['memory']>, value: unknown) => {
    onChange(patch(config, ['memory', field], value));
  };

  const readMemoryResponse = async (response: Response) => {
    const raw = await response.text();
    const body = parseMemoryJson(raw);
    if (!response.ok) {
      throw new Error(memoryApiErrorMessage(response, raw, body));
    }
    return { raw, body };
  };

  const setActionBusy = (messageKey: string) => {
    setMemoryAction({
      kind: 'busy',
      message: t(messageKey, { target: selectedTargetLabel }),
    });
  };

  const setActionSuccess = (messageKey: string, warnings?: unknown) => {
    const warningList = Array.isArray(warnings)
      ? warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0)
      : [];
    setMemoryAction({
      kind: 'success',
      message: `${t(messageKey, { target: selectedTargetLabel })}${warningList.length > 0 ? ` ${warningList.join(' ')}` : ''}`,
    });
  };

  const setActionError = (error: unknown) => {
    setMemoryAction({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const handleExportMemory = async () => {
    if (!canManageTarget) {
      setMemoryAction({ kind: 'error', message: t('pilotDeckConfig.panels.memory.data.errors.missingProject') });
      return;
    }

    setActionBusy('pilotDeckConfig.panels.memory.data.status.exporting');
    try {
      const url = targetIsAllMemory
        ? '/api/memory/export/all-projects'
        : withMemoryProjectPath('/api/memory/export/current-project', selectedProjectPath);
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });
      const { raw, body } = await readMemoryResponse(response);
      if (!body) {
        throw new Error(t('pilotDeckConfig.panels.memory.data.errors.invalidExport'));
      }
      const prefix = targetIsAllMemory ? 'pilotdeck-memory-all' : `pilotdeck-memory-${safeDownloadToken(selectedTargetLabel)}`;
      downloadMemoryText(raw, `${prefix}-${Date.now()}.json`);
      setActionSuccess('pilotDeckConfig.panels.memory.data.status.exported');
    } catch (error) {
      setActionError(error);
    }
  };

  const handleImportMemoryFile = async (file: File | null) => {
    if (!file) return;
    if (!canManageTarget) {
      setMemoryAction({ kind: 'error', message: t('pilotDeckConfig.panels.memory.data.errors.missingProject') });
      return;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = parseMemoryJson(await file.text());
    } catch {
      payload = null;
    }
    if (!payload) {
      setMemoryAction({ kind: 'error', message: t('pilotDeckConfig.panels.memory.data.errors.invalidImport') });
      return;
    }

    const confirmKey = targetIsAllMemory
      ? 'pilotDeckConfig.panels.memory.data.confirm.importAll'
      : 'pilotDeckConfig.panels.memory.data.confirm.importProject';
    if (!window.confirm(t(confirmKey, { target: selectedTargetLabel }))) {
      return;
    }

    setActionBusy('pilotDeckConfig.panels.memory.data.status.importing');
    try {
      const url = targetIsAllMemory
        ? '/api/memory/import/all-projects'
        : withMemoryProjectPath('/api/memory/import/current-project', selectedProjectPath);
      const response = await authenticatedFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        suppressServerErrorToast: true,
      });
      const { body } = await readMemoryResponse(response);
      setActionSuccess('pilotDeckConfig.panels.memory.data.status.imported', body?.warnings);
    } catch (error) {
      setActionError(error);
    }
  };

  const handleClearMemory = async () => {
    if (!canManageTarget) {
      setMemoryAction({ kind: 'error', message: t('pilotDeckConfig.panels.memory.data.errors.missingProject') });
      return;
    }

    const confirmKey = targetIsAllMemory
      ? 'pilotDeckConfig.panels.memory.data.confirm.clearAll'
      : 'pilotDeckConfig.panels.memory.data.confirm.clearProject';
    if (!window.confirm(t(confirmKey, { target: selectedTargetLabel }))) {
      return;
    }

    setActionBusy('pilotDeckConfig.panels.memory.data.status.clearing');
    try {
      const response = await authenticatedFetch('/api/memory/clear', {
        method: 'POST',
        body: JSON.stringify(
          targetIsAllMemory
            ? { scope: 'all_memory', ...(dashboardProjectPath ? { projectPath: dashboardProjectPath } : {}) }
            : { scope: 'current_project', projectPath: selectedProjectPath },
        ),
        suppressServerErrorToast: true,
      });
      await readMemoryResponse(response);
      setActionSuccess('pilotDeckConfig.panels.memory.data.status.cleared');
    } catch (error) {
      setActionError(error);
    }
  };

  const memoryActionTone =
    memoryAction.kind === 'error'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : memoryAction.kind === 'success'
        ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
        : 'border-border bg-muted/40 text-muted-foreground';

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.memory.title')}
      description={t('pilotDeckConfig.panels.memory.description')}
    >
      <div className="space-y-4">
        <SettingsCard divided>
          <SettingsRow
            label={t('pilotDeckConfig.panels.memory.enabled.label')}
            description={t('pilotDeckConfig.panels.memory.enabled.description')}
          >
            <SettingsToggle
              checked={Boolean(m.enabled)}
              ariaLabel={t('pilotDeckConfig.panels.memory.enabled.label')}
              onChange={(v) => onChange(patch(config, ['memory', 'enabled'], v))}
            />
          </SettingsRow>
          {m.enabled && (
            <>
              <FormRow
                label={t('pilotDeckConfig.panels.memory.model.label')}
                description={t('pilotDeckConfig.panels.memory.model.description')}
              >
                <Select
                  value={selected}
                  options={options}
                  onChange={(v) => {
                    const nextValue = v === 'inherit' ? '' : v;
                    onChange(patch(ensureModelRefConfigured(config, nextValue), ['memory', 'model'], nextValue));
                  }}
                />
              </FormRow>
              <FormRow
                label={t('pilotDeckConfig.panels.memory.automation.autoIndex.label')}
                description={t('pilotDeckConfig.panels.memory.automation.autoIndex.description')}
              >
                <NumberInput
                  value={m.autoIndexIntervalMinutes}
                  placeholder="30"
                  onChange={(value) => setMemoryField('autoIndexIntervalMinutes', value === undefined ? undefined : Math.max(0, value))}
                />
              </FormRow>
              <FormRow
                label={t('pilotDeckConfig.panels.memory.automation.autoDream.label')}
                description={t('pilotDeckConfig.panels.memory.automation.autoDream.description')}
              >
                <NumberInput
                  value={m.autoDreamIntervalMinutes}
                  placeholder="60"
                  onChange={(value) => setMemoryField('autoDreamIntervalMinutes', value === undefined ? undefined : Math.max(0, value))}
                />
              </FormRow>
            </>
          )}
        </SettingsCard>

        <SettingsSection
          title={t('pilotDeckConfig.panels.memory.data.title')}
          description={t('pilotDeckConfig.panels.memory.data.description')}
        >
          <SettingsCard divided>
            <FormRow
              label={t('pilotDeckConfig.panels.memory.data.target.label')}
              description={t('pilotDeckConfig.panels.memory.data.target.description')}
            >
              <Select
                value={selectedMemoryTarget}
                options={memoryTargetOptions}
                onChange={(value) => {
                  setSelectedMemoryTarget(value);
                  setMemoryAction({ kind: 'idle' });
                }}
              />
            </FormRow>
            <div className="px-4 py-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  disabled={actionBusy || !canManageTarget}
                  onClick={() => void handleExportMemory()}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t('pilotDeckConfig.panels.memory.data.actions.export')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  disabled={actionBusy || !canManageTarget}
                  onClick={() => importInputRef.current?.click()}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  {t('pilotDeckConfig.panels.memory.data.actions.import')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  disabled={actionBusy || !canManageTarget}
                  onClick={() => void handleClearMemory()}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {t('pilotDeckConfig.panels.memory.data.actions.clear')}
                </Button>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const input = event.currentTarget;
                  void handleImportMemoryFile(input.files?.[0] ?? null).finally(() => {
                    input.value = '';
                  });
                }}
              />
              {memoryAction.kind !== 'idle' && memoryAction.message && (
                <div className={cn('mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5', memoryActionTone)}>
                  {memoryAction.kind === 'busy' && <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin" />}
                  {memoryAction.kind === 'success' && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" />}
                  {memoryAction.kind === 'error' && <AlertCircle className="mt-0.5 h-3.5 w-3.5" />}
                  <span>{memoryAction.message}</span>
                </div>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      </div>
    </SettingsSection>
  );
}

function ToolsSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const glmDefaultEndpoint = 'https://api.z.ai/api/paas/v4/web_search';
  const ws = config.tools?.webSearch ?? {};
  const provider = ws.provider === 'tavily' || ws.provider === 'custom' ? ws.provider : 'glm';
  const apiKey = typeof ws.apiKey === 'string' ? ws.apiKey : '';
  const endpoint = typeof ws.endpoint === 'string' ? ws.endpoint : '';
  const custom = ws.customProvider ?? {};
  const endpointValue = endpoint || (provider === 'glm' ? glmDefaultEndpoint : '');
  const endpointPlaceholder = provider === 'custom'
    ? 'https://example.com/search'
    : provider === 'tavily'
      ? 'https://api.tavily.com/search'
      : glmDefaultEndpoint;

  // Test-connection state — modeled after onboarding's LlmConfigurationStep
  // so behaviour and accessibility match across the app. Reset whenever the
  // user edits the key or endpoint so a stale ✓ never lies about new input.
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const resetTest = () => {
    setTestStatus('idle');
    setTestMessage('');
  };

  const setProvider = (nextProvider: 'glm' | 'tavily' | 'custom') => {
    const nextTools = {
      webSearch: {
        provider: nextProvider,
        ...(nextProvider === 'glm' ? { endpoint: glmDefaultEndpoint } : {}),
      },
    };
    onChange(patch(config, ['tools'], nextTools));
    resetTest();
  };

  const setField = (field: 'apiKey' | 'endpoint', value: string) => {
    const trimmed = value;
    const nextWs: NonNullable<PilotDeckConfig['tools']>['webSearch'] = { ...ws };
    nextWs.provider = provider;
    if (trimmed === '') {
      delete nextWs[field];
    } else {
      nextWs[field] = trimmed;
    }
    const nextTools = Object.keys(nextWs).length > 0 ? { webSearch: nextWs } : undefined;
    onChange(patch(config, ['tools'], nextTools));
    resetTest();
  };

  const setCustomField = (
    field: keyof NonNullable<NonNullable<PilotDeckConfig['tools']>['webSearch']>['customProvider'],
    value: string,
  ) => {
    const nextWs: NonNullable<PilotDeckConfig['tools']>['webSearch'] = {
      ...ws,
      provider: 'custom',
      customProvider: { ...(ws.customProvider ?? {}) },
    };
    if (value === '') {
      delete nextWs.customProvider?.[field];
    } else if (field === 'auth') {
      nextWs.customProvider![field] = value as 'bearer' | 'bodyApiKey' | 'queryApiKey' | 'none';
    } else if (field === 'method') {
      nextWs.customProvider![field] = value as 'GET' | 'POST';
    } else {
      nextWs.customProvider![field] = value;
    }
    if (Object.keys(nextWs.customProvider ?? {}).length === 0) {
      delete nextWs.customProvider;
    }
    onChange(patch(config, ['tools'], { webSearch: nextWs }));
    resetTest();
  };

  const handleTest = async () => {
    const trimmedKey = hasUsableSecret(apiKey) ? apiKey.trim() : '';
    if (!trimmedKey) {
      setTestStatus('error');
      setTestMessage(t('pilotDeckConfig.panels.tools.test.needsKey'));
      return;
    }
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-web-search', {
        method: 'POST',
        body: JSON.stringify({ provider, apiKey: trimmedKey, endpoint: endpointValue.trim(), customProvider: custom }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage(
          t('pilotDeckConfig.panels.tools.test.success', {
            count: data.organicCount ?? 0,
            latency: data.latencyMs ?? 0,
          }),
        );
      } else {
        setTestStatus('error');
        setTestMessage(
          t('pilotDeckConfig.panels.tools.test.failedPrefix', { error: data.error || 'unknown' }),
        );
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(
        t('pilotDeckConfig.panels.tools.test.failedPrefix', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.tools.title')}
      description={t('pilotDeckConfig.panels.tools.description')}
    >
      <SettingsCard divided>
        <FormRow
          label={t('pilotDeckConfig.panels.tools.provider.label')}
          description={t('pilotDeckConfig.panels.tools.provider.description')}
        >
          <Select
            value={provider}
            options={[
              { value: 'glm', label: t('pilotDeckConfig.panels.tools.provider.glm') },
              { value: 'tavily', label: t('pilotDeckConfig.panels.tools.provider.tavily') },
              { value: 'custom', label: t('pilotDeckConfig.panels.tools.provider.custom') },
            ]}
            onChange={(v) => setProvider(v === 'custom' ? 'custom' : v === 'tavily' ? 'tavily' : 'glm')}
          />
        </FormRow>
        <FormRow
          label={t('pilotDeckConfig.panels.tools.apiKey.label')}
          description={t('pilotDeckConfig.panels.tools.apiKey.description')}
        >
          <SecretTextInput
            value={apiKey}
            emptyPlaceholder={t('pilotDeckConfig.panels.tools.apiKey.placeholder')}
            maskedPlaceholder={t('pilotDeckConfig.panels.tools.apiKey.maskedPlaceholder')}
            monospace
            onChange={(v) => setField('apiKey', v)}
          />
          {isMaskedSecret(apiKey) && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3" />
              {t('pilotDeckConfig.panels.tools.apiKey.keyHidden')}
            </p>
          )}
        </FormRow>
        <FormRow
          label={t('pilotDeckConfig.panels.tools.endpoint.label')}
          description={t('pilotDeckConfig.panels.tools.endpoint.description')}
        >
          <TextInput
            value={endpointValue}
            placeholder={endpointPlaceholder}
            monospace
            onChange={(v) => setField('endpoint', v)}
          />
        </FormRow>
        {provider === 'custom' && (
          <>
            <FormRow
              label={t('pilotDeckConfig.panels.tools.custom.name.label')}
              description={t('pilotDeckConfig.panels.tools.custom.name.description')}
            >
              <TextInput
                value={custom.name ?? ''}
                placeholder="My Search"
                onChange={(v) => setCustomField('name', v)}
              />
            </FormRow>
            <FormRow
              label={t('pilotDeckConfig.panels.tools.custom.auth.label')}
              description={t('pilotDeckConfig.panels.tools.custom.auth.description')}
            >
              <Select
                value={custom.auth ?? 'bearer'}
                options={[
                  { value: 'bearer', label: t('pilotDeckConfig.panels.tools.custom.auth.bearer') },
                  { value: 'bodyApiKey', label: t('pilotDeckConfig.panels.tools.custom.auth.bodyApiKey') },
                  { value: 'queryApiKey', label: t('pilotDeckConfig.panels.tools.custom.auth.queryApiKey') },
                  { value: 'none', label: t('pilotDeckConfig.panels.tools.custom.auth.none') },
                ]}
                onChange={(v) => setCustomField('auth', v)}
              />
            </FormRow>
            <FormRow
              label={t('pilotDeckConfig.panels.tools.custom.method.label')}
              description={t('pilotDeckConfig.panels.tools.custom.method.description')}
            >
              <Select
                value={custom.method ?? 'POST'}
                options={[
                  { value: 'POST', label: 'POST' },
                  { value: 'GET', label: 'GET' },
                ]}
                onChange={(v) => setCustomField('method', v)}
              />
            </FormRow>
            <FormRow
              label={t('pilotDeckConfig.panels.tools.custom.params.label')}
              description={t('pilotDeckConfig.panels.tools.custom.params.description')}
            >
              <div className="grid gap-2 md:grid-cols-2">
                <TextInput
                  value={custom.queryParam ?? ''}
                  placeholder="query"
                  monospace
                  onChange={(v) => setCustomField('queryParam', v)}
                />
                <TextInput
                  value={custom.apiKeyParam ?? ''}
                  placeholder="api_key"
                  monospace
                  onChange={(v) => setCustomField('apiKeyParam', v)}
                />
              </div>
            </FormRow>
            <FormRow
              label={t('pilotDeckConfig.panels.tools.custom.mapping.label')}
              description={t('pilotDeckConfig.panels.tools.custom.mapping.description')}
            >
              <div className="grid gap-2 md:grid-cols-2">
                <TextInput value={custom.resultsPath ?? ''} placeholder="data.items" monospace onChange={(v) => setCustomField('resultsPath', v)} />
                <TextInput value={custom.titleField ?? ''} placeholder="title" monospace onChange={(v) => setCustomField('titleField', v)} />
                <TextInput value={custom.urlField ?? ''} placeholder="url" monospace onChange={(v) => setCustomField('urlField', v)} />
                <TextInput value={custom.snippetField ?? ''} placeholder="snippet" monospace onChange={(v) => setCustomField('snippetField', v)} />
                <TextInput value={custom.sourceField ?? ''} placeholder="source" monospace onChange={(v) => setCustomField('sourceField', v)} />
                <TextInput value={custom.publishedAtField ?? ''} placeholder="publishedAt" monospace onChange={(v) => setCustomField('publishedAtField', v)} />
              </div>
            </FormRow>
          </>
        )}
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testStatus === 'testing' || !hasUsableSecret(apiKey)}
            >
              {testStatus === 'testing' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {testStatus === 'testing'
                ? t('pilotDeckConfig.panels.tools.test.testing')
                : t('pilotDeckConfig.panels.tools.test.button')}
            </Button>
            {testStatus === 'success' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                {testMessage}
              </span>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function ModelPricingEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const pricing = config.router?.stats?.modelPricing ?? {};
  const keys = Object.keys(pricing);
  const [newKey, setNewKey] = useState('');

  const setPricing = (key: string, field: 'input' | 'output' | 'cacheRead', value: number | undefined) => {
    const entry = pricing[key] ?? {};
    onChange(patch(config, ['router', 'stats', 'modelPricing', key], { ...entry, [field]: value }));
  };
  const removePricing = (key: string) => {
    const next = { ...pricing };
    delete next[key];
    onChange(patch(config, ['router', 'stats', 'modelPricing'], next));
  };
  const addPricing = () => {
    const key = newKey.trim();
    if (!key || pricing[key]) return;
    onChange(patch(config, ['router', 'stats', 'modelPricing', key], { input: 0, output: 0 }));
    setNewKey('');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{t('pilotDeckConfig.panels.router.pricing.title')}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('pilotDeckConfig.panels.router.pricing.description')}
        </div>
      </div>

      {keys.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t('pilotDeckConfig.panels.router.pricing.empty')}
        </div>
      )}

      {keys.map((key) => {
        const entry = pricing[key] ?? {};
        return (
          <div key={key} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">{key}</code>
              <button
                type="button"
                onClick={() => removePricing(key)}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title={t('pilotDeckConfig.actions.remove')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('pilotDeckConfig.panels.router.pricing.inputPerM')}</span>
                <NumberInput value={entry.input} placeholder="0.50" onChange={(v) => setPricing(key, 'input', v)} />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('pilotDeckConfig.panels.router.pricing.outputPerM')}</span>
                <NumberInput value={entry.output} placeholder="1.50" onChange={(v) => setPricing(key, 'output', v)} />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('pilotDeckConfig.panels.router.pricing.cachePerM')}</span>
                <NumberInput value={entry.cacheRead} placeholder="0" onChange={(v) => setPricing(key, 'cacheRead', v)} />
              </label>
            </div>
          </div>
        );
      })}

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-foreground">{t('pilotDeckConfig.panels.router.pricing.addTitle')}</div>
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="provider/model-name"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addPricing(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addPricing} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('pilotDeckConfig.panels.router.pricing.add')}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function RouterFallbackEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const fallback = config.router?.fallback ?? {};
  const entries = Object.entries(fallback);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState('');

  const setChain = (scenario: string, chain: string[]) =>
    onChange(patch(ensureModelRefsConfigured(config, chain), ['router', 'fallback', scenario], chain));
  const removeChain = (scenario: string) => {
    const next = { ...fallback };
    delete next[scenario];
    onChange(patch(config, ['router', 'fallback'], next));
  };
  const addChain = () => {
    const key = newKey.trim();
    if (!key || fallback[key]) return;
    const value = modelOpts[0]?.value ?? '';
    onChange(patch(ensureModelRefConfigured(config, value), ['router', 'fallback', key], [value]));
    setNewKey('');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{t('pilotDeckConfig.panels.router.fallback.title')}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('pilotDeckConfig.panels.router.fallback.description')}
        </div>
      </div>
      {entries.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t('pilotDeckConfig.panels.router.fallback.empty')}
        </div>
      )}
      {entries.map(([scenario, chain]) => (
        <div key={scenario} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">{scenario}</code>
            <button
              type="button"
              onClick={() => removeChain(scenario)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t('pilotDeckConfig.actions.remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {(chain ?? []).map((model, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-[10px] font-semibold text-muted-foreground">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <ModelRefInput
                    value={model}
                    options={modelOpts}
                    onChange={(v) => {
                      const next = [...chain];
                      next[idx] = v;
                      setChain(scenario, next);
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setChain(scenario, chain.filter((_, i) => i !== idx))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title={t('pilotDeckConfig.actions.removeModel')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setChain(scenario, [...(chain ?? []), modelOpts[0]?.value ?? ''])}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              {t('pilotDeckConfig.panels.router.fallback.addModel')}
            </button>
          </div>
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="scenario name (e.g. default)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addChain(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addChain} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('pilotDeckConfig.panels.router.fallback.add')}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

const ROUTER_TIER_KEYS = ['simple', 'medium', 'complex', 'reasoning'] as const;
type RouterTierKey = typeof ROUTER_TIER_KEYS[number];

const DEFAULT_TIERS: Record<RouterTierKey, { description: string }> = {
  simple: { description: 'Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules' },
  medium: { description: 'Single tool call, short text generation, 1-2 file read/write, code generation' },
  complex: { description: 'Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents' },
  reasoning: { description: 'Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources' },
};

const DEFAULT_RULES: string[] = [
  'complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work',
  'Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning',
  'Simple file creation (1-2 files) or single code generation is medium',
  'Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple',
];

function TokenSaverTierEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const tiers = config.router?.tokenSaver?.tiers ?? {};
  const entries = Object.entries(tiers);
  const modelOpts = buildModelRefOptions(config);
  const [newKey, setNewKey] = useState('');

  const setTier = (key: string, field: 'model' | 'description', value: string) =>
    onChange(patch(
      field === 'model' ? ensureModelRefConfigured(config, value) : config,
      ['router', 'tokenSaver', 'tiers', key, field],
      value,
    ));
  const removeTier = (key: string) => {
    const next = { ...tiers };
    delete next[key];
    onChange(patch(config, ['router', 'tokenSaver', 'tiers'], next));
  };
  const addTier = () => {
    const key = newKey.trim();
    if (!key || tiers[key]) return;
    const preset = DEFAULT_TIERS[key];
    const model = modelOpts[0]?.value ?? '';
    onChange(patch(ensureModelRefConfigured(config, model), ['router', 'tokenSaver', 'tiers', key], {
      model,
      description: preset?.description ?? '',
    }));
    setNewKey('');
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold text-foreground">{t('pilotDeckConfig.panels.router.tiers.title')}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t('pilotDeckConfig.panels.router.tiers.description')}
        </div>
      </div>
      {entries.map(([key, tier]) => (
        <div key={key} className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center gap-2">
            <code className="shrink-0 rounded bg-muted px-2 py-1 text-xs font-semibold text-foreground">{key}</code>
            <div className="min-w-0 flex-1">
              <ModelRefInput value={tier.model ?? ''} options={modelOpts} onChange={(v) => setTier(key, 'model', v)} />
            </div>
            <button
              type="button"
              onClick={() => removeTier(key)}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title={t('pilotDeckConfig.actions.remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <textarea
            value={tier.description ?? ''}
            onChange={(e) => setTier(key, 'description', e.target.value)}
            placeholder={t('pilotDeckConfig.panels.router.tiers.placeholder')}
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="tier name (e.g. simple, medium, complex)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addTier(); }}
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={addTier} disabled={!newKey.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('pilotDeckConfig.panels.router.tiers.add')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TokenSaverRulesEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const rules = config.router?.tokenSaver?.rules ?? [];
  const [newRule, setNewRule] = useState('');

  const setRule = (idx: number, value: string) => {
    const next = [...rules];
    next[idx] = value;
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], next));
  };
  const removeRule = (idx: number) =>
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], rules.filter((_, i) => i !== idx)));
  const addRule = () => {
    const r = newRule.trim();
    if (!r) return;
    onChange(patch(config, ['router', 'tokenSaver', 'rules'], [...rules, r]));
    setNewRule('');
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-foreground">{t('pilotDeckConfig.panels.router.rules.title')}</div>
      {rules.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t('pilotDeckConfig.panels.router.rules.empty')}
        </div>
      )}
      {rules.map((rule, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <textarea
            value={rule}
            onChange={(e) => setRule(idx, e.target.value)}
            rows={2}
            className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => removeRule(idx)}
            className="mt-1 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t('pilotDeckConfig.actions.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          placeholder={t('pilotDeckConfig.panels.router.rules.placeholder')}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => { if (e.key === 'Enter' && !isImeEnterEvent(e)) addRule(); }}
        />
        <Button variant="outline" size="sm" className="shrink-0" onClick={addRule} disabled={!newRule.trim()}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('pilotDeckConfig.panels.router.rules.add')}
        </Button>
      </div>
    </div>
  );
}

function RouterLevelEditor({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const modelOpts = buildModelRefOptions(config);
  const defaultValue = config.router?.scenarios?.default ?? '';
  const judgeValue = config.router?.tokenSaver?.judge ?? '';
  const tiers = config.router?.tokenSaver?.tiers ?? {};

  const setDefault = (value: string) => {
    let next = patch(ensureModelRefConfigured(config, value), ['router', 'scenarios', 'default'], value);
    next = replaceFallbackModelRef(next, defaultValue, value);
    const fallbackDefault = config.router?.fallback?.default ?? [];
    if (
      fallbackDefault.length === 0 ||
      (fallbackDefault.length === 1 && fallbackDefault[0] === defaultValue)
    ) {
      next = patch(next, ['router', 'fallback', 'default'], value ? [value] : []);
    }
    onChange(next);
  };

  const setTierModel = (key: RouterTierKey, model: string) => {
    const existing = tiers[key] ?? {};
    onChange(patch(ensureModelRefConfigured(config, model), ['router', 'tokenSaver', 'tiers', key], {
      ...existing,
      model,
      description: existing.description ?? DEFAULT_TIERS[key].description,
    }));
  };

  const setJudgeModel = (value: string) => {
    onChange(patch(ensureModelRefConfigured(config, value), ['router', 'tokenSaver', 'judge'], value));
  };

  return (
    <SettingsCard divided>
      <FormRow
        label={t('pilotDeckConfig.panels.router.levels.default.label')}
        description={t('pilotDeckConfig.panels.router.levels.default.description')}
      >
        <ModelRefInput
          value={defaultValue}
          options={modelOpts}
          placeholder={t('pilotDeckConfig.panels.router.levels.modelPlaceholder')}
          onChange={setDefault}
        />
      </FormRow>

      <FormRow
        label={t('pilotDeckConfig.panels.router.levels.judge.label')}
        description={t('pilotDeckConfig.panels.router.levels.judge.description')}
      >
        <ModelRefInput
          value={judgeValue}
          options={modelOpts}
          placeholder={t('pilotDeckConfig.panels.router.levels.modelPlaceholder')}
          onChange={setJudgeModel}
        />
      </FormRow>

      {ROUTER_TIER_KEYS.map((key) => (
        <FormRow
          key={key}
          label={t(`pilotDeckConfig.panels.router.levels.${key}.label`)}
          description={t(`pilotDeckConfig.panels.router.levels.${key}.description`)}
        >
          <ModelRefInput
            value={tiers[key]?.model ?? ''}
            options={modelOpts}
            placeholder={t('pilotDeckConfig.panels.router.levels.modelPlaceholder')}
            onChange={(v) => setTierModel(key, v)}
          />
        </FormRow>
      ))}
    </SettingsCard>
  );
}

function RouterSection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const r = config.router ?? {};
  const enabled = r.enabled !== false;
  const modelOpts = buildModelRefOptions(config);

  const ts = r.tokenSaver ?? {};
  const ao = r.autoOrchestrate ?? {};
  const zr = r.zeroUsageRetry ?? {};
  const tr = r.transientRetry ?? {};
  const statsEnabled = r.stats?.enabled !== false;
  const zeroUsageEnabled = zr.enabled !== false;
  const transientRetryEnabled = tr.enabled !== false;
  const tokenSaverEnabled = ts.enabled !== false;
  const autoOrchestrateEnabled = ao.enabled !== false;

  const availableTierNames = Object.keys(ts.tiers ?? {});

  const getDefaultModel = (base: PilotDeckConfig) =>
    (typeof base.router?.scenarios?.default === 'string' && base.router.scenarios.default.trim())
      || (typeof base.agent?.model === 'string' && base.agent.model.trim())
      || modelOpts[0]?.value
      || '';

  const seedRouterDefaults = (base: PilotDeckConfig) => {
    let next = base;
    const defaultModel = getDefaultModel(next);
    next = ensureModelRefConfigured(next, defaultModel);

    if (defaultModel && !next.router?.scenarios?.default) {
      next = patch(next, ['router', 'scenarios', 'default'], defaultModel);
    }
    if (defaultModel && !(next.router?.fallback?.default?.length)) {
      next = patch(next, ['router', 'fallback', 'default'], [defaultModel]);
    }
    if (next.router?.zeroUsageRetry?.enabled !== true) {
      next = patch(next, ['router', 'zeroUsageRetry', 'enabled'], true);
    }
    if (next.router?.zeroUsageRetry?.maxAttempts == null) {
      next = patch(next, ['router', 'zeroUsageRetry', 'maxAttempts'], 2);
    }
    if (next.router?.transientRetry?.enabled !== true) {
      next = patch(next, ['router', 'transientRetry', 'enabled'], true);
    }
    if (next.router?.transientRetry?.maxAttempts == null) {
      next = patch(next, ['router', 'transientRetry', 'maxAttempts'], 5);
    }
    if (next.router?.tokenSaver?.enabled !== true) {
      next = patch(next, ['router', 'tokenSaver', 'enabled'], true);
    }
    if (defaultModel && !next.router?.tokenSaver?.judge) {
      next = patch(next, ['router', 'tokenSaver', 'judge'], defaultModel);
    }
    if (!next.router?.tokenSaver?.defaultTier) {
      next = patch(next, ['router', 'tokenSaver', 'defaultTier'], 'medium');
    }
    if (!next.router?.tokenSaver?.judgeTimeoutMs) {
      next = patch(next, ['router', 'tokenSaver', 'judgeTimeoutMs'], 15000);
    }
    for (const key of ROUTER_TIER_KEYS) {
      const existing = next.router?.tokenSaver?.tiers?.[key] ?? {};
      if (!existing.model || !existing.description) {
        next = patch(next, ['router', 'tokenSaver', 'tiers', key], {
          ...existing,
          model: existing.model ?? defaultModel,
          description: existing.description ?? DEFAULT_TIERS[key].description,
        });
      }
    }
    if ((next.router?.tokenSaver?.rules ?? []).length === 0) {
      next = patch(next, ['router', 'tokenSaver', 'rules'], [...DEFAULT_RULES]);
    }
    if (next.router?.autoOrchestrate?.enabled !== true) {
      next = patch(next, ['router', 'autoOrchestrate', 'enabled'], true);
    }
    if ((next.router?.autoOrchestrate?.triggerTiers ?? []).length === 0) {
      next = patch(next, ['router', 'autoOrchestrate', 'triggerTiers'], ['complex']);
    }
    if (next.router?.autoOrchestrate?.slimSystemPrompt == null) {
      next = patch(next, ['router', 'autoOrchestrate', 'slimSystemPrompt'], true);
    }
    if (next.router?.stats?.enabled !== true) {
      next = patch(next, ['router', 'stats', 'enabled'], true);
    }

    return next;
  };

  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.router.title')}
      description={t('pilotDeckConfig.panels.router.description')}
    >
      <div className="space-y-4">
        {/* ── Master toggle ─────────────────────────────────────────── */}
        <SettingsCard divided>
          <SettingsRow
            label={t('pilotDeckConfig.panels.router.enabled.label')}
            description={t('pilotDeckConfig.panels.router.enabled.description')}
          >
            <SettingsToggle
              checked={enabled}
              ariaLabel={t('pilotDeckConfig.panels.router.enabled.label')}
              onChange={(v) => {
                let next = patch(config, ['router', 'enabled'], v);
                if (v) {
                  next = seedRouterDefaults(next);
                }
                onChange(next);
              }}
            />
          </SettingsRow>
        </SettingsCard>

        {enabled && (
          <>
            <RouterLevelEditor config={config} onChange={onChange} />

            <button
              type="button"
              onClick={() => setShowAdvanced((next) => !next)}
              aria-expanded={showAdvanced}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAdvanced && 'rotate-180')} />
              {t('pilotDeckConfig.panels.router.advancedToggle')}
            </button>

            {showAdvanced && (
              <>
                {/* ── Fallback chains ────────────────────────────────────── */}
                <RouterFallbackEditor config={config} onChange={onChange} />

                {/* ── Zero-usage retry ───────────────────────────────────── */}
                <SettingsCard divided>
                  <SettingsRow
                    label={t('pilotDeckConfig.panels.router.zeroUsageRetry.label')}
                    description={t('pilotDeckConfig.panels.router.zeroUsageRetry.description')}
                  >
                    <SettingsToggle
                      checked={zeroUsageEnabled}
                      ariaLabel={t('pilotDeckConfig.panels.router.zeroUsageRetry.label')}
                      onChange={(v) => onChange(patch(config, ['router', 'zeroUsageRetry', 'enabled'], v))}
                    />
                  </SettingsRow>
                  {zeroUsageEnabled && (
                    <FormRow label={t('pilotDeckConfig.panels.router.zeroUsageRetry.maxAttempts.label')} description={t('pilotDeckConfig.panels.router.zeroUsageRetry.maxAttempts.description')}>
                      <NumberInput
                        value={zr.maxAttempts}
                        placeholder="2"
                        onChange={(v) => onChange(patch(config, ['router', 'zeroUsageRetry', 'maxAttempts'], v))}
                      />
                    </FormRow>
                  )}
                </SettingsCard>

                {/* ── TransientRetry ───────────────────────────────────── */}
                <SettingsCard className="space-y-4 p-4">
                  <SettingsRow
                    label={t('pilotDeckConfig.panels.router.transientRetry.label')}
                    description={t('pilotDeckConfig.panels.router.transientRetry.description')}
                  >
                    <SettingsToggle
                      checked={transientRetryEnabled}
                      onChange={(v) => onChange(patch(config, ['router', 'transientRetry', 'enabled'], v))}
                    />
                  </SettingsRow>
                  {transientRetryEnabled && (
                    <>
                      <FormRow label={t('pilotDeckConfig.panels.router.transientRetry.maxAttempts.label')} description={t('pilotDeckConfig.panels.router.transientRetry.maxAttempts.description')}>
                        <NumberInput
                          value={tr.maxAttempts}
                          placeholder="5"
                          onChange={(v) => onChange(patch(config, ['router', 'transientRetry', 'maxAttempts'], v))}
                        />
                      </FormRow>
                      <FormRow label={t('pilotDeckConfig.panels.router.transientRetry.baseDelayMs.label')} description={t('pilotDeckConfig.panels.router.transientRetry.baseDelayMs.description')}>
                        <NumberInput
                          value={tr.baseDelayMs}
                          placeholder="1000"
                          onChange={(v) => onChange(patch(config, ['router', 'transientRetry', 'baseDelayMs'], v))}
                        />
                      </FormRow>
                      <FormRow label={t('pilotDeckConfig.panels.router.transientRetry.maxDelayMs.label')} description={t('pilotDeckConfig.panels.router.transientRetry.maxDelayMs.description')}>
                        <NumberInput
                          value={tr.maxDelayMs}
                          placeholder="30000"
                          onChange={(v) => onChange(patch(config, ['router', 'transientRetry', 'maxDelayMs'], v))}
                        />
                      </FormRow>
                    </>
                  )}
                </SettingsCard>

                {/* ── TokenSaver ─────────────────────────────────────────── */}
                <SettingsCard className="space-y-4 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{t('pilotDeckConfig.panels.router.tokenSaver.title')}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t('pilotDeckConfig.panels.router.tokenSaver.description')}
                      </div>
                    </div>
                    <SettingsToggle
                      checked={tokenSaverEnabled}
                      ariaLabel={t('pilotDeckConfig.panels.router.tokenSaver.title')}
                      onChange={(v) => {
                        let next = patch(config, ['router', 'tokenSaver', 'enabled'], v);
                        if (v) {
                          next = seedRouterDefaults(next);
                        }
                        onChange(next);
                      }}
                    />
                  </div>

                  {tokenSaverEnabled && (
                    <div className="space-y-4 border-t border-border pt-4">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-foreground">{t('pilotDeckConfig.panels.router.tokenSaver.defaultTier')}</label>
                        <Select
                          value={ts.defaultTier ?? 'medium'}
                          options={
                            availableTierNames.length > 0
                              ? availableTierNames.map((t) => ({ value: t, label: t }))
                              : ROUTER_TIER_KEYS.map((t) => ({ value: t, label: t }))
                          }
                          onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'defaultTier'], v))}
                        />
                      </div>
                      <FormRow label={t('pilotDeckConfig.panels.router.tokenSaver.judgeTimeout.label')} description={t('pilotDeckConfig.panels.router.tokenSaver.judgeTimeout.description')}>
                        <NumberInput
                          value={ts.judgeTimeoutMs}
                          placeholder="15000"
                          onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'judgeTimeoutMs'], v))}
                        />
                      </FormRow>
                      <FormRow label={t('pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.label')} description={t('pilotDeckConfig.panels.router.tokenSaver.subagentPolicy.description')}>
                        <Select
                          value={ts.subagent?.policy ?? 'judge'}
                          options={[
                            { value: 'judge', label: 'judge' },
                            { value: 'skip', label: 'skip' },
                          ]}
                          onChange={(v) => onChange(patch(config, ['router', 'tokenSaver', 'subagent', 'policy'], v))}
                        />
                      </FormRow>

                      <TokenSaverTierEditor config={config} onChange={onChange} />
                      <TokenSaverRulesEditor config={config} onChange={onChange} />
                    </div>
                  )}
                </SettingsCard>

                {/* ── Auto-orchestrate ───────────────────────────────────── */}
                <SettingsCard className="space-y-4 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{t('pilotDeckConfig.panels.router.autoOrchestrate.title')}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t('pilotDeckConfig.panels.router.autoOrchestrate.description')}
                      </div>
                    </div>
                    <SettingsToggle
                      checked={autoOrchestrateEnabled}
                      ariaLabel={t('pilotDeckConfig.panels.router.autoOrchestrate.title')}
                      onChange={(v) => onChange(patch(config, ['router', 'autoOrchestrate', 'enabled'], v))}
                    />
                  </div>

                  {autoOrchestrateEnabled && (
                    <div className="space-y-3 border-t border-border pt-4">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-foreground">{t('pilotDeckConfig.panels.router.autoOrchestrate.triggerTiers')}</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {(availableTierNames.length > 0 ? availableTierNames : [...ROUTER_TIER_KEYS]).map((tier) => {
                            const active = (ao.triggerTiers ?? ['complex']).includes(tier);
                            return (
                              <button
                                key={tier}
                                type="button"
                                className={cn(
                                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                                  active
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border bg-background text-muted-foreground hover:bg-muted',
                                )}
                                onClick={() => {
                                  const prev = ao.triggerTiers ?? ['complex'];
                                  const next = active ? prev.filter((t) => t !== tier) : [...prev, tier];
                                  onChange(patch(config, ['router', 'autoOrchestrate', 'triggerTiers'], next));
                                }}
                              >
                                {tier}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <SettingsRow
                        label={t('pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.label')}
                        description={t('pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.description')}
                      >
                        <SettingsToggle
                          checked={ao.slimSystemPrompt !== false}
                          ariaLabel={t('pilotDeckConfig.panels.router.autoOrchestrate.slimPrompt.label')}
                          onChange={(v) => onChange(patch(config, ['router', 'autoOrchestrate', 'slimSystemPrompt'], v))}
                        />
                      </SettingsRow>
                    </div>
                  )}
                </SettingsCard>

                {/* ── Stats ──────────────────────────────────────────────── */}
                <SettingsCard divided>
                  <SettingsRow
                    label={t('pilotDeckConfig.panels.router.stats.label')}
                    description={t('pilotDeckConfig.panels.router.stats.description')}
                  >
                    <SettingsToggle
                      checked={statsEnabled}
                      ariaLabel={t('pilotDeckConfig.panels.router.stats.label')}
                      onChange={(v) => onChange(patch(config, ['router', 'stats', 'enabled'], v))}
                    />
                  </SettingsRow>
                </SettingsCard>

                {statsEnabled && <ModelPricingEditor config={config} onChange={onChange} />}
              </>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}

function GatewaySection({ config, onChange }: { config: PilotDeckConfig; onChange: (next: PilotDeckConfig) => void }) {
  const { t } = useTranslation('settings');
  const g = config.gateway ?? {};
  return (
    <SettingsSection
      title={t('pilotDeckConfig.panels.gateway.title')}
      description={t('pilotDeckConfig.panels.gateway.description')}
    >
      <SettingsCard divided>
        <SettingsRow label={t('pilotDeckConfig.panels.gateway.enabled.label')} description={t('pilotDeckConfig.panels.gateway.enabled.description')}>
          <SettingsToggle
            checked={Boolean(g.enabled)}
            ariaLabel={t('pilotDeckConfig.panels.gateway.enabled.label')}
            onChange={(v) => onChange(patch(config, ['gateway', 'enabled'], v))}
          />
        </SettingsRow>
        {g.enabled && (
          <FormRow label={t('pilotDeckConfig.panels.gateway.home.label')} description={t('pilotDeckConfig.panels.gateway.home.description')}>
            <TextInput value={g.home} placeholder="~/.pilotdeck/gateway" monospace onChange={(v) => onChange(patch(config, ['gateway', 'home'], v))} />
          </FormRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function ConfigSectionGroup({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[15px] font-semibold leading-5 text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function ConfigGroupedCard({ children, divided }: { children: ReactNode; divided?: boolean }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-card/60',
        divided && 'divide-y divide-border',
      )}
    >
      {children}
    </div>
  );
}

function ConfigNavigationRow({
  section,
  onSelect,
}: {
  section: SectionId;
  onSelect: (section: SectionId) => void;
}) {
  const { t } = useTranslation('settings');
  const Icon = SECTION_ICONS[section];
  const meta = SECTIONS.find((item) => item.id === section);
  if (!meta) return null;

  return (
    <button
      type="button"
      onClick={() => onSelect(section)}
      className="flex min-h-[66px] w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-accent/35 active:bg-accent/50"
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">
          {t(`pilotDeckConfig.sections.${meta.labelKey}.label`)}
        </div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {t(`pilotDeckConfig.sections.${meta.descriptionKey}.description`)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  );
}

function ConfigSectionHome({ onSelect }: { onSelect: (section: SectionId) => void }) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      {SECTION_GROUPS.map((group) => (
        <ConfigSectionGroup
          key={group.id}
          title={t(`pilotDeckConfig.sectionGroups.${group.id}`)}
          description={group.id === 'basic' ? t('pilotDeckConfig.sectionGroups.basicDescription') : undefined}
        >
          <ConfigGroupedCard divided={group.sections.length > 1}>
            {group.sections.map((section) => (
              <ConfigNavigationRow key={section} section={section} onSelect={onSelect} />
            ))}
          </ConfigGroupedCard>
        </ConfigSectionGroup>
      ))}
    </div>
  );
}

function isSectionId(value: string | undefined): value is SectionId {
  return Boolean(value) && SECTIONS.some((section) => section.id === value);
}

// ── Main tab ───────────────────────────────────────────────────────────

export default function PilotDeckConfigTab({
  projects = [],
  initialSection,
}: {
  projects?: SettingsProject[];
  initialSection?: string;
}) {
  const { t } = useTranslation('settings');
  const {
    path,
    raw,
    setRaw,
	    exists,
	    validation,
	    reload,
	    isDirty,
	    externalChangeNotice,
	    dismissExternalNotice,
	    loading,
	    saving,
	    opening,
	    configDisabled,
	    parseError: serverParseError,
	    error,
	    refresh,
	    save,
	    reloadConfig,
	    openFile,
	  } = usePilotDeckConfig();

	  // Active form section. Null means the config page is showing its grouped
  // navigation home, matching the outer Settings page interaction model.
  const [activeSection, setActiveSection] = useState<SectionId | null>(null);
  const [showConfigDetails, setShowConfigDetails] = useState(false);

  useEffect(() => {
    if (isSectionId(initialSection)) {
      setActiveSection(initialSection);
    }
  }, [initialSection]);

  // Parse `raw` into a typed config for the form. Memoised so we don't
  // reparse on every keystroke unrelated to YAML, but raw IS the source of
  // truth — every form patch reserialises back into raw, which keeps the
  // existing save/watcher pipeline (and hot-reload) functional unchanged.
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const parseError = configDisabled || (!parsedConfig && raw.trim().length > 0);

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

  const configHasErrors = parseError || validation?.valid === false;
  const configStatusLabel = configHasErrors
    ? t('pilotDeckConfig.rawYaml.configInvalid')
    : isDirty
      ? t('pilotDeckConfig.status.unsavedChanges')
      : t('pilotDeckConfig.status.noUnsavedChanges');
  const revealFileLabel =
    typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
      ? t('pilotDeckConfig.actions.revealFileWindows')
      : typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
        ? t('pilotDeckConfig.actions.revealFileMac')
        : t('pilotDeckConfig.actions.revealFileGeneric');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
        {t('pilotDeckConfig.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsCard className="p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <button
            type="button"
            onClick={() => setShowConfigDetails((next) => !next)}
            className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/35"
            aria-expanded={showConfigDetails}
          >
            <FileCog className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold leading-5 text-foreground">
                {exists ? t('pilotDeckConfig.header.configFile') : t('pilotDeckConfig.header.configPreview')}
              </div>
              <code className="mt-1.5 block truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
                {path}
              </code>
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <span
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium leading-4',
                configHasErrors
                  ? 'bg-destructive/10 text-destructive'
                  : isDirty
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  configHasErrors ? 'bg-destructive' : isDirty ? 'bg-amber-500' : 'bg-green-500',
                )}
              />
              {configStatusLabel}
            </span>
            <Button type="button" size="sm" onClick={save} disabled={saving || !isDirty} className="h-8 gap-1.5 px-2.5 text-xs">
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {saving ? t('pilotDeckConfig.actions.saving') : t('pilotDeckConfig.actions.saveAndReloadShort')}
            </Button>
            <button
              type="button"
              onClick={() => setShowConfigDetails((next) => !next)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={showConfigDetails ? t('pilotDeckConfig.actions.hideDetails') : t('pilotDeckConfig.actions.showDetails')}
              title={showConfigDetails ? t('pilotDeckConfig.actions.hideDetails') : t('pilotDeckConfig.actions.showDetails')}
            >
              <ChevronDown className={cn('h-4 w-4 transition-transform', showConfigDetails && 'rotate-180')} />
            </button>
          </div>
        </div>

        {showConfigDetails && (
          <>
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={openFile} disabled={opening} className="h-8 gap-1.5 px-2.5 text-xs">
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  {opening ? t('pilotDeckConfig.actions.opening') : revealFileLabel}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void refresh()} className="h-8 gap-1.5 px-2.5 text-xs">
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('pilotDeckConfig.actions.refresh')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={reloadConfig} disabled={saving} className="h-8 gap-1.5 px-2.5 text-xs">
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('pilotDeckConfig.actions.reloadCurrent')}
                </Button>
              </div>

            {validation?.valid ? (
              <div className="rounded-lg bg-muted/30 px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-[13px] font-semibold leading-5 text-foreground">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
                  {t('pilotDeckConfig.rawYaml.configValid')}
                </div>
                <div className="mt-0.5 pl-4 text-[11px] leading-4 text-muted-foreground">
                  {isDirty ? t('pilotDeckConfig.status.unsavedChanges') : t('pilotDeckConfig.status.noUnsavedChanges')}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-destructive">
                <div className="flex items-center gap-2 text-[13px] font-semibold leading-5">
                  <AlertCircle className="h-4 w-4" />
                  {t('pilotDeckConfig.rawYaml.configInvalid')}
                </div>
                <div className="mt-0.5 pl-6 text-[11px] leading-4">
                  {t('pilotDeckConfig.status.fixYamlInRawEditor')}
                </div>
              </div>
            )}
            <ConfigStatusGrid config={parsedConfig} reload={reload} />
            {validation && validation.errors.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <div className="mb-1 font-semibold">{t('pilotDeckConfig.rawYaml.errors')}</div>
                <ul className="list-disc space-y-1 pl-4">
                  {validation.errors.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )}
            {validation && validation.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                <div className="mb-1 font-semibold">{t('pilotDeckConfig.rawYaml.warnings')}</div>
                <ul className="list-disc space-y-1 pl-4">
                  {validation.warnings.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )}
              {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>}
            </div>

            {externalChangeNotice && (
              <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                <div className="flex-1">{externalChangeNotice}</div>
                <button
                  type="button"
                  onClick={dismissExternalNotice}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
                >
                  {t('pilotDeckConfig.actions.dismiss')}
                </button>
              </div>
            )}
            {parseError && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {serverParseError
                  ? t('pilotDeckConfig.rawYaml.yamlParseErrorWithDetail', { error: serverParseError })
                  : t('pilotDeckConfig.rawYaml.yamlParseError')}
              </div>
            )}
          </>
        )}
      </SettingsCard>

      {!configDisabled && parsedConfig ? (
        activeSection ? (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setActiveSection(null)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('pilotDeckConfig.sections.backToMenu')}
            </button>
            <div className="min-w-0 space-y-6">
              {activeSection === 'models' && <ModelsSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'agents' && <AgentsSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'memory' && <MemorySection config={parsedConfig} projects={projects} onChange={onFormChange} />}
              {activeSection === 'tools' && <ToolsSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'router' && <RouterSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'gateway' && <GatewaySection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'officePreview' && <OfficePreviewSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'customEnv' && <CustomEnvSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'alwaysOn' && <AlwaysOnSection config={parsedConfig} projects={projects} onChange={onFormChange} />}
              {activeSection === 'cron' && <CronSection config={parsedConfig} onChange={onFormChange} />}
              {activeSection === 'advanced' && <ServiceSection config={parsedConfig} onChange={onFormChange} />}
            </div>
          </div>
        ) : (
          <ConfigSectionHome onSelect={setActiveSection} />
        )
      ) : (
        <SettingsCard className="space-y-3 p-5">
          <div>
            <div className="text-sm font-semibold text-foreground">{t('pilotDeckConfig.rawYaml.rawYaml')}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('pilotDeckConfig.rawYaml.cannotParse')}</div>
          </div>
          <textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            spellCheck={false}
            className="min-h-[360px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={save} disabled={saving || !isDirty} className="h-8 gap-1.5 px-2.5 text-xs">
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {saving ? t('pilotDeckConfig.actions.saving') : t('pilotDeckConfig.actions.saveAndReloadShort')}
            </Button>
          </div>
        </SettingsCard>
      )}

    </div>
  );
}
