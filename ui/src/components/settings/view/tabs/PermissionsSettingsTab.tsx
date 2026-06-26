import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Plus, Server, Shield, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../../../shared/view/ui';
import { isImeEnterEvent } from '../../../../utils/ime';
import {
  PILOTDECK_SETTINGS_KEY,
  fetchPilotDeckPermissionSettings,
  getPilotDeckSettings,
  safeLocalStorage,
  savePilotDeckPermissionSettings,
} from '../../../chat/utils/chatStorage';
import type { PilotDeckSettings } from '../../../chat/types/types';
import type { SudoPermissionPolicy, SudoPolicyAction } from '../../../chat/types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

const IS_WINDOWS = typeof navigator !== 'undefined'
  && /win/i.test(navigator.userAgent)
  && !/darwin/i.test(navigator.userAgent);

// Curated convenience shortcuts shown in the Permissions tab. Users can
// still type any free-form pattern the PilotDeck permission DSL accepts —
// these are just one-click presets for the most common allow-list entries.
const QUICK_ADD_TOOLS = [
  'bash:git log:*',
  'bash:git diff:*',
  'bash:git status:*',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'agent',
  'task_create',
  'web_fetch',
  'web_search',
];

const QUICK_BLOCK_TOOLS_UNIX = ['bash:rm:*'];
const QUICK_BLOCK_TOOLS_WINDOWS = [
  'bash:rm:*',
  'bash:Remove-Item:*',
  'bash:del /s:*',
  'bash:rd /s:*',
  'bash:Format-Volume:*',
  'bash:Start-Process:*',
];
const QUICK_BLOCK_TOOLS = IS_WINDOWS ? QUICK_BLOCK_TOOLS_WINDOWS : QUICK_BLOCK_TOOLS_UNIX;

const DEFAULT_SUDO_POLICY: SudoPermissionPolicy = {
  local: 'deny',
  remote: 'deny',
  remoteHosts: [],
};

const SUDO_ACTIONS: SudoPolicyAction[] = ['deny', 'ask', 'allow'];

const addUnique = (items: string[], value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed || items.includes(trimmed)) return items;
  return [...items, trimmed];
};

const removeValue = (items: string[], value: string): string[] =>
  items.filter((item) => item !== value);

function persist(updates: Partial<PilotDeckSettings>) {
  const current = getPilotDeckSettings();
  const next: PilotDeckSettings = {
    ...current,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(next));
  // Tell other tabs / mounted components (notably the chat permission
  // suggestion in MessageComponent) to re-read from localStorage.
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  savePilotDeckPermissionSettings(updates).catch((error) => {
    console.error('Failed to persist permission settings to backend:', error);
  });
  return next;
}

// Import/export payload shape. Versioned so future migrations can bump it
// without breaking older exports — we'll widen the validator if/when the
// shape changes.
type PermissionsExport = {
  version: 2;
  exportedAt: string;
  source: 'pilotdeck';
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  sudoPolicy: SudoPermissionPolicy;
};

type ParsedPermissionsImport = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions?: boolean;
  sudoPolicy?: SudoPermissionPolicy;
};

function buildExportPayload(): PermissionsExport {
  const settings = getPilotDeckSettings();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    source: 'pilotdeck',
    allowedTools: settings.allowedTools,
    disallowedTools: settings.disallowedTools,
    skipPermissions: settings.skipPermissions,
    sudoPolicy: normalizeSudoPolicy(settings.sudoPolicy),
  };
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer revoke so Safari has a tick to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// Lenient parser — accepts the canonical shape we export but also any object
// that has at least one of the known array fields. Anything we don't
// recognize is silently dropped.
function parsePermissionsImport(raw: string): ParsedPermissionsImport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  };

  const allowedTools = toStringArray(obj.allowedTools);
  const disallowedTools = toStringArray(obj.disallowedTools);

  const sudoPolicy = obj.sudoPolicy ? normalizeSudoPolicy(obj.sudoPolicy) : undefined;

  if (
    allowedTools.length === 0
    && disallowedTools.length === 0
    && typeof obj.skipPermissions !== 'boolean'
    && sudoPolicy === undefined
  ) {
    return null;
  }

  return {
    allowedTools,
    disallowedTools,
    skipPermissions: typeof obj.skipPermissions === 'boolean' ? obj.skipPermissions : undefined,
    ...(sudoPolicy ? { sudoPolicy } : {}),
  };
}

export function getPermissionsImportImpactForTest(parsed: ParsedPermissionsImport) {
  return {
    affectsSkipPermissions: parsed.skipPermissions !== undefined,
    affectsSudoPolicy: parsed.sudoPolicy !== undefined,
    sudoHostCount: parsed.sudoPolicy?.remoteHosts.length ?? 0,
  };
}

const mergeUnique = (a: string[], b: string[]): string[] => {
  const seen = new Set(a);
  const out = [...a];
  for (const item of b) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
};

function buildImportConfirmDetails(
  parsed: ParsedPermissionsImport,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const details: string[] = [];
  if (parsed.skipPermissions !== undefined) {
    details.push(`- ${t('permissions.importConfirmSkipPermissions', {
      value: parsed.skipPermissions
        ? t('permissions.values.enabled', { defaultValue: 'enabled' })
        : t('permissions.values.disabled', { defaultValue: 'disabled' }),
      defaultValue: 'Skip permission prompts: {{value}}',
    })}`);
  }
  if (parsed.sudoPolicy) {
    const hostCount = parsed.sudoPolicy.remoteHosts.length;
    const hostText = hostCount === 1
      ? t('permissions.importConfirmSudoHostSingular', { defaultValue: '1 host override' })
      : t('permissions.importConfirmSudoHostPlural', {
        hosts: hostCount,
        defaultValue: '{{hosts}} host overrides',
      });
    details.push(`- ${t('permissions.importConfirmSudoPolicy', {
      local: t(`permissions.sudoPolicy.actions.${parsed.sudoPolicy.local}`, {
        defaultValue: parsed.sudoPolicy.local,
      }),
      remote: t(`permissions.sudoPolicy.actions.${parsed.sudoPolicy.remote}`, {
        defaultValue: parsed.sudoPolicy.remote,
      }),
      hostText,
      defaultValue: 'sudo policy: local {{local}}, remote {{remote}}, {{hostText}}',
    })}`);
  }

  if (details.length === 0) {
    return '';
  }

  return `\n\n${t('permissions.importConfirmDetailsIntro', {
    defaultValue: 'This import also changes:',
  })}\n${details.join('\n')}`;
}

function buildImportSuccessDetails(
  parsed: ParsedPermissionsImport,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const details: string[] = [];
  if (parsed.skipPermissions !== undefined) {
    details.push(t('permissions.importSuccessSkipPermissions', {
      defaultValue: 'Skip permission prompts updated.',
    }));
  }
  if (parsed.sudoPolicy) {
    details.push(t('permissions.importSuccessSudoPolicy', {
      defaultValue: 'sudo policy updated.',
    }));
  }
  return details.length ? ` ${details.join(' ')}` : '';
}

type StatusBanner =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | null;

export default function PermissionsSettingsTab() {
  const { t } = useTranslation('settings');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disallowedTools, setDisallowedTools] = useState<string[]>([]);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [sudoPolicy, setSudoPolicy] = useState<SudoPermissionPolicy>(DEFAULT_SUDO_POLICY);
  const [newAllowed, setNewAllowed] = useState('');
  const [newBlocked, setNewBlocked] = useState('');
  const [newSudoHost, setNewSudoHost] = useState('');
  const [newSudoHostAction, setNewSudoHostAction] = useState<SudoPolicyAction>('deny');
  const [banner, setBanner] = useState<StatusBanner>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    const settings = getPilotDeckSettings();
    setAllowedTools(settings.allowedTools);
    setDisallowedTools(settings.disallowedTools);
    setSkipPermissions(settings.skipPermissions);
    setSudoPolicy(normalizeSudoPolicy(settings.sudoPolicy));
  }, []);

  useEffect(() => {
    reload();
    fetchPilotDeckPermissionSettings()
      .then((settings) => {
        safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify(settings));
        setAllowedTools(settings.allowedTools);
        setDisallowedTools(settings.disallowedTools);
        setSkipPermissions(settings.skipPermissions);
        setSudoPolicy(normalizeSudoPolicy(settings.sudoPolicy));
      })
      .catch((error) => {
        console.error('Failed to load permission settings from backend:', error);
      });
    // so users can flip back and forth between the chat and this dialog
    // without seeing stale state.
    const onStorage = (event: StorageEvent) => {
      if (event.key === PILOTDECK_SETTINGS_KEY) reload();
    };
    const onCustom = () => reload();
    window.addEventListener('storage', onStorage);
    window.addEventListener('pilotdeck-settings-changed', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pilotdeck-settings-changed', onCustom);
    };
  }, [reload]);

  const handleAddAllowed = (value: string) => {
    const next = addUnique(allowedTools, value);
    if (next === allowedTools) return;
    setAllowedTools(next);
    persist({ allowedTools: next });
    setNewAllowed('');
  };

  const handleRemoveAllowed = (value: string) => {
    const next = removeValue(allowedTools, value);
    setAllowedTools(next);
    persist({ allowedTools: next });
  };

  const handleAddBlocked = (value: string) => {
    const next = addUnique(disallowedTools, value);
    if (next === disallowedTools) return;
    setDisallowedTools(next);
    persist({ disallowedTools: next });
    setNewBlocked('');
  };

  const handleRemoveBlocked = (value: string) => {
    const next = removeValue(disallowedTools, value);
    setDisallowedTools(next);
    persist({ disallowedTools: next });
  };

  const handleSkipPermissionsChange = (value: boolean) => {
    setSkipPermissions(value);
    persist({ skipPermissions: value });
  };

  const handleSudoPolicyChange = (updates: Partial<SudoPermissionPolicy>) => {
    const next = normalizeSudoPolicy({ ...sudoPolicy, ...updates });
    setSudoPolicy(next);
    persist({ sudoPolicy: next });
  };

  const handleAddSudoHost = () => {
    const host = newSudoHost.trim();
    if (!host) return;
    const remoteHosts = [
      ...sudoPolicy.remoteHosts.filter((entry) => entry.host.toLowerCase() !== host.toLowerCase()),
      { host, action: newSudoHostAction },
    ];
    handleSudoPolicyChange({ remoteHosts });
    setNewSudoHost('');
  };

  const handleRemoveSudoHost = (host: string) => {
    handleSudoPolicyChange({
      remoteHosts: sudoPolicy.remoteHosts.filter((entry) => entry.host !== host),
    });
  };

  // Auto-dismiss the import/export banner after 4s. The user gets to read
  // the result without it lingering forever.
  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handleExport = () => {
    try {
      const payload = buildExportPayload();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`pilotdeck-permissions-${stamp}.json`, payload);
      setBanner({
        kind: 'success',
        message: t('permissions.exportSuccess', {
          allowed: payload.allowedTools.length,
          blocked: payload.disallowedTools.length,
          defaultValue:
            'Exported {{allowed}} allowed and {{blocked}} blocked tools.',
        }),
      });
    } catch (err) {
      console.error('Failed to export permissions:', err);
      setBanner({
        kind: 'error',
        message: t('permissions.exportError', {
          defaultValue: 'Failed to export permissions.',
        }),
      });
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so picking the same file twice still fires `change`.
    event.target.value = '';
    if (!file) return;

    let raw: string;
    try {
      raw = await file.text();
    } catch (err) {
      console.error('Failed to read import file:', err);
      setBanner({
        kind: 'error',
        message: t('permissions.importReadError', {
          defaultValue: 'Could not read the selected file.',
        }),
      });
      return;
    }

    const parsed = parsePermissionsImport(raw);
    if (!parsed) {
      setBanner({
        kind: 'error',
        message: t('permissions.importInvalid', {
          defaultValue:
            'Not a valid permissions export. Expected JSON with allowedTools / disallowedTools.',
        }),
      });
      return;
    }

    // Default to merge — safer than replace, and we de-dup. If users want a
    // hard reset they can clear entries first or hit "Replace" via the
    // confirm prompt (a real Replace path is a future-nice; merge covers
    // the common "share my allowlist with a teammate" case fully).
    const importDetails = buildImportConfirmDetails(parsed, t);
    const summary = t('permissions.importConfirmBody', {
      allowed: parsed.allowedTools.length,
      blocked: parsed.disallowedTools.length,
      details: importDetails,
      defaultValue:
        'Merge {{allowed}} allowed and {{blocked}} blocked tools into your existing permissions?{{details}}',
    });
    if (!window.confirm(summary)) {
      setBanner(null);
      return;
    }

    const current = getPilotDeckSettings();
    const nextAllowed = mergeUnique(current.allowedTools, parsed.allowedTools);
    const nextBlocked = mergeUnique(current.disallowedTools, parsed.disallowedTools);
    const updates: Partial<PilotDeckSettings> = {
      allowedTools: nextAllowed,
      disallowedTools: nextBlocked,
      ...(parsed.skipPermissions !== undefined ? { skipPermissions: parsed.skipPermissions } : {}),
      ...(parsed.sudoPolicy ? { sudoPolicy: parsed.sudoPolicy } : {}),
    };
    persist(updates);

    setAllowedTools(nextAllowed);
    setDisallowedTools(nextBlocked);
    if (parsed.skipPermissions !== undefined) {
      setSkipPermissions(parsed.skipPermissions);
    }
    if (parsed.sudoPolicy) {
      setSudoPolicy(parsed.sudoPolicy);
    }

    const addedAllowed = nextAllowed.length - current.allowedTools.length;
    const addedBlocked = nextBlocked.length - current.disallowedTools.length;
    setBanner({
      kind: 'success',
      message: t('permissions.importSuccess', {
        addedAllowed,
        addedBlocked,
        details: buildImportSuccessDetails(parsed, t),
        defaultValue:
          'Imported. Added {{addedAllowed}} allowed and {{addedBlocked}} blocked tools.{{details}}',
      }),
    });
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('permissions.title', { defaultValue: 'Permissions' })}
        description={t('permissions.description', {
          defaultValue:
            'Manage which tools the assistant can run without asking. Grants from the chat "Add permission" button land here too.',
        })}
      >
        {/* Import / export. Hidden file input lives outside flow so the
            keyboard handler still works and sr-only screen reader users
            can still trigger it via the labelled button. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleFileChosen}
        />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="h-8 gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            {t('permissions.export', { defaultValue: 'Export' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleImportClick}
            className="h-8 gap-1.5 text-xs"
          >
            <Upload className="h-3.5 w-3.5" />
            {t('permissions.import', { defaultValue: 'Import' })}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('permissions.importExportHint', {
              defaultValue: 'Share or back up your tool permissions as JSON.',
            })}
          </span>
        </div>

        {banner ? (
          <div
            role="status"
            className={
              banner.kind === 'success'
                ? 'mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-200'
                : 'mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'
            }
          >
            {banner.message}
          </div>
        ) : null}

        <SettingsCard divided>
          <SettingsRow
            label={
              <span className="inline-flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                {t('permissions.skipPermissions.title', { defaultValue: 'Skip permission prompts' })}
              </span>
            }
            description={t('permissions.skipPermissions.description', {
              defaultValue:
                'Run tool calls without asking for confirmation. This maps to bypassPermissions and should only be used in trusted workspaces.',
            })}
          >
            <SettingsToggle
              checked={skipPermissions}
              ariaLabel={t('permissions.skipPermissions.title', { defaultValue: 'Skip permission prompts' })}
              onChange={handleSkipPermissionsChange}
            />
          </SettingsRow>
          {skipPermissions ? (
            <div className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {t('permissions.skipPermissions.warning', {
                defaultValue:
                  'Permission prompts are currently bypassed. Allowed and blocked rules below are still saved, but this global mode lets the agent run without asking.',
              })}
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-2">
            <Server className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            {t('permissions.sudoPolicy.title', { defaultValue: 'sudo policy' })}
          </span>
        }
        description={t('permissions.sudoPolicy.description', {
          defaultValue: 'Choose how PilotDeck handles sudo locally, over SSH, and for specific remote hosts.',
        })}
      >
        <SettingsCard divided>
          <SudoPolicyRow
            label={t('permissions.sudoPolicy.local.label', { defaultValue: 'Local sudo' })}
            description={t('permissions.sudoPolicy.local.description', {
              defaultValue: 'Applies when sudo would run on this machine.',
            })}
            value={sudoPolicy.local}
            onChange={(action) => handleSudoPolicyChange({ local: action })}
            t={t}
          />
          <SudoPolicyRow
            label={t('permissions.sudoPolicy.remote.label', { defaultValue: 'Remote sudo default' })}
            description={t('permissions.sudoPolicy.remote.description', {
              defaultValue: 'Applies to sudo detected inside ssh remote commands unless a host rule overrides it.',
            })}
            value={sudoPolicy.remote}
            onChange={(action) => handleSudoPolicyChange({ remote: action })}
            t={t}
          />
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={newSudoHost}
                onChange={(event) => setNewSudoHost(event.target.value)}
                placeholder={t('permissions.sudoPolicy.hosts.placeholder', {
                  defaultValue: 'Host, user@host, IP, or wildcard like prod-*',
                })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    if (isImeEnterEvent(event)) return;
                    event.preventDefault();
                    handleAddSudoHost();
                  }
                }}
                className="h-10 flex-1"
              />
              <select
                value={newSudoHostAction}
                onChange={(event) => setNewSudoHostAction(event.target.value as SudoPolicyAction)}
                className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                aria-label={t('permissions.sudoPolicy.hosts.actionLabel', { defaultValue: 'Host sudo action' })}
              >
                {SUDO_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {t(`permissions.sudoPolicy.actions.${action}`, { defaultValue: action })}
                  </option>
                ))}
              </select>
              <Button
                onClick={handleAddSudoHost}
                disabled={!newSudoHost.trim()}
                size="sm"
                className="h-10 px-4"
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {t('permissions.actions.add', { defaultValue: 'Add' })}
              </Button>
            </div>
            <div className="space-y-2">
              {sudoPolicy.remoteHosts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
                  {t('permissions.sudoPolicy.hosts.empty', {
                    defaultValue: 'No remote host overrides configured.',
                  })}
                </div>
              ) : (
                sudoPolicy.remoteHosts.map((entry) => (
                  <div
                    key={`${entry.host}:${entry.action}`}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <code className="font-mono text-xs text-foreground">{entry.host}</code>
                      <span className="ml-2 rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t(`permissions.sudoPolicy.actions.${entry.action}`, { defaultValue: entry.action })}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveSudoHost(entry.host)}
                      className="h-7 w-7 p-0"
                      aria-label={t('permissions.actions.remove', { defaultValue: 'Remove' })}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-2">
            <Shield className="h-4 w-4 text-green-600 dark:text-green-400" />
            {t('permissions.allowedTools.title', { defaultValue: 'Allowed tools' })}
          </span>
        }
        description={t('permissions.allowedTools.description', {
          defaultValue: 'Tools that auto-run without prompting.',
        })}
      >
        <SettingsCard className="space-y-3 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newAllowed}
              onChange={(event) => setNewAllowed(event.target.value)}
              placeholder={t('permissions.allowedTools.placeholder', {
                defaultValue: 'e.g. "bash:git log:*" or "write_file"',
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (isImeEnterEvent(event)) {
                    return;
                  }
                  event.preventDefault();
                  handleAddAllowed(newAllowed);
                }
              }}
              className="h-10 flex-1"
            />
            <Button
              onClick={() => handleAddAllowed(newAllowed)}
              disabled={!newAllowed.trim()}
              size="sm"
              className="h-10 px-4"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('permissions.actions.add', { defaultValue: 'Add' })}
            </Button>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t('permissions.allowedTools.quickAdd', { defaultValue: 'Quick add:' })}
            </p>
            <div className="flex flex-wrap gap-2">
              {QUICK_ADD_TOOLS.map((tool) => (
                <Button
                  key={tool}
                  variant="outline"
                  size="sm"
                  onClick={() => handleAddAllowed(tool)}
                  disabled={allowedTools.includes(tool)}
                  className="h-7 text-xs"
                >
                  {tool}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {allowedTools.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
                {t('permissions.allowedTools.empty', {
                  defaultValue: 'No allowed tools configured yet.',
                })}
              </div>
            ) : (
              allowedTools.map((tool) => (
                <div
                  key={tool}
                  className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2 dark:border-green-900/50 dark:bg-green-950/30"
                >
                  <code className="font-mono text-xs text-green-800 dark:text-green-200">
                    {tool}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveAllowed(tool)}
                    className="h-7 w-7 p-0 text-green-700 hover:text-green-900 dark:text-green-300"
                    aria-label={t('permissions.actions.remove', { defaultValue: 'Remove' })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
            {t('permissions.blockedTools.title', { defaultValue: 'Blocked tools' })}
          </span>
        }
        description={t('permissions.blockedTools.description', {
          defaultValue: 'Tools the assistant is never allowed to use.',
        })}
      >
        <SettingsCard className="space-y-3 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={newBlocked}
              onChange={(event) => setNewBlocked(event.target.value)}
              placeholder={t('permissions.blockedTools.placeholder', {
                defaultValue: 'e.g. "Bash(rm:*)"',
              })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (isImeEnterEvent(event)) {
                    return;
                  }
                  event.preventDefault();
                  handleAddBlocked(newBlocked);
                }
              }}
              className="h-10 flex-1"
            />
            <Button
              onClick={() => handleAddBlocked(newBlocked)}
              disabled={!newBlocked.trim()}
              size="sm"
              className="h-10 px-4"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('permissions.actions.add', { defaultValue: 'Add' })}
            </Button>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t('permissions.allowedTools.quickAdd', { defaultValue: 'Quick add:' })}
            </p>
            <div className="flex flex-wrap gap-2">
              {QUICK_BLOCK_TOOLS.map((tool) => (
                <Button
                  key={tool}
                  variant="outline"
                  size="sm"
                  onClick={() => handleAddBlocked(tool)}
                  disabled={disallowedTools.includes(tool)}
                  className="h-7 text-xs"
                >
                  {tool}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {disallowedTools.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-5 text-center text-xs text-muted-foreground">
                {t('permissions.blockedTools.empty', {
                  defaultValue: 'No blocked tools configured.',
                })}
              </div>
            ) : (
              disallowedTools.map((tool) => (
                <div
                  key={tool}
                  className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/50 dark:bg-red-950/30"
                >
                  <code className="font-mono text-xs text-red-800 dark:text-red-200">{tool}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveBlocked(tool)}
                    className="h-7 w-7 p-0 text-red-700 hover:text-red-900 dark:text-red-300"
                    aria-label={t('permissions.actions.remove', { defaultValue: 'Remove' })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('permissions.toolExamples.title', { defaultValue: 'Pattern examples' })}
      >
        <SettingsCard className="p-4">
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">bash:git log:*</code>{' '}
              {t('permissions.toolExamples.bashGitLog', { defaultValue: '— allow all git log commands' })}
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">bash:git diff:*</code>{' '}
              {t('permissions.toolExamples.bashGitDiff', { defaultValue: '— allow all git diff commands' })}
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">write_file</code>{' '}
              {t('permissions.toolExamples.write', { defaultValue: '— allow all writes' })}
            </li>
            <li>
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">bash:rm:*</code>{' '}
              {t('permissions.toolExamples.bashRm', { defaultValue: '— block all rm commands (dangerous)' })}
            </li>
            {IS_WINDOWS ? (
              <>
                <li>
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">bash:Remove-Item:*</code>{' '}
                  {t('permissions.toolExamples.bashRemoveItem', { defaultValue: '— block PowerShell Remove-Item' })}
                </li>
                <li>
                  <code className="rounded bg-muted px-1 py-0.5 text-foreground">bash:del /s:*</code>{' '}
                  {t('permissions.toolExamples.bashDel', { defaultValue: '— block CMD recursive delete' })}
                </li>
              </>
            ) : null}
          </ul>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

function SudoPolicyRow({
  label,
  description,
  value,
  onChange,
  t,
}: {
  label: string;
  description: string;
  value: SudoPolicyAction;
  onChange: (value: SudoPolicyAction) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <SettingsRow label={label} description={description}>
      <div className="flex rounded-md border border-border p-0.5">
        {SUDO_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => onChange(action)}
            className={
              value === action
                ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                : 'rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground'
            }
          >
            {t(`permissions.sudoPolicy.actions.${action}`, { defaultValue: action })}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

function normalizeSudoPolicy(value: unknown): SudoPermissionPolicy {
  const obj = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SudoPermissionPolicy>
    : {};
  return {
    local: normalizeSudoAction(obj.local, DEFAULT_SUDO_POLICY.local),
    remote: normalizeSudoAction(obj.remote, DEFAULT_SUDO_POLICY.remote),
    remoteHosts: Array.isArray(obj.remoteHosts)
      ? obj.remoteHosts
        .map((entry) => {
          const record = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as { host?: unknown; action?: unknown }
            : {};
          return {
            host: typeof record.host === 'string' ? record.host.trim() : '',
            action: normalizeSudoAction(record.action, 'deny'),
          };
        })
        .filter((entry) => entry.host.length > 0)
      : [],
  };
}

function normalizeSudoAction(value: unknown, fallback: SudoPolicyAction): SudoPolicyAction {
  return value === 'deny' || value === 'ask' || value === 'allow' ? value : fallback;
}
