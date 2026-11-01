import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Phase = 'hidden' | 'shown' | 'leaving';

const SHOW_MS = 1600;
const LEAVE_MS = 200;

/**
 * Transient bubble mirroring the native ⌘/Ctrl +/- window zoom on the packaged
 * desktop shell. webFrame exposes no change event, but every zoom step resizes
 * the CSS viewport, so a window resize handler that compares getZoomFactor()
 * separates zoom from plain window resizes. Shows the current percentage,
 * fades out, and offers a reset to 100% while zoomed. Mounts inert elsewhere.
 */
export default function ZoomIndicator() {
  const { t } = useTranslation('common');
  const [factor, setFactor] = useState(1);
  const [phase, setPhase] = useState<Phase>('hidden');
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const bridge = window.pilotdeckDesktop;
    if (!bridge?.getZoomFactor) return;
    let last = bridge.getZoomFactor();
    const clear = () => {
      timers.current.forEach(window.clearTimeout);
      timers.current = [];
    };
    const show = (next: number) => {
      clear();
      setFactor(next);
      setPhase('shown');
      // Rapid consecutive presses keep one bubble; each press restarts the timer.
      timers.current.push(window.setTimeout(() => {
        setPhase('leaving');
        timers.current.push(window.setTimeout(() => setPhase('hidden'), LEAVE_MS));
      }, SHOW_MS));
    };
    const onResize = () => {
      const next = bridge.getZoomFactor?.() ?? 1;
      if (next === last) return; // Plain window resize, not a zoom change.
      last = next;
      show(next);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clear();
    };
  }, []);

  if (phase === 'hidden') return null;
  const percent = Math.round(factor * 100);
  return (
    <div
      className={phase === 'leaving' ? 'zoom-indicator zoom-indicator-leaving' : 'zoom-indicator'}
      role="status"
      aria-live="polite"
      aria-label={t('zoomIndicator.label')}
    >
      <span className="zoom-indicator-percent">{percent}%</span>
      {percent !== 100 && (
        <>
          <span className="zoom-indicator-divider" aria-hidden="true" />
          <button
            type="button"
            className="zoom-indicator-reset"
            onClick={() => window.pilotdeckDesktop?.resetZoom?.()}
          >
            {t('zoomIndicator.reset')}
          </button>
        </>
      )}
    </div>
  );
}
