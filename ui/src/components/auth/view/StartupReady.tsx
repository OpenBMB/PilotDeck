import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import AuthLoadingScreen from './AuthLoadingScreen';
import { releaseStartupShell } from '../startupShell';

// Complete and fade the loading frame once, including very fast local starts.
export default function StartupReady({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState(() => window.__pilotdeckStartupState && !window.__pilotdeckStartupState.completed ? 'waiting' : 'done');
  useLayoutEffect(() => { if (stage === 'done') releaseStartupShell(); }, [stage]);
  useEffect(() => {
    if (stage === 'done') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const delay = reduced ? 0 : Math.max(0, 200 - (Date.now() - (window.__pilotdeckStartupState?.startedAt || Date.now())));
    const timers = [setTimeout(() => setStage('complete'), delay), setTimeout(() => setStage('leaving'), delay + (reduced ? 0 : 240)), setTimeout(() => {
      if (window.__pilotdeckStartupState) window.__pilotdeckStartupState.completed = true;
      setStage('done');
    }, delay + (reduced ? 0 : 420))];
    return () => timers.forEach(clearTimeout);
  }, []);
  return <>
    <div aria-hidden={stage !== 'done' ? true : undefined} style={{ display: 'contents', visibility: stage === 'waiting' ? 'hidden' : 'visible', pointerEvents: stage !== 'done' ? 'none' : undefined }}>{children}</div>
    {stage !== 'done' && <AuthLoadingScreen finishing complete={stage !== 'waiting'} leaving={stage === 'leaving'} />}
  </>;
}
