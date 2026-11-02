import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../types/types';
import { authenticatedFetch } from '../../../utils/api';
import ImageLightbox from '../view/subcomponents/ImageLightbox';
import './GeneratedImageCard.css';

export const isDrawingTool = (name: string) => name === 'generate_image' || name === 'edit_image';

type ImageAttachment = { imageId: string; sessionId: string; width: number; height: number; mimeType: string; savedTo?: string };
function attachmentOf(message: ChatMessage): ImageAttachment | undefined {
  const data = message.toolResult?.toolUseResult as { imageGeneration?: ImageAttachment } | undefined;
  const image = data?.imageGeneration;
  return image && typeof image.imageId === 'string' && typeof image.sessionId === 'string' ? image : undefined;
}

export default function GeneratedImageCard({ message, running }: { message: ChatMessage; running: boolean }) {
  const { t } = useTranslation('chat');
  const image = attachmentOf(message);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    let objectUrl = '';
    setLoaded(false); setLoadError(false); setUrl('');
    void authenticatedFetch(`/api/image-generation/${encodeURIComponent(image.sessionId)}/${encodeURIComponent(image.imageId)}`, {
      signal: controller.signal, suppressServerErrorToast: true,
    }).then(async response => {
      if (!response.ok) throw new Error('Image unavailable');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image?.sessionId, image?.imageId]);
  const failed = message.toolResult?.isError;
  const pending = !message.toolResult && running;
  const interrupted = !message.toolResult && !running;
  const waiting = pending || Boolean(image && !loaded && !loadError);
  const aspect = image?.width && image?.height ? `${image.width} / ${image.height}` : '1 / 1';
  const status = failed ? t('imageGeneration.failed') : loadError ? t('imageGeneration.loadFailed')
    : interrupted ? t('imageGeneration.interrupted') : loaded ? t('imageGeneration.complete')
    : image ? t('imageGeneration.loading') : t('imageGeneration.drawing');
  return <div className="generated-image-card" data-tool-id={message.toolId}>
    <div className={`generated-image-surface ${waiting ? 'is-waiting' : ''}`} style={{ aspectRatio: aspect }} aria-busy={waiting}>
      {!loaded && <div className="generated-image-placeholder" role="status"><span className="generated-image-glyph" aria-hidden="true">✧</span><span>{status}</span></div>}
      {url && <button type="button" className={`generated-image-preview ${loaded ? 'is-loaded' : ''}`} onClick={() => setExpanded(true)} aria-label={t('imageGeneration.enlarge')}>
        <img src={url} alt={t('imageGeneration.image')} onLoad={() => setLoaded(true)} onError={() => { setLoadError(true); setLoaded(false); }} />
      </button>}
    </div>
    <div className="generated-image-footer"><span>{status}</span>{loaded && url && <a href={url} download={`image-${image?.imageId}.${image?.mimeType === 'image/jpeg' ? 'jpg' : image?.mimeType.split('/')[1] || 'png'}`}>{t('imageGeneration.download')}</a>}</div>
    {failed && <p className="generated-image-error">{String(message.toolResult?.content || '')}</p>}
    {image?.savedTo && <p className="generated-image-path">{t('imageGeneration.saved', { path: image.savedTo })}</p>}
    {expanded && url && <ImageLightbox images={[{ data: url, name: t('imageGeneration.image') }]} startIndex={0} onClose={() => setExpanded(false)} />}
  </div>;
}
