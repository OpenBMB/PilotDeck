import type { ReactNode } from 'react';

export default function StartupFrame({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground" style={{ paddingTop: 'calc(1.5rem + var(--desktop-caption-height, 0px))' }}>
    <main className={`w-full text-center ${error ? 'max-w-[440px]' : 'max-w-[360px]'}`}>
      <div aria-hidden="true" className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-xl bg-foreground text-3xl font-bold text-background">P</div>
      <h1 className="mb-6 text-2xl font-bold leading-8">PilotDeck</h1>
      {children}
    </main>
  </div>;
}
