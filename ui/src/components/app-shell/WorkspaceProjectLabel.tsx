import type { ReactNode } from 'react';

/** The same project identity line in chat and task workspaces. */
export default function WorkspaceProjectLabel({ label, children }: { label: string; children?: ReactNode }) {
  return <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-[var(--pd-muted,#687080)]">
    <svg aria-hidden="true" className="icon" fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="13">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M8 10v4" /><path d="M12 10v2" /><path d="M16 10v6" />
    </svg>
    <span className="min-w-0 max-w-[24rem] truncate" title={label}>{label}</span>
    {children}
  </span>;
}
