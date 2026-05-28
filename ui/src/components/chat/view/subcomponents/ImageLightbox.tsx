import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LightboxImage {
  data: string;
  name?: string;
  mimeType?: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  startIndex?: number;
  onClose: () => void;
}

const ImageLightbox = ({ images, startIndex = 0, onClose }: ImageLightboxProps) => {
  const safeStart = useMemo(() => {
    if (images.length === 0) return 0;
    if (startIndex < 0) return 0;
    if (startIndex >= images.length) return images.length - 1;
    return startIndex;
  }, [images.length, startIndex]);
  const [activeIndex, setActiveIndex] = useState(safeStart);

  useEffect(() => {
    setActiveIndex(safeStart);
  }, [safeStart]);

  const showPrev = useCallback(() => {
    setActiveIndex((index) => (index <= 0 ? images.length - 1 : index - 1));
  }, [images.length]);
  const showNext = useCallback(() => {
    setActiveIndex((index) => (index >= images.length - 1 ? 0 : index + 1));
  }, [images.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (images.length <= 1) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        showNext();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, showPrev, showNext, images.length]);

  // Prevent the body from scrolling while the lightbox is open.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  if (typeof document === 'undefined') return null;
  if (images.length === 0) return null;

  const active = images[activeIndex];

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={active?.name || 'Image preview'}
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white shadow-sm transition hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        aria-label="Close preview"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {images.length > 1 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            showPrev();
          }}
          className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white shadow-sm transition hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Previous image"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      ) : null}

      {images.length > 1 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            showNext();
          }}
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white shadow-sm transition hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          aria-label="Next image"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      ) : null}

      <figure
        className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          key={active.data}
          src={active.data}
          alt={active.name || 'Image preview'}
          className="max-h-[88vh] max-w-[92vw] rounded-md object-contain shadow-2xl"
        />
        {active.name || images.length > 1 ? (
          <figcaption className="flex items-center gap-2 text-xs text-white/80">
            {active.name ? <span className="truncate">{active.name}</span> : null}
            {images.length > 1 ? (
              <span className="rounded-full bg-white/15 px-2 py-0.5 tabular-nums">
                {activeIndex + 1} / {images.length}
              </span>
            ) : null}
          </figcaption>
        ) : null}
      </figure>
    </div>,
    document.body,
  );
};

export default ImageLightbox;
