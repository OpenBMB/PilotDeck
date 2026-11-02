import type { CSSProperties, ReactNode } from 'react';
import { startupStyle } from '../../../../../apps/desktop/src/startupStyle';

export default function StartupFrame({ children, error = false, complete = false, leaving = false }: { children: ReactNode; error?: boolean; complete?: boolean; leaving?: boolean }) {
  const elapsed = Date.now() - (window.__pilotdeckStartupState?.startedAt || Date.now() - 1000);
  return <div className="pd-startup-screen" data-error={error} data-complete={complete} data-leaving={leaving} style={{
    '--startup-bg': 'hsl(var(--background))', '--startup-fg': 'hsl(var(--foreground))', '--startup-line': 'hsl(var(--border))', '--startup-muted': 'hsl(var(--muted-foreground))', animationDelay: `-${elapsed}ms`,
  } as CSSProperties}>
    <style>{startupStyle}</style>
    <main>
      <h1 className="pd-startup-brand">PilotDeck</h1>
      {children}
    </main>
  </div>;
}
