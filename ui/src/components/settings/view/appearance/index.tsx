import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Image as ImageIcon } from 'lucide-react';
import { useTheme } from '../../../../contexts/ThemeContext';
import { deriveLightColors, DEFAULT_TRANSPARENCY, hasBackgroundImage, LIGHT_PRESETS, MAX_TRANSPARENCY, MIN_TRANSPARENCY, selectedPalette, withoutMissingImage, type LightAppearance, type LightPalette, type LightPreset, type ThemeMode } from '../../../../lib/lightAppearance';
import { deleteBackgroundImage, saveBackgroundImage } from '../../../../lib/appearanceImages';
import { normalizeInterfacePreferences, type InterfacePreferences } from '../../../../lib/interfacePreferences';
import { GeneralSelectControl, GeneralSettingRow, GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';
import SettingsToggle from '../../shared/view/SettingsToggle';
import ColorControl, { type ColorControlHandle } from './ColorControl';
import './appearance.css';

type ThemeState = {
  themeMode: ThemeMode; setThemeMode: (mode: ThemeMode) => void; isDarkMode: boolean;
  lightAppearance: LightAppearance;
  updateLightAppearance: (update: (current: LightAppearance) => LightAppearance) => Promise<boolean>;
  resetLightAppearance: () => Promise<boolean>;
  appearanceError: string | null; imageMissing: boolean; imageUrl: string | null;
  preferences: InterfacePreferences; updatePreferences: (patch: Partial<InterfacePreferences>) => Promise<boolean>; preferencesError: boolean;
};
function Slider({ label, detail, value, min = 0, max, unit, onChange }: { label: string; detail?: string; value: number; min?: number; max: number; unit: string; onChange: (n: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <GeneralSettingRow title={label} detail={detail} htmlFor={id}>
    <div className="appearance-slider"><input id={id} type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} /><input aria-label={`${label} (${unit})`} type="number" min={min} max={max} value={draft} onChange={event => { setDraft(event.target.value); if (event.target.value !== '' && event.target.validity.valid) onChange(Number(event.target.value)); }} onBlur={() => { const n = Number(draft); if (draft === '' || !Number.isFinite(n)) setDraft(String(value)); else { const bounded = Math.round(Math.min(max, Math.max(min, n))); setDraft(String(bounded)); onChange(bounded); } }} /><span aria-hidden="true">{unit}</span></div>
  </GeneralSettingRow>;
}
function Preview({ accent, background, dark = false, split = false }: { accent: string; background: string; dark?: boolean; split?: boolean }) {
  return <span className={`appearance-miniature ${dark ? 'is-dark' : ''} ${split ? 'is-system' : ''}`} style={{ '--preview-accent': accent, '--preview-bg': background } as CSSProperties} aria-hidden="true">
    <span className="mini-sidebar"><i /><i /><i /></span><span className="mini-main"><i /><i /><b /><i /></span>
  </span>;
}
export default function AppearanceSettings() {
  const { t } = useTranslation('settings');
  const theme = useTheme() as unknown as ThemeState;
  const { themeMode, setThemeMode, isDarkMode, lightAppearance: value, updateLightAppearance, resetLightAppearance, imageMissing, imageUrl, appearanceError } = theme;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hardwareActive, setHardwareActive] = useState<boolean | null>(null);
  useEffect(() => { let active = true; window.pilotdeckDesktop?.getAppearanceCapabilities?.().then(result => { if (active) setHardwareActive(result.hardwareAcceleration); }).catch(() => {}); return () => { active = false; }; }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const accentControl = useRef<ColorControlHandle>(null);
  const palette = selectedPalette(value);
  // Image controls stay hidden until a saved image is available.
  const shown = withoutMissingImage(value, imageMissing);
  const showsImage = hasBackgroundImage(shown);
  const colors = deriveLightColors(shown);
  const label = (key: string) => t(`lightAppearance.${key}`);
  const setColor = (key: keyof LightPalette, color: string) => void updateLightAppearance(current => ({ ...current, preset: 'custom', custom: { ...selectedPalette(current), [key]: color } }));
  const setBackground = (patch: Partial<LightAppearance['background']>) => { setError(null); void updateLightAppearance(current => ({ ...current, background: { ...current.background, ...patch } })); };
  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true); setError(null);
    let id: string | null = null;
    try {
      id = await saveBackgroundImage(file);
      const committed = await updateLightAppearance(current => ({ ...current, background: { ...current.background, type: 'image', imageId: id } }));
      if (!committed) { await deleteBackgroundImage(id); setError('saveFailed'); }
    } catch (cause) {
      setError(cause instanceof Error && cause.message === 'invalidImage' ? 'invalidImage' : 'imageSaveFailed');
    } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  return <div className="appearance-settings">
    <section className="general-card appearance-card">
      <div className="general-setting-row appearance-mode-row">
        <div className="general-setting-copy"><strong id="appearance-mode-label" className="general-setting-title">{label('mode')}</strong></div>
        <div className="appearance-modes" role="group" aria-labelledby="appearance-mode-label">
          {(['system', 'light', 'dark'] as const).map(mode => <button key={mode} className="appearance-choice appearance-mode" data-mode={mode} type="button" aria-pressed={themeMode === mode} onClick={() => setThemeMode(mode)}>
            <Preview accent={mode === 'dark' ? LIGHT_PRESETS.default.accent : colors.accent} background={colors.background} dark={mode === 'dark'} split={mode === 'system'} />
            <span>{t(`settingsHome.appearanceMode.${mode}`)}</span>
          </button>)}
        </div>
      </div>
    </section>

    {isDarkMode && <div className="appearance-notice"><span>{label('lightOnly')}</span><button type="button" onClick={() => setThemeMode('light')}>{label('editLight')}</button></div>}
    {(error || appearanceError || theme.preferencesError) && <p className="appearance-error" role="alert">{label(error || appearanceError || 'saveFailed')}</p>}
    <fieldset disabled={isDarkMode || uploading} className="appearance-fields">
      <section className="general-card appearance-card">
        <div className="appearance-palette-section">
          <div className="general-setting-copy appearance-palette-heading">
            <strong id="appearance-palette-label" className="general-setting-title">{label('presets')}</strong>
            <p>{label('presetHint')}</p>
          </div>
          <div id="appearance-palette" className="appearance-presets" role="group" aria-labelledby="appearance-palette-label">
            {([...Object.entries(LIGHT_PRESETS), ['custom', value.custom]] as [LightPreset, LightPalette][]).map(([preset, colors]) =>
              <button key={preset} type="button" className="appearance-choice appearance-preset" data-preset={preset} aria-pressed={value.preset === preset}
                onClick={() => { void updateLightAppearance(current => ({ ...current, preset })); if (preset === 'custom') accentControl.current?.open(); }}>
                <Preview {...colors} /><span>{label(`preset.${preset}`)}</span>
              </button>)}
          </div>
        </div>
        <ColorControl ref={accentControl} label={label('accent')} value={palette.accent} disabled={isDarkMode || uploading} onChange={color => setColor('accent', color)} />
        <ColorControl label={label('backgroundColor')} detail={label('backgroundHint')} value={palette.background} disabled={isDarkMode || uploading} onChange={color => setColor('background', color)} />
      </section>

      <section className="general-card appearance-card">
        <GeneralSettingRow title={label('background')}>
        <div className="appearance-segments" aria-label={label('backgroundType')}>
          {(['solid', 'image'] as const).map(type => <button type="button" key={type} aria-pressed={value.background.type === type} onClick={() => setBackground({ type })}>{label(type)}</button>)}
        </div>
        </GeneralSettingRow>
        {value.background.type === 'image' && <>
          <div className="appearance-card-body appearance-image-upload" aria-busy={uploading} onDragOver={event => { if (!isDarkMode && !uploading) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!isDarkMode && !uploading) void upload(event.dataTransfer.files[0]); }}>
            {imageUrl && !imageMissing ? <img src={imageUrl} alt={label('imagePreview')} /> : <span className="appearance-image-placeholder" aria-hidden="true"><GeneralSettingsIcon icon={ImageIcon} /></span>}
            <div className="general-setting-copy"><strong className="general-setting-title">{label(uploading ? 'uploading' : 'localImage')}</strong><p>{label('imageHint')}</p>
              <div className="appearance-image-actions"><button className="appearance-button" type="button" onClick={() => fileInput.current?.click()}>{label(value.background.imageId ? 'replaceImage' : 'chooseImage')}</button>
                {value.background.imageId && <button className="appearance-button" type="button" onClick={() => setBackground({ imageId: null })}>{label('removeImage')}</button>}</div>
            </div>
            <input ref={fileInput} type="file" accept=".png,.jpg,.jpeg,.webp" aria-label={label('chooseImage')} hidden onChange={event => void upload(event.target.files?.[0])} />
          </div>
          {imageMissing ? <p role="status" className="appearance-error">{label('imageMissing')}</p>
            : !value.background.imageId && <p role="status" className="appearance-help">{label('imageEmptyHint')}</p>}
          {showsImage && <>
          {/* One control for how much of the image shows through, like a
              window translucency setting; text contrast adapts automatically. */}
          <Slider label={label('transparency')} detail={label('transparencyHint')} value={value.transparency} min={MIN_TRANSPARENCY} max={MAX_TRANSPARENCY} unit="%" onChange={transparency => void updateLightAppearance(current => ({ ...current, transparency }))} />
          <Slider label={label('blur')} value={value.background.blur} max={30} unit=" px" onChange={blur => setBackground({ blur })} />
          <GeneralSettingRow title={label('fit')} htmlFor="appearance-image-fit">
            <GeneralSelectControl id="appearance-image-fit" value={value.background.fit} onChange={fit => setBackground({ fit: fit as 'cover' | 'contain' })} options={['cover', 'contain'].map(fit => ({ value: fit, label: label(fit) }))} />
          </GeneralSettingRow>
          <details className="appearance-details">
            <summary>{label('imageAdjustments')}</summary>
            <Slider label={label('brightness')} value={value.background.brightness} min={50} max={150} unit="%" onChange={brightness => setBackground({ brightness })} />
            <Slider label={label('saturation')} value={value.background.saturation} max={150} unit="%" onChange={saturation => setBackground({ saturation })} />
            <Slider label={label('positionX')} value={value.background.positionX} max={100} unit="%" onChange={positionX => setBackground({ positionX })} />
            <Slider label={label('positionY')} value={value.background.positionY} max={100} unit="%" onChange={positionY => setBackground({ positionY })} />
            <button className="appearance-button" type="button" onClick={() => { setError(null); void updateLightAppearance(current => ({ ...current, transparency: DEFAULT_TRANSPARENCY, background: { ...current.background, blur: 0, brightness: 100, saturation: 100, positionX: 50, positionY: 50, fit: 'cover' } })); }}>{label('resetImageEffects')}</button>
          </details>
          </>}
        </>}
      </section>
    </fieldset>
    <details className="appearance-advanced">
      <summary><span>{label('advanced')}</span><GeneralSettingsIcon icon={ChevronDown} className="appearance-disclosure-icon" /></summary>
      <section className="general-card appearance-card">
      <GeneralSettingRow title={label('reducedMotion')} detail={label('motionHint')} htmlFor="appearance-motion">
        <GeneralSelectControl id="appearance-motion" value={theme.preferences.reducedMotion} onChange={reducedMotion => void theme.updatePreferences({ reducedMotion: reducedMotion as InterfacePreferences['reducedMotion'] })}
          options={[{ value: 'system', label: t('settingsHome.appearanceMode.system') }, { value: 'on', label: label('on') }, { value: 'off', label: label('off') }]} />
      </GeneralSettingRow>
      <GeneralSettingRow title={label('hardwareAcceleration')} detail={label(window.pilotdeckDesktop ? 'hardwareHint' : 'browserHardwareHint')}>
        <SettingsToggle checked={theme.preferences.hardwareAcceleration} disabled={hardwareActive === null} ariaLabel={label('hardwareAcceleration')} showSuccessToast={false} onChange={hardwareAcceleration => void theme.updatePreferences({ hardwareAcceleration })} />
      </GeneralSettingRow>
      {hardwareActive !== null && hardwareActive !== theme.preferences.hardwareAcceleration && <p className="appearance-notice" role="status">{label('restartRequired')}</p>}
      </section>
    </details>
    <div className="appearance-footer"><span>{label('deviceOnly')}</span><button type="button" disabled={uploading} className="appearance-button" onClick={async () => { setError(null); await resetLightAppearance(); await theme.updatePreferences(normalizeInterfacePreferences()); }}>{label('reset')}</button></div>
  </div>;
}
