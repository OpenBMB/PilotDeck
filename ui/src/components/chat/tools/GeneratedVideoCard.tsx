import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../types/types';
import { appendAuthToken, authenticatedFetch } from '../../../utils/api';
import VideoPlayer from '../../media/VideoPlayer';
import { videoAttachment, videoJob } from './videoPresentation';
import './GeneratedImageCard.css';

export default function GeneratedVideoCard({ message, running }: { message: ChatMessage; running: boolean }) {
  const { t } = useTranslation('chat');
  const initial = videoJob(message);
  const [resumed, setResumed] = useState<typeof initial>();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState(false);
  useEffect(() => { setResumed(undefined); }, [initial]);
  const job = resumed ?? initial;
  if (job ? ['failed', 'cancelled'].includes(job.state) : message.toolResult?.isError) return null;
  const video = videoAttachment(message);
  const url = video ? appendAuthToken(`/api/video-generation/${encodeURIComponent(String(video.sessionId))}/${encodeURIComponent(String(video.videoId))}`) : '';
  const waiting = job ? ['tracking', 'reconnecting', 'downloading'].includes(job.state) : running;
  const label = job?.state === 'paused' && job.reason === 'configuration' ? 'configuration'
    : job?.state === 'reconnecting' ? 'reconnecting' : job?.state === 'downloading' ? 'downloading' : job?.state === 'paused' ? 'paused' : waiting ? 'generating' : 'interrupted';
  const resume = async () => {
    if (!job) return;
    setBusy(true); setRetryError(false);
    try {
      const response = await authenticatedFetch(`/api/video-generation/jobs/${encodeURIComponent(job.sessionId)}/${encodeURIComponent(job.id)}/resume`, { method: 'POST', body: '{}' });
      if (!response.ok) throw new Error();
      setResumed(await response.json());
    } catch { setRetryError(true); } finally { setBusy(false); }
  };
  return <div className="my-3 w-full max-w-[480px]" data-tool-id={message.toolId}>
    {video ? <VideoPlayer src={url} downloadUrl={appendAuthToken(`/api/video-generation/${encodeURIComponent(String(video.sessionId))}/${encodeURIComponent(String(video.videoId))}?download=1`)} name={`video-${video.videoId}.mp4`} />
      : <div className={`generated-image-surface ${waiting ? 'is-waiting' : ''}`} style={{ aspectRatio: '16 / 9' }} aria-busy={waiting}>
        <div className="generated-image-placeholder" role="status"><span className="generated-image-glyph" aria-hidden="true">✧</span><span>{t(`videoGeneration.${label}`)}</span>
          {job?.state === 'paused' && <button type="button" disabled={busy} onClick={resume} className="rounded border px-3 py-1.5 text-sm hover:bg-[var(--pd-accent-hover,#ede9fe)] dark:hover:bg-[var(--pd-accent-hover,#2e1065)]">{t('videoGeneration.resume')}</button>}
          {retryError && <span>{t('videoGeneration.retryUnavailable')}</span>}
        </div>
      </div>}
    {job?.exportError && <p className="mt-2 text-xs text-neutral-500">{t('videoGeneration.exportUnavailable')}</p>}
  </div>;
}
