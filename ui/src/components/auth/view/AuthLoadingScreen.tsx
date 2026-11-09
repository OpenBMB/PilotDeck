import { useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startupLabels, startupVisualProgress, type StartupTiming } from '../../../../../apps/desktop/src/startupPresentation';
import StartupFrame from './StartupFrame';
import { hasStartupShell, updateStartupShell } from '../startupShell';

export default function AuthLoadingScreen({ gateway = false, finishing = false, complete = false, leaving = false }: { gateway?: boolean; finishing?: boolean; complete?: boolean; leaving?: boolean }) {
  const { i18n } = useTranslation();
  const [status, setStatus] = useState(() => window.pilotdeckDesktop?.getRuntimeStatus?.());
  const [now, setNow] = useState(Date.now);
  const persistent = hasStartupShell();
  useEffect(() => window.pilotdeckDesktop?.onRuntimeStatus(setStatus), []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 400); return () => clearInterval(timer); }, []);
  const labels = startupLabels(i18n.resolvedLanguage || i18n.language);
  const previous = window.__pilotdeckStartupState;
  const phase = finishing || complete ? 'ready' : gateway ? status?.phase === 'ready' ? 'ready' : 'gateway' : status?.phase || previous?.phase || 'starting';
  const live = status?.phase === phase ? status : undefined;
  const earlier = previous && !previous.completed && (!live?.startedAt || live.startedAt === previous.startedAt) ? previous : undefined;
  const progress = Math.max(finishing ? 96 : gateway ? 78 : 8, live?.progress || 0, earlier?.progress || 0);
  const timing: StartupTiming = { phase, progress, completed: complete,
    startedAt: live?.startedAt || earlier?.startedAt || now,
    phaseStartedAt: live?.phaseStartedAt || (earlier?.phase === phase ? earlier.phaseStartedAt : now) || now };
  if (previous) window.__pilotdeckStartupState = timing;
  useLayoutEffect(() => {
    if (persistent) updateStartupShell(timing, i18n.resolvedLanguage || i18n.language, leaving);
  }, [persistent, phase, progress, complete, leaving, timing.startedAt, timing.phaseStartedAt, i18n.resolvedLanguage, i18n.language]);
  if (persistent) return null;
  return <StartupFrame complete={complete} leaving={leaving}>
    <div role="status">
      <div role="progressbar" aria-label="PilotDeck" aria-valuemin={0} aria-valuemax={100} aria-valuenow={complete ? 100 : progress} className="pd-startup-track">
        <div className="pd-startup-bar" style={{ width: startupVisualProgress(timing, now) + '%' }} />
      </div>
      <p className="pd-startup-message">{labels[phase as keyof typeof labels] || labels.starting}</p>
    </div>
  </StartupFrame>;
}
