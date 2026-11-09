import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './VideoPlayer.css';

/** Direct authenticated media URL: native Range requests support seeking and bounded memory. */
export default function VideoPlayer({ src, downloadUrl = src, name = 'video.mp4' }: { src: string; downloadUrl?: string; name?: string }) {
  const { t } = useTranslation('chat');
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  return <div className="video-player group">
    <video key={src} src={src} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} />
    {failed && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{t('videoGeneration.playbackUnavailable')}</p>}
    <a className={`video-player-download ${failed ? 'is-visible' : ''}`} href={downloadUrl} download={name} aria-label={t('videoGeneration.download')} title={t('videoGeneration.download')}><Download size={18} aria-hidden="true" /></a>
  </div>;
}
