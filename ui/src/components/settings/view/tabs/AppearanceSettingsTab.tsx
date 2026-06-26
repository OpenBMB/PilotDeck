import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Palette, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../../contexts/ThemeContext';
import { useAppearanceProfile } from '../../../../contexts/AppearanceProfileContext';
import {
  type AppearanceDensity,
  type AppearanceFont,
  type AppearanceLayout,
  type AppearancePalette,
  type AppearanceProfile,
  hexToHslTriplet,
  hslTripletToHex,
  readAppearanceAssetFile,
} from '../../../../lib/appearanceProfiles';
import { Button } from '../../../../shared/view/ui';
import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { cn } from '../../../../lib/utils';

type ThemeMode = 'system' | 'light' | 'dark';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

type EditableColor = {
  key: keyof AppearancePalette;
  label: string;
};

const editableColors: EditableColor[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'accent', label: 'Accent' },
  { key: 'background', label: 'Background' },
  { key: 'card', label: 'Panel' },
  { key: 'foreground', label: 'Text' },
  { key: 'border', label: 'Border' },
];

export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { themeMode = 'system', setThemeMode } = useTheme() as {
    themeMode?: ThemeMode;
    setThemeMode?: (mode: ThemeMode) => void;
  };
  const {
    presets,
    profiles,
    activeProfile,
    activeProfileId,
    setActiveProfileId,
    createFromPreset,
    duplicateProfile,
    updateProfile,
    deleteProfile,
    resetProfiles,
  } = useAppearanceProfile();
  const [selectedPresetId, setSelectedPresetId] = useState(presets[0]?.id ?? '');

  const customActive = !activeProfile.readonly;
  const allProfiles = useMemo(() => [...presets, ...profiles], [presets, profiles]);

  const applyPreset = () => {
    createFromPreset(selectedPresetId);
  };

  const updateActiveProfile = (patch: Partial<AppearanceProfile>) => {
    if (!customActive) return;
    updateProfile(activeProfile.id, patch);
  };

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0];

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.brand.title')}>
        <SettingsCard>
          <div className="space-y-5 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label={t('appearanceSettings.brand.activeProfile')}>
                <SelectControl
                  value={activeProfileId}
                  onChange={setActiveProfileId}
                  options={allProfiles.map((profile) => ({
                    value: profile.id,
                    label: profile.readonly ? `${profile.name} preset` : profile.name,
                  }))}
                />
              </Field>
              <Field label={t('appearanceSettings.brand.preset')}>
                <SelectControl
                  value={selectedPresetId}
                  onChange={setSelectedPresetId}
                  options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
                />
              </Field>
              <Button type="button" onClick={applyPreset} className="shrink-0">
                <Palette className="h-4 w-4" />
                {t('appearanceSettings.brand.applyPreset')}
              </Button>
            </div>

            <ProfilePreview profile={customActive ? activeProfile : selectedPreset} />

            {!customActive ? (
              <div className="rounded-md border border-border bg-muted/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {t('appearanceSettings.brand.readonlyPreset')}
              </div>
            ) : null}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.brand.identity')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.brand.profileName')}
            description={t('appearanceSettings.brand.profileNameDescription')}
          >
            <TextInput
              value={activeProfile.name}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ name: value })}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.brandName')}>
            <TextInput
              value={activeProfile.brandName}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ brandName: value })}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.tagline')}>
            <TextInput
              value={activeProfile.tagline}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ tagline: value })}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.brand.logoLight')}
            description={t('appearanceSettings.brand.assetDescription')}
          >
            <AssetInput
              value={activeProfile.logoLight}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ logoLight: value })}
              placeholder="/logo.svg or data:image/png;base64,..."
              uploadLabel={t('appearanceSettings.brand.uploadAsset')}
              tooLargeText={t('appearanceSettings.brand.assetTooLarge')}
              readErrorText={t('appearanceSettings.brand.assetReadError')}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.logoDark')}>
            <AssetInput
              value={activeProfile.logoDark}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ logoDark: value })}
              placeholder="/logo-dark.svg or data:image/png;base64,..."
              uploadLabel={t('appearanceSettings.brand.uploadAsset')}
              tooLargeText={t('appearanceSettings.brand.assetTooLarge')}
              readErrorText={t('appearanceSettings.brand.assetReadError')}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.favicon')}>
            <AssetInput
              value={activeProfile.favicon}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ favicon: value })}
              placeholder="/favicon.svg"
              uploadLabel={t('appearanceSettings.brand.uploadAsset')}
              tooLargeText={t('appearanceSettings.brand.assetTooLarge')}
              readErrorText={t('appearanceSettings.brand.assetReadError')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.brand.system')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('settingsHome.appearanceMode.title')}
            description={t('settingsHome.appearanceMode.detail')}
          >
            <SelectControl
              value={themeMode}
              onChange={(value) => setThemeMode?.(value as ThemeMode)}
              options={[
                { value: 'system', label: t('settingsHome.appearanceMode.system') },
                { value: 'light', label: t('settingsHome.appearanceMode.light') },
                { value: 'dark', label: t('settingsHome.appearanceMode.dark') },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.font')}>
            <SelectControl
              value={activeProfile.font}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ font: value as AppearanceFont })}
              options={[
                { value: 'inter', label: 'Inter' },
                { value: 'system', label: 'System' },
                { value: 'mono', label: 'Mono' },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.density')}>
            <SelectControl
              value={activeProfile.density}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ density: value as AppearanceDensity })}
              options={[
                { value: 'comfortable', label: t('appearanceSettings.brand.comfortable') },
                { value: 'compact', label: t('appearanceSettings.brand.compact') },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.layout')}>
            <SelectControl
              value={activeProfile.layout}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ layout: value as AppearanceLayout })}
              options={[
                { value: 'balanced', label: t('appearanceSettings.brand.layoutBalanced') },
                { value: 'compactTools', label: t('appearanceSettings.brand.layoutCompactTools') },
                { value: 'spacious', label: t('appearanceSettings.brand.layoutSpacious') },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t('appearanceSettings.brand.radius')}>
            <SelectControl
              value={activeProfile.radius}
              disabled={!customActive}
              onChange={(value) => updateActiveProfile({ radius: value })}
              options={[
                { value: '0.25rem', label: '4px' },
                { value: '0.375rem', label: '6px' },
                { value: '0.5rem', label: '8px' },
                { value: '0.75rem', label: '12px' },
              ]}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.brand.colors')}>
        <SettingsCard>
          <div className="grid gap-5 p-5 md:grid-cols-2">
            <PaletteEditor
              title={t('settingsHome.appearanceMode.light')}
              disabled={!customActive}
              palette={activeProfile.theme.light}
              onChange={(palette) => updateActiveProfile({ theme: { ...activeProfile.theme, light: palette } })}
            />
            <PaletteEditor
              title={t('settingsHome.appearanceMode.dark')}
              disabled={!customActive}
              palette={activeProfile.theme.dark}
              onChange={(palette) => updateActiveProfile({ theme: { ...activeProfile.theme, dark: palette } })}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <SelectControl
              value={projectSortOrder}
              onChange={(value) => onProjectSortOrderChange(value as ProjectSortOrder)}
              options={[
                { value: 'name', label: t('appearanceSettings.projectSorting.alphabetical') },
                { value: 'date', label: t('appearanceSettings.projectSorting.recentActivity') },
              ]}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <SelectControl
              value={codeEditorSettings.fontSize}
              onChange={onCodeEditorFontSizeChange}
              options={['10', '11', '12', '13', '14', '15', '16', '18', '20'].map((size) => ({
                value: size,
                label: `${size}px`,
              }))}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.brand.manage')}>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => duplicateProfile(activeProfile.id, `${activeProfile.name} Copy`)}
          >
            <Copy className="h-4 w-4" />
            {t('appearanceSettings.brand.duplicate')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={resetProfiles}
          >
            <RotateCcw className="h-4 w-4" />
            {t('appearanceSettings.brand.reset')}
          </Button>
          {customActive ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteProfile(activeProfile.id)}
            >
              <Trash2 className="h-4 w-4" />
              {t('appearanceSettings.brand.delete')}
            </Button>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0 flex-1">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-72"
    />
  );
}

function AssetInput({
  value,
  onChange,
  disabled,
  placeholder,
  uploadLabel,
  tooLargeText,
  readErrorText,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  uploadLabel: string;
  tooLargeText: string;
  readErrorText: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const readFile = (file: File) => {
    readAppearanceAssetFile(file)
      .then((result) => {
        setError('');
        onChange(result);
      })
      .catch((error: Error) => {
        setError(error.message === 'asset-too-large' ? tooLargeText : readErrorText);
      });
  };

  return (
    <div className="w-full min-w-0 space-y-2 sm:w-auto">
      <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row">
        <TextInput
          value={value}
          disabled={disabled}
          onChange={(next) => {
            setError('');
            onChange(next);
          }}
          placeholder={placeholder}
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/*,.svg"
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) readFile(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="h-9 shrink-0"
        >
          <Upload className="h-4 w-4" />
          {uploadLabel}
        </Button>
      </div>
      {error ? (
        <div className="text-xs text-destructive">{error}</div>
      ) : null}
    </div>
  );
}

function SelectControl({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] font-medium text-foreground outline-none transition-colors focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-44"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ProfilePreview({ profile }: { profile?: AppearanceProfile }) {
  const safeProfile = profile;
  if (!safeProfile) return null;

  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: `hsl(${safeProfile.theme.light.border})`,
        background: `hsl(${safeProfile.theme.light.background})`,
        color: `hsl(${safeProfile.theme.light.foreground})`,
        borderRadius: safeProfile.radius,
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <img
          src={safeProfile.logoLight}
          alt={safeProfile.brandName}
          className="h-8 w-auto max-w-[160px] object-contain"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{safeProfile.brandName}</div>
          <div className="truncate text-xs opacity-70">{safeProfile.tagline}</div>
        </div>
        <div
          className="ml-auto h-8 rounded-md px-3 text-xs font-semibold leading-8"
          style={{
            background: `hsl(${safeProfile.theme.light.primary})`,
            color: `hsl(${safeProfile.theme.light.primaryForeground})`,
          }}
        >
          Primary
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1 border-t p-3" style={{ borderColor: `hsl(${safeProfile.theme.light.border})` }}>
        {editableColors.map((item) => (
          <div
            key={item.key}
            className="h-7 rounded"
            title={item.label}
            style={{ background: `hsl(${safeProfile.theme.light[item.key]})` }}
          />
        ))}
      </div>
    </div>
  );
}

function PaletteEditor({
  title,
  palette,
  disabled,
  onChange,
}: {
  title: string;
  palette: AppearancePalette;
  disabled?: boolean;
  onChange: (palette: AppearancePalette) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="space-y-2">
        {editableColors.map((item) => (
          <ColorRow
            key={item.key}
            label={item.label}
            value={palette[item.key]}
            disabled={disabled}
            onChange={(value) => onChange({ ...palette, [item.key]: value })}
          />
        ))}
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const hexValue = hslTripletToHex(value);
  return (
    <label className={cn('flex items-center gap-3', disabled && 'opacity-60')}>
      <input
        type="color"
        value={hexValue}
        disabled={disabled}
        onChange={(event) => {
          const next = hexToHslTriplet(event.target.value);
          if (next) onChange(next);
        }}
        className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0 disabled:cursor-not-allowed"
      />
      <span className="min-w-0 flex-1 text-xs font-medium text-foreground">{label}</span>
      <code className="hidden rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground sm:block">
        {hexValue}
      </code>
    </label>
  );
}
