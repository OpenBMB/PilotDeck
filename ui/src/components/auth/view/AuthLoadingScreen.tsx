import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startupLabels } from '../../../../../apps/desktop/src/startupPresentation';
import StartupFrame from './StartupFrame';

export default function AuthLoadingScreen({ gateway = false }: { gateway?: boolean }) {
  const { i18n } = useTranslation();
  const [status, setStatus] = useState(() => window.pilotdeckDesktop?.getRuntimeStatus?.());
  useEffect(() => window.pilotdeckDesktop?.onRuntimeStatus(setStatus), []);
  const labels = startupLabels(i18n.resolvedLanguage || i18n.language);
  const phase = status?.phase === 'ready' ? 'ready' : gateway ? 'gateway' : status?.phase || 'starting';
  const progress = Math.max(gateway ? 78 : 8, status?.progress || 0);
  return <StartupFrame>
    <div role="status">
      <div role="progressbar" aria-label="PilotDeck" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none" style={{ width: progress + '%' }} />
      </div>
      <p className="mt-4 text-sm leading-5 text-muted-foreground">{labels[phase as keyof typeof labels] || labels.starting}</p>
    </div>
  </StartupFrame>;
}
