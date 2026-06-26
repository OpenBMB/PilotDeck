import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  FileCog,
  GitCommit,
  Globe2,
  Layers3,
  MessageSquare,
  Palette,
  Radio,
  RefreshCw,
  Server,
  Shield,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Button } from '../../../shared/view/ui';
import { languages } from '../../../i18n/languages';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { usePilotDeckConfig } from '../../../hooks/usePilotDeckConfig';
import { useProjectModelSettings, type ProjectModelSettings } from '../../../hooks/useProjectModelSettings';
import { useSettingsController } from '../hooks/useSettingsController';
import { useGitVersion } from '../../../hooks/useGitVersion';
import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsProps,
} from '../types/types';
import { cn } from '../../../lib/utils';
import SettingsCard from './SettingsCard';
import SettingsRow from './SettingsRow';
import SettingsSection from './SettingsSection';
import SettingsToggle from './SettingsToggle';
import PilotDeckConfigTab from './tabs/PilotDeckConfigTab';
import McpServersTab from './tabs/McpServersTab';
import PermissionsSettingsTab from './tabs/PermissionsSettingsTab';
import GatewaySettingsTab from './tabs/GatewaySettingsTab';
import AppearanceSettingsTab from './tabs/AppearanceSettingsTab';

type SettingsPage = 'main' | 'appearance' | 'config' | 'projectModels' | 'mcp' | 'permissions' | 'chatInput' | 'codeEditor' | 'gateway';

const pageFromInitialTab = (tab: string): SettingsPage => {
  if (tab === 'appearance') return 'appearance';
  if (tab === 'config') return 'config';
  if (tab === 'projectModels') return 'projectModels';
  if (tab === 'mcp') return 'mcp';
  if (tab === 'permissions') return 'permissions';
  if (tab === 'gateway') return 'gateway';
  return 'main';
};

function Settings({ isOpen, onClose, projects = [], initialTab = 'appearance' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const {
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  } = useSettingsController({ isOpen, initialTab });
  const [page, setPage] = useState<SettingsPage>(() => pageFromInitialTab(initialTab));

  useEffect(() => {
    if (!isOpen) return;
    setPage(pageFromInitialTab(initialTab));
  }, [isOpen, initialTab]);

  if (!isOpen) {
    return null;
  }

  const title = {
    main: t('title'),
    appearance: t('mainTabs.appearance'),
    config: t('mainTabs.config'),
    projectModels: t('projectModels.title', { defaultValue: 'Project Models' }),
    mcp: t('mcpConfig.title'),
    permissions: t('mainTabs.permissions'),
    chatInput: t('settingsHome.chatInput.title'),
    codeEditor: t('appearanceSettings.codeEditor.title'),
    gateway: t('gateway.title'),
  }[page];

  const maxWidth = page === 'config' || page === 'appearance' || page === 'projectModels'
    ? 'max-w-[820px]'
    : 'max-w-[760px]';

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="relative flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="absolute right-4 top-4 z-20 h-9 w-9 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
          aria-label={t('settingsHome.close')}
        >
          <X className="h-4 w-4" />
        </Button>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn('mx-auto w-full px-5 py-7 md:px-8 md:py-8', maxWidth)}>
            {page !== 'main' && (
              <button
                type="button"
                onClick={() => setPage('main')}
                className="mb-6 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('settingsHome.back')}
              </button>
            )}

            <div className="mb-7 flex items-center justify-between gap-6 pr-10">
              <h2 className="text-[26px] font-semibold leading-tight tracking-normal text-foreground">{title}</h2>
              {saveStatus === 'success' && (
                <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
              )}
            </div>

            {page === 'main' && (
              <SettingsHome
                projects={projects}
                projectSortOrder={projectSortOrder}
                onProjectSortOrderChange={setProjectSortOrder}
                onOpenPage={setPage}
              />
            )}

            {page === 'config' && <PilotDeckConfigTab projects={projects} />}
            {page === 'projectModels' && <ProjectModelsSettingsPage projects={projects} />}
            {page === 'appearance' && (
              <AppearanceSettingsTab
                projectSortOrder={projectSortOrder}
                onProjectSortOrderChange={setProjectSortOrder}
                codeEditorSettings={codeEditorSettings}
                onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
              />
            )}
            {page === 'mcp' && <McpServersTab projects={projects} />}
            {page === 'permissions' && <PermissionsSettingsTab />}
            {page === 'gateway' && <GatewaySettingsTab />}
            {page === 'chatInput' && <ChatInputSettingsPage />}
            {page === 'codeEditor' && (
              <CodeEditorSettingsPage
                settings={codeEditorSettings}
                onWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                onShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                onLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                onFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

type SettingsHomeProps = {
  projects: SettingsProps['projects'];
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  onOpenPage: (page: SettingsPage) => void;
};

function SettingsHome({ projects = [], projectSortOrder, onProjectSortOrderChange, onOpenPage }: SettingsHomeProps) {
  const { t, i18n } = useTranslation('settings');
  const { raw, setRaw, save, loading } = usePilotDeckConfig();

  const telemetryEnabled = useMemo(() => {
    try {
      const config = parseYaml(raw);
      return config?.telemetry?.enabled === true;
    } catch {
      return false;
    }
  }, [raw]);

  const handleTelemetryToggle = useCallback((value: boolean) => {
    try {
      const config = parseYaml(raw) ?? {};
      config.telemetry = { ...config.telemetry, enabled: value };
      const next = stringifyYaml(config, { indent: 2, lineWidth: 0 });
      setRaw(next);
      void save();
    } catch {
      // YAML parse/stringify failure — ignore silently.
    }
  }, [raw, setRaw, save]);

  const currentLanguage = languages.some((language) => language.value === i18n.language)
    ? i18n.language
    : 'en';

  return (
    <div className="space-y-8">
      <SettingsGroup title={t('settingsHome.basics')} description={t('settingsHome.configRequiredDescription')}>
        <GroupedCard>
          <NavigationRow
            icon={FileCog}
            title={t('mainTabs.config')}
            detail={t('settingsHome.config.detail')}
            onClick={() => onOpenPage('config')}
          />
          {projects.length > 0 && (
            <NavigationRow
              icon={Layers3}
              title={t('projectModels.title', { defaultValue: 'Project Models' })}
              detail={t('projectModels.homeDetail', { defaultValue: 'Choose a model mix for each project' })}
              onClick={() => onOpenPage('projectModels')}
            />
          )}
          <NavigationRow
            icon={Server}
            title={t('mcpConfig.title')}
            detail={t('settingsHome.mcp.detail')}
            onClick={() => onOpenPage('mcp')}
          />
          <NavigationRow
            icon={Radio}
            title={t('gateway.title')}
            detail={t('settingsHome.gateway.detail')}
            onClick={() => onOpenPage('gateway')}
          />
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.application')}>
        <GroupedCard divided>
          <NavigationRow
            icon={Palette}
            title={t('mainTabs.appearance')}
            detail={t('settingsHome.appearance.detail')}
            onClick={() => onOpenPage('appearance')}
          />
          <MenuRow
            icon={Globe2}
            title={t('account.languageLabel')}
            detail={t('account.languageDescription')}
          >
            <SelectControl
              value={currentLanguage}
              onChange={(value) => void i18n.changeLanguage(value)}
              options={languages.map((language) => ({
                value: language.value,
                label: language.nativeName,
              }))}
              className="w-40"
            />
          </MenuRow>
          <MenuRow
            icon={ArrowUpDown}
            title={t('appearanceSettings.projectSorting.label')}
            detail={t('appearanceSettings.projectSorting.description')}
          >
            <SelectControl
              value={projectSortOrder}
              onChange={(value) => onProjectSortOrderChange(value as ProjectSortOrder)}
              options={[
                { value: 'name', label: t('appearanceSettings.projectSorting.alphabetical') },
                { value: 'date', label: t('appearanceSettings.projectSorting.recentActivity') },
              ]}
              className="w-44"
            />
          </MenuRow>
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.workflow')}>
        <GroupedCard divided>
          <NavigationRow
            icon={MessageSquare}
            title={t('settingsHome.chatInput.title')}
            detail={t('settingsHome.chatInput.detail')}
            onClick={() => onOpenPage('chatInput')}
          />
          <NavigationRow
            icon={Code2}
            title={t('appearanceSettings.codeEditor.title')}
            detail={t('settingsHome.codeEditor.detail')}
            onClick={() => onOpenPage('codeEditor')}
          />
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.advanced')}>
        <GroupedCard divided>
          <NavigationRow
            icon={Shield}
            title={t('mainTabs.permissions')}
            detail={t('settingsHome.permissions.detail')}
            onClick={() => onOpenPage('permissions')}
          />
          <MenuRow
            icon={Activity}
            title={t('settingsHome.telemetry.title')}
            detail={t('settingsHome.telemetry.detail')}
          >
            <SettingsToggle
              checked={telemetryEnabled}
              onChange={handleTelemetryToggle}
              ariaLabel={t('settingsHome.telemetry.title')}
              disabled={loading}
            />
          </MenuRow>
        </GroupedCard>
      </SettingsGroup>

      <VersionUpdateSection />
    </div>
  );
}

function ChatInputSettingsPage() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('quickSettings.sections.toolDisplay')}>
        <SettingsCard divided>
          <SettingsRow label={t('quickSettings.autoExpandTools')}>
            <SettingsToggle
              checked={preferences.autoExpandTools}
              onChange={(value) => setPreference('autoExpandTools', value)}
              ariaLabel={t('quickSettings.autoExpandTools')}
            />
          </SettingsRow>
          <SettingsRow label={t('quickSettings.showRawParameters')}>
            <SettingsToggle
              checked={preferences.showRawParameters}
              onChange={(value) => setPreference('showRawParameters', value)}
              ariaLabel={t('quickSettings.showRawParameters')}
            />
          </SettingsRow>
          <SettingsRow label={t('quickSettings.showThinking')}>
            <SettingsToggle
              checked={preferences.showThinking}
              onChange={(value) => setPreference('showThinking', value)}
              ariaLabel={t('quickSettings.showThinking')}
            />
          </SettingsRow>
          {preferences.showThinking ? (
            <SettingsRow label={t('quickSettings.inlineThinking')}>
              <SettingsToggle
                checked={preferences.inlineThinking}
                onChange={(value) => setPreference('inlineThinking', value)}
                ariaLabel={t('quickSettings.inlineThinking')}
              />
            </SettingsRow>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('quickSettings.sections.viewOptions')}>
        <SettingsCard>
          <SettingsRow label={t('quickSettings.autoScrollToBottom')}>
            <SettingsToggle
              checked={preferences.autoScrollToBottom}
              onChange={(value) => setPreference('autoScrollToBottom', value)}
              ariaLabel={t('quickSettings.autoScrollToBottom')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('quickSettings.sections.inputSettings')}>
        <SettingsCard>
          <SettingsRow
            label={t('quickSettings.sendByCtrlEnter')}
            description={t('quickSettings.sendByCtrlEnterDescription')}
          >
            <SettingsToggle
              checked={preferences.sendByCtrlEnter}
              onChange={(value) => setPreference('sendByCtrlEnter', value)}
              ariaLabel={t('quickSettings.sendByCtrlEnter')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

type CodeEditorSettingsPageProps = {
  settings: CodeEditorSettingsState;
  onWordWrapChange: (value: boolean) => void;
  onShowMinimapChange: (value: boolean) => void;
  onLineNumbersChange: (value: boolean) => void;
  onFontSizeChange: (value: string) => void;
};

function CodeEditorSettingsPage({
  settings,
  onWordWrapChange,
  onShowMinimapChange,
  onLineNumbersChange,
  onFontSizeChange,
}: CodeEditorSettingsPageProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={settings.wordWrap}
              onChange={onWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={settings.showMinimap}
              onChange={onShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={settings.lineNumbers}
              onChange={onLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <SelectControl
              value={settings.fontSize}
              onChange={onFontSizeChange}
              options={['10', '11', '12', '13', '14', '15', '16', '18', '20'].map((size) => ({
                value: size,
                label: `${size}px`,
              }))}
              className="w-28"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

type ProjectModelsSettingsPageProps = {
  projects?: SettingsProps['projects'];
};

const TOKEN_TIERS = [
  { key: 'simple', label: 'Simple' },
  { key: 'medium', label: 'Medium' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'complex', label: 'Complex' },
];

export function ProjectModelsSettingsPage({ projects = [] }: ProjectModelsSettingsPageProps) {
  const { t } = useTranslation('settings');
  const [selectedProjectName, setSelectedProjectName] = useState(() => projects[0]?.name ?? '');
  const [pendingProjectName, setPendingProjectName] = useState<string | null>(null);
  const selectedProject = projects.find((project) => project.name === selectedProjectName) ?? projects[0];
  const pendingProject = projects.find((project) => project.name === pendingProjectName);
  const {
    data,
    draft,
    setDraft,
    loading,
    saving,
    error,
    message,
    dirty,
    refresh,
    save,
  } = useProjectModelSettings(
    selectedProject?.name,
    t('projectModels.saved', { defaultValue: 'Saved for this project' }),
  );

  useEffect(() => {
    if (!selectedProjectName && projects[0]?.name) {
      setSelectedProjectName(projects[0].name);
    }
  }, [projects, selectedProjectName]);

  useEffect(() => {
    if (!pendingProjectName || projects.some((project) => project.name === pendingProjectName)) return;
    setPendingProjectName(null);
  }, [pendingProjectName, projects]);

  const modelOptions = data?.modelOptions ?? [];
  const modelSelectOptions = [
    { value: '', label: t('projectModels.inherit', { defaultValue: 'Inherit global default' }) },
    ...modelOptions.map((option) => ({ value: option.id, label: option.label })),
  ];
  const currentMainModel = draft.mainModel ?? '';
  const effectiveMainModel = data?.effective.mainModel ?? data?.inherited.mainModel ?? '';

  const updateDraft = (updater: (current: ProjectModelSettings) => ProjectModelSettings) => {
    setDraft((current) => updater({ ...current }));
  };
  const updateTokenTier = (tier: string, model: string) => {
    updateDraft((current) => ({
      ...current,
      tokenSaver: {
        ...(current.tokenSaver ?? {}),
        tiers: {
          ...(current.tokenSaver?.tiers ?? {}),
          [tier]: {
            ...(current.tokenSaver?.tiers?.[tier] ?? {}),
            model: model || undefined,
          },
        },
      },
    }));
  };
  const switchProject = (projectName: string) => {
    setSelectedProjectName(projectName);
    setPendingProjectName(null);
  };
  const handleProjectSelect = (projectName: string) => {
    if (projectName === selectedProject?.name) {
      setPendingProjectName(null);
      return;
    }
    if (dirty) {
      setPendingProjectName(projectName);
      return;
    }
    switchProject(projectName);
  };
  const handleDiscardAndSwitch = () => {
    if (!pendingProjectName) return;
    switchProject(pendingProjectName);
  };
  const handleSaveAndSwitch = async () => {
    if (!pendingProjectName) return;
    const targetProjectName = pendingProjectName;
    const saved = await save();
    if (saved) {
      switchProject(targetProjectName);
    }
  };

  if (projects.length === 0) {
    return (
      <SettingsSection title={t('projectModels.title', { defaultValue: 'Project Models' })}>
        <SettingsCard>
          <div className="px-5 py-4 text-sm text-muted-foreground">
            {t('projectModels.empty', { defaultValue: 'No projects are available yet.' })}
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('projectModels.title', { defaultValue: 'Project Models' })}
        description={t('projectModels.description', {
          defaultValue: 'Store model choices in this project so chats, subagents, routing, and compaction calls use the right mix.',
        })}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('projectModels.project', { defaultValue: 'Project' })}
            description={selectedProject?.fullPath ?? selectedProject?.path}
          >
            <SelectControl
              value={selectedProject?.name ?? ''}
              onChange={handleProjectSelect}
              options={projects.map((project) => ({
                value: project.name,
                label: project.displayName || project.name,
              }))}
              className="w-64"
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectModels.configFile', { defaultValue: 'Project config file' })}
            description={data?.configPath ?? '.pilotdeck/pilotdeck.yaml'}
          >
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              {data?.exists
                ? t('projectModels.localOverride', { defaultValue: 'Local override' })
                : t('projectModels.inheritedOnly', { defaultValue: 'Inherited' })}
            </span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {pendingProjectName ? (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.8} />
              <div className="min-w-0">
                <div className="font-medium">
                  {t('projectModels.unsavedSwitchTitle', { defaultValue: 'Unsaved changes in this project' })}
                </div>
                <div className="mt-1 text-xs leading-5 text-amber-800/90 dark:text-amber-100/80">
                  {t('projectModels.unsavedSwitchDescription', {
                    project: pendingProject?.displayName || pendingProject?.name || pendingProjectName,
                    defaultValue: 'Save or discard changes before switching to {{project}}.',
                  })}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
              <Button variant="outline" size="sm" onClick={() => setPendingProjectName(null)}>
                {t('projectModels.keepEditing', { defaultValue: 'Keep editing' })}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDiscardAndSwitch} disabled={saving}>
                {t('projectModels.discardAndSwitch', { defaultValue: 'Discard & switch' })}
              </Button>
              <Button size="sm" onClick={() => void handleSaveAndSwitch()} disabled={loading || saving || modelOptions.length === 0}>
                {saving
                  ? t('projectModels.saving', { defaultValue: 'Saving...' })
                  : t('projectModels.saveAndSwitch', { defaultValue: 'Save & switch' })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <SettingsSection title={t('projectModels.mainSection', { defaultValue: 'Main Agent' })}>
        <SettingsCard divided>
          <SettingsRow
            label={t('projectModels.mainModel', { defaultValue: 'Main model' })}
            description={t('projectModels.mainModelDescription', {
              model: effectiveMainModel || t('projectModels.inherit', { defaultValue: 'global default' }),
              defaultValue: `Effective: ${effectiveMainModel || 'global default'}`,
            })}
          >
            <SelectControl
              value={currentMainModel}
              onChange={(value) => updateDraft((current) => ({ ...current, mainModel: value || undefined }))}
              options={modelSelectOptions}
              className="w-72"
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectModels.thinking', { defaultValue: 'Extended thinking' })}
            description={t('projectModels.thinkingDescription', {
              defaultValue: 'Enable only for models that support thinking.',
            })}
          >
            <SettingsToggle
              checked={draft.thinking?.enabled === true}
              onChange={(enabled) => updateDraft((current) => ({
                ...current,
                thinking: { ...(current.thinking ?? {}), enabled },
              }))}
              ariaLabel={t('projectModels.thinking', { defaultValue: 'Extended thinking' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('projectModels.routingSection', { defaultValue: 'Routing Mix' })}
        description={t('projectModels.routingDescription', {
          defaultValue: 'Optional tiers let lightweight turns use smaller models while deeper work uses stronger ones.',
        })}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('projectModels.tokenSaver', { defaultValue: 'Tier router' })}
            description={t('projectModels.tokenSaverDescription', {
              defaultValue: 'Classify each turn and choose a tier model.',
            })}
          >
            <SettingsToggle
              checked={draft.tokenSaver?.enabled === true}
              onChange={(enabled) => updateDraft((current) => ({
                ...current,
                tokenSaver: { ...(current.tokenSaver ?? {}), enabled },
              }))}
              ariaLabel={t('projectModels.tokenSaver', { defaultValue: 'Tier router' })}
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectModels.judgeModel', { defaultValue: 'Judge model' })}
            description={t('projectModels.judgeModelDescription', {
              defaultValue: 'Small model used to pick a tier before the main call.',
            })}
          >
            <SelectControl
              value={draft.tokenSaver?.judge ?? ''}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                tokenSaver: { ...(current.tokenSaver ?? {}), judge: value || undefined },
              }))}
              options={modelSelectOptions}
              className="w-72"
            />
          </SettingsRow>
          {TOKEN_TIERS.map((tier) => (
            <SettingsRow
              key={tier.key}
              label={tier.label}
              description={t('projectModels.tierDescription', {
                defaultValue: 'Model for this complexity tier',
              })}
            >
              <SelectControl
                value={draft.tokenSaver?.tiers?.[tier.key]?.model ?? ''}
                onChange={(value) => updateTokenTier(tier.key, value)}
                options={modelSelectOptions}
                className="w-72"
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('projectModels.orchestrationSection', { defaultValue: 'Subagents' })}>
        <SettingsCard divided>
          <SettingsRow
            label={t('projectModels.autoOrchestrate', { defaultValue: 'Auto orchestration' })}
            description={t('projectModels.autoOrchestrateDescription', {
              defaultValue: 'Route complex work through a planner and subagents.',
            })}
          >
            <SettingsToggle
              checked={draft.autoOrchestrate?.enabled === true}
              onChange={(enabled) => updateDraft((current) => ({
                ...current,
                autoOrchestrate: { ...(current.autoOrchestrate ?? {}), enabled },
              }))}
              ariaLabel={t('projectModels.autoOrchestrate', { defaultValue: 'Auto orchestration' })}
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectModels.orchestratorModel', { defaultValue: 'Orchestrator model' })}
            description={t('projectModels.orchestratorModelDescription', {
              defaultValue: 'Optional model for planning delegated work.',
            })}
          >
            <SelectControl
              value={draft.autoOrchestrate?.mainAgentModel ?? ''}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                autoOrchestrate: { ...(current.autoOrchestrate ?? {}), mainAgentModel: value || undefined },
              }))}
              options={modelSelectOptions}
              className="w-72"
            />
          </SettingsRow>
          <SettingsRow
            label={t('projectModels.subagentModel', { defaultValue: 'Subagent model' })}
            description={t('projectModels.subagentModelDescription', {
              defaultValue: 'Optional model forced for delegated agents.',
            })}
          >
            <SelectControl
              value={draft.autoOrchestrate?.subagentModel ?? ''}
              onChange={(value) => updateDraft((current) => ({
                ...current,
                autoOrchestrate: { ...(current.autoOrchestrate ?? {}), subagentModel: value || undefined },
              }))}
              options={modelSelectOptions}
              className="w-72"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {data?.diagnostics?.length ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          {data.diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.path ?? 'diagnostic'}-${index}`}>{diagnostic.message}</div>
          ))}
        </div>
      ) : null}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-800 dark:text-green-300">
          {message}
        </div>
      )}

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background/95 py-4 backdrop-blur">
        <div className="text-xs text-muted-foreground">
          {loading
            ? t('projectModels.loading', { defaultValue: 'Loading project settings...' })
            : dirty
              ? t('projectModels.unsaved', { defaultValue: 'Unsaved project overrides' })
              : t('projectModels.ready', { defaultValue: 'Project model settings are up to date' })}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={loading || saving}>
            {t('projectModels.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button onClick={() => void save()} disabled={!dirty || loading || saving || modelOptions.length === 0}>
            {saving
              ? t('projectModels.saving', { defaultValue: 'Saving...' })
              : t('projectModels.save', { defaultValue: 'Save Project Models' })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
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

function GroupedCard({ children, divided }: { children: ReactNode; divided?: boolean }) {
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

function MenuRow({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[66px] items-center gap-3.5 px-5 py-3">
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NavigationRow({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[66px] w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-accent/35 active:bg-accent/50"
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  );
}

function SelectControl({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-9 rounded-lg border border-transparent bg-muted px-3 text-[13px] font-medium text-foreground outline-none transition-colors',
        'hover:bg-accent focus:border-ring focus:bg-card focus:ring-1 focus:ring-ring',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function VersionUpdateSection() {
  const { t } = useTranslation('settings');
  const { info, loading, triggerUpdate, triggerRestart, fetchVersion } = useGitVersion();
  const [phase, setPhase] = useState<'idle' | 'updating' | 'success' | 'error'>('idle');

  const handleUpdate = async () => {
    setPhase('updating');
    const result = await triggerUpdate();
    setPhase(result.success ? 'success' : 'error');
  };

  const handleRestart = async () => {
    document.title = 'Restarting PilotDeck...';
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh';
    document.body.innerHTML = `
      <div style="text-align:center;font-family:system-ui,-apple-system,sans-serif">
        <svg style="width:40px;height:40px;margin-bottom:16px;animation:spin 1s linear infinite" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
        <p style="color:#ccc;font-size:1.1rem;margin:0 0 8px">Restarting PilotDeck...</p>
        <p style="color:#666;font-size:0.8rem;margin:0">Page will reload automatically when server is ready.</p>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
    triggerRestart().catch(() => {});
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/health');
        if (res.ok) { clearInterval(poll); window.location.reload(); }
      } catch { /* still down */ }
    }, 2000);
  };

  const statusText = !info
    ? t('about.checking')
    : info.hasUpdate
      ? t('about.updateAvailable')
      : t('about.upToDate');

  return (
    <SettingsGroup title={t('about.title')}>
      <GroupedCard divided>
        <div className="flex min-h-[66px] items-center gap-3.5 px-5 py-3">
          <GitCommit className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-5 text-foreground">{t('about.version')}</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {statusText}
            </div>
          </div>
          {info?.hasUpdate && phase === 'idle' && (
            <button
              type="button"
              onClick={handleUpdate}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              <Download className="h-3 w-3" />
              {t('about.updateNow')}
            </button>
          )}
        </div>

        {phase === 'updating' && (
          <div className="px-5 py-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
              <span className="text-sm font-medium text-foreground">{t('about.updating')}</span>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="flex min-h-[56px] items-center gap-3.5 px-5 py-3">
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-green-700 dark:text-green-400">{t('about.updateComplete')}</span>
            </div>
            <button
              type="button"
              onClick={handleRestart}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
            >
              <RefreshCw className="h-3 w-3" />
              {t('about.restartToApply')}
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex min-h-[56px] items-center gap-3.5 px-5 py-3">
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-red-700 dark:text-red-400">{t('about.updateFailed')}</span>
            </div>
            <button
              type="button"
              onClick={() => { setPhase('idle'); fetchVersion(); }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('about.dismiss')}
            </button>
          </div>
        )}
      </GroupedCard>
    </SettingsGroup>
  );
}

export default Settings;
