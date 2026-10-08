import { createElement, type ComponentType, type ReactNode, type SVGProps } from 'react';
import type { LucideIcon } from 'lucide-react';

// Lucide can resolve a different React type version in this workspace. Its
// runtime component accepts the same SVG props, so adapt at this one boundary.
export function GeneralSettingsIcon({ icon, className }: { icon: LucideIcon; className?: string }) {
  return createElement(icon as ComponentType<SVGProps<SVGSVGElement> & { size: number }>, { size: 16, strokeWidth: 1.8, className, 'aria-hidden': true });
}

/** The General page's visual contract, shared with other preference pages. */
export function GeneralCardHeader({ icon, title, extra }: { icon: ReactNode; title: string; extra?: ReactNode }) {
  return <header className="general-card-header">
    <span className="general-card-header-icon" aria-hidden="true">{icon}</span>
    <h2>{title}</h2>
    {extra && <span className="general-card-header-extra">{extra}</span>}
  </header>;
}

export function GeneralSelectControl({ value, onChange, options, compact = false, id, ariaLabel, disabled }: {
  value: string; onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  compact?: boolean; id?: string; ariaLabel?: string; disabled?: boolean;
}) {
  return <div className={compact ? 'general-select-wrap compact' : 'general-select-wrap'}>
    <select id={id} aria-label={ariaLabel} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  </div>;
}

export function GeneralSettingRow({ icon, title, detail, children, htmlFor }: {
  icon?: ReactNode; title: string; detail?: string; children: ReactNode; htmlFor?: string;
}) {
  return <div className={`general-setting-row ${icon ? 'general-select-row' : 'general-toggle-row'}`}>
    {icon && <span className="general-setting-icon" aria-hidden="true">{icon}</span>}
    <div className="general-setting-copy">
      {htmlFor ? <label className="general-setting-title" htmlFor={htmlFor}>{title}</label> : <strong className="general-setting-title">{title}</strong>}
      {detail && <p>{detail}</p>}
    </div>
    {children}
  </div>;
}
