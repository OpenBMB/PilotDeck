import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LIGHT_PRESETS } from '../../../../lib/lightAppearance';
import { useFloatingPanel } from '../../../ui/useFloatingPanel';
import { GeneralSettingRow, GeneralSettingsIcon } from '../../shared/view/GeneralSettingsPrimitives';

type HSV = { h: number; s: number; v: number };
export type ColorControlHandle = { open: () => void };
type Props = { label: string; detail?: string; value: string; disabled?: boolean; onChange: (color: string) => void };

function fromHex(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

function toHex({ h, s, v }: HSV) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}

function normalizeHex(input: string) {
  let hex = input.trim().replace(/^#/, '');
  if (/^[a-f\d]{3}$/i.test(hex)) hex = hex.split('').map(c => c + c).join('');
  return /^[a-f\d]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
}

const swatches = [...Object.values(LIGHT_PRESETS).map(palette => palette.accent), LIGHT_PRESETS.blue.background, '#ffffff'];

const ColorControl = forwardRef<ColorControlHandle, Props>(function ColorControl({ label, detail, value, disabled, onChange }, ref) {
  const { t } = useTranslation('settings');
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const plane = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hsv, setHSV] = useState(() => fromHex(value));
  const [draft, setDraft] = useState(value.toUpperCase());
  const [invalid, setInvalid] = useState(false);
  const { panelRef, style } = useFloatingPanel(open, trigger, () => setOpen(false), { width: 260, maxHeight: 340, side: 'below' });

  const show = () => {
    if (disabled) return;
    setDraft(value.toUpperCase()); setInvalid(false); setHSV(fromHex(value)); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: show }));
  useEffect(() => {
    setDraft(value.toUpperCase()); setInvalid(false);
    setHSV(current => { const next = fromHex(value); return { ...next, h: next.s ? next.h : current.h }; });
  }, [value]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) plane.current?.focus({ preventScroll: true }); }, [open]);

  const apply = (hex: string) => {
    setDraft(hex.toUpperCase()); setInvalid(false);
    if (hex.toLowerCase() !== value.toLowerCase()) onChange(hex.toLowerCase());
  };
  const changeHSV = (next: HSV) => { setHSV(next); apply(toHex(next)); };
  const commit = () => { const hex = normalizeHex(draft); if (hex) apply(hex); else setInvalid(true); };
  const choosePoint = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    changeHSV({ ...hsv, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
  };
  const close = () => { setOpen(false); trigger.current?.focus(); };

  return <GeneralSettingRow title={label} detail={detail} htmlFor={id}>
    <button ref={trigger} id={id} type="button" className="appearance-color-control" aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-picker` : undefined} disabled={disabled}
      onClick={() => open ? setOpen(false) : show()}>
      <span className="appearance-color-dot" style={{ backgroundColor: value }} />
      <span className="appearance-color-value">{value.toUpperCase()}</span>
      <GeneralSettingsIcon icon={ChevronDown} />
    </button>
    {open && createPortal(<div ref={panelRef} id={`${id}-picker`} role="dialog" aria-label={label}
      className="appearance-color-popover" data-dialog-surface style={style}>
      <div className="appearance-picker-heading"><strong>{label}</strong><button type="button" onClick={close}
        aria-label={t('lightAppearance.closePicker')}><GeneralSettingsIcon icon={X} /></button></div>
      <button ref={plane} type="button" className="appearance-color-plane" aria-label={t('lightAppearance.colorPlane')}
        style={{ '--picker-hue': hsv.h } as CSSProperties}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); choosePoint(event); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) choosePoint(event); }}
        onKeyDown={event => {
          const step = event.shiftKey ? .05 : .01;
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const next = { ...hsv };
          if (event.key === 'ArrowLeft') next.s = Math.max(0, hsv.s - step);
          if (event.key === 'ArrowRight') next.s = Math.min(1, hsv.s + step);
          if (event.key === 'ArrowUp') next.v = Math.min(1, hsv.v + step);
          if (event.key === 'ArrowDown') next.v = Math.max(0, hsv.v - step);
          changeHSV(next);
        }}>
        <span className="appearance-color-cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </button>
      <input className="appearance-picker-hue" type="range" min="0" max="359" step="1" value={Math.round(hsv.h)}
        aria-label={t('lightAppearance.hue')} onChange={event => changeHSV({ ...hsv, h: Number(event.target.value) })} />
      <div className="appearance-picker-swatches">{swatches.map(hex => <button key={hex} type="button"
        aria-label={t('lightAppearance.useColor', { color: hex.toUpperCase() })} aria-pressed={value.toLowerCase() === hex.toLowerCase()}
        style={{ backgroundColor: hex }} onClick={() => { setHSV(fromHex(hex)); apply(hex); }} />)}</div>
      <label className="appearance-picker-hex"><span>HEX</span><input aria-label={`${label} HEX`} value={draft}
        maxLength={7} spellCheck={false} autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={event => { const next = event.target.value; setDraft(next); setInvalid(false); const hex = next.replace(/^#/, ''); if (/^[a-f\d]{6}$/i.test(hex)) apply('#' + hex); }}
        onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
        <span className="appearance-picker-result" style={{ backgroundColor: value }} />
      </label>
      {invalid && <p id={`${id}-error`} className="appearance-picker-error" role="alert">{t('lightAppearance.invalidColor')}</p>}
    </div>, document.body)}
  </GeneralSettingRow>;
});

export default ColorControl;
