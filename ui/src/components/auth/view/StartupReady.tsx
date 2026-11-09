import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import AuthLoadingScreen from './AuthLoadingScreen';
import { releaseStartupShell } from '../startupShell';

// Complete the existing loading frame as soon as the workspace is mounted.
export default function StartupReady({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState(() => window.__pilotdeckStartupState && !window.__pilotdeckStartupState.completed ? 'complete' : 'done');
  useLayoutEffect(() => {
    if (stage === 'done') { releaseStartupShell(); return; }
    const root = document.getElementById('root');
    if (!root) return;
    const wasInert = Boolean(root.inert);
    root.inert = true;
    root.dataset.pilotdeckStartup = stage;
    return () => { root.inert = wasInert; delete root.dataset.pilotdeckStartup; };
  }, [stage]);
  useEffect(() => {
    if (stage === 'done') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timers = [setTimeout(() => setStage('leaving'), reduced ? 0 : 240), setTimeout(() => {
      if (window.__pilotdeckStartupState) window.__pilotdeckStartupState.completed = true;
      setStage('done');
    }, reduced ? 0 : 420)];
    return () => timers.forEach(clearTimeout);
  }, []);
  return <>
    {children}
    {stage !== 'done' && <AuthLoadingScreen finishing complete leaving={stage === 'leaving'} />}
  </>;
}
