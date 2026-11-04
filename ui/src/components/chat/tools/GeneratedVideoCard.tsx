import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../types/types';
import { appendAuthToken } from '../../../utils/api';
import VideoPlayer from '../../media/VideoPlayer';
import { videoAttachment } from './videoPresentation';
import './GeneratedImageCard.css';

export default function GeneratedVideoCard({ message, running }: { message: ChatMessage; running: boolean }) {
  const { t } = useTranslation('chat');
  if (message.toolResult?.isError) return null;
  const video = videoAttachment(message);
  const url = video ? appendAuthToken(`/api/video-generation/${encodeURIComponent(String(video.sessionId))}/${encodeURIComponent(String(video.videoId))}`) : '';
  return <div className="my-3 w-full max-w-[480px]" data-tool-id={message.toolId}>
    {video ? <VideoPlayer src={url} downloadUrl={appendAuthToken(`/api/video-generation/${encodeURIComponent(String(video.sessionId))}/${encodeURIComponent(String(video.videoId))}?download=1`)} name={`video-${video.videoId}.mp4`} />
      : <div className={`generated-image-surface ${running ? 'is-waiting' : ''}`} style={{ aspectRatio: '16 / 9' }} aria-busy={running}>
        <div className="generated-image-placeholder" role="status"><span className="generated-image-glyph" aria-hidden="true">✧</span><span>{t(running ? 'videoGeneration.generating' : 'videoGeneration.interrupted')}</span></div>
      </div>}
  </div>;
}
