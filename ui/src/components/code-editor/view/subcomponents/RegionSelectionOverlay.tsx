import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type {
  ContentReferenceSurface,
  NormalizedRect,
} from '../../../../types/contentReference';
import {
  floatingSelectionGroupClassName,
  getFloatingActionPosition,
} from './floatingSelectionAction';

export type RegionCaptureTarget = {
  element: HTMLElement;
  surface: ContentReferenceSurface;
  pageNumber?: number;
  slideNumber?: number;
  sheetId?: string;
  sheetName?: string;
  anchorRange?: string;
  nearbyText?: string;
};

export type CapturedRegion = RegionCaptureTarget & {
  rect: NormalizedRect;
  dataUrl: string;
  width: number;
  height: number;
};

type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type RegionSelectionOverlayProps = {
  active: boolean;
  hostRef: RefObject<HTMLElement | null>;
  resolveTarget: (underlyingElement: Element | null) => RegionCaptureTarget | null;
  onCommit: (capture: CapturedRegion) => void;
  onCancel: () => void;
};

function rectFromPoints(startX: number, startY: number, endX: number, endY: number): ScreenRect {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    right: Math.max(startX, endX),
    bottom: Math.max(startY, endY),
  };
}

function clampRect(rect: ScreenRect, bounds: DOMRect): ScreenRect {
  return {
    left: Math.max(bounds.left, Math.min(bounds.right, rect.left)),
    top: Math.max(bounds.top, Math.min(bounds.bottom, rect.top)),
    right: Math.max(bounds.left, Math.min(bounds.right, rect.right)),
    bottom: Math.max(bounds.top, Math.min(bounds.bottom, rect.bottom)),
  };
}

async function captureTargetRegion(target: RegionCaptureTarget, rect: ScreenRect): Promise<CapturedRegion> {
  // Keep the capture engine out of the normal preview bundle. It is only
  // needed after the user confirms a rectangular reference.
  const { default: html2canvas } = await import('html2canvas');
  const targetRect = target.element.getBoundingClientRect();
  const bounded = clampRect(rect, targetRect);
  const canvas = await html2canvas(target.element, {
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  });
  const scaleX = canvas.width / Math.max(1, targetRect.width);
  const scaleY = canvas.height / Math.max(1, targetRect.height);
  const sourceX = Math.max(0, Math.round((bounded.left - targetRect.left) * scaleX));
  const sourceY = Math.max(0, Math.round((bounded.top - targetRect.top) * scaleY));
  const sourceWidth = Math.max(1, Math.min(canvas.width - sourceX, Math.round((bounded.right - bounded.left) * scaleX)));
  const sourceHeight = Math.max(1, Math.min(canvas.height - sourceY, Math.round((bounded.bottom - bounded.top) * scaleY)));
  const cropped = document.createElement('canvas');
  cropped.width = sourceWidth;
  cropped.height = sourceHeight;
  const context = cropped.getContext('2d');
  if (!context) throw new Error('Unable to create capture canvas.');
  context.drawImage(
    canvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  return {
    ...target,
    rect: {
      x: (bounded.left - targetRect.left) / Math.max(1, targetRect.width),
      y: (bounded.top - targetRect.top) / Math.max(1, targetRect.height),
      width: (bounded.right - bounded.left) / Math.max(1, targetRect.width),
      height: (bounded.bottom - bounded.top) / Math.max(1, targetRect.height),
    },
    dataUrl: cropped.toDataURL('image/png'),
    width: sourceWidth,
    height: sourceHeight,
  };
}

export default function RegionSelectionOverlay({
  active,
  hostRef,
  resolveTarget,
  onCommit,
  onCancel,
}: RegionSelectionOverlayProps) {
  const { t } = useTranslation('codeEditor');
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number; target: RegionCaptureTarget } | null>(null);
  const captureRequestRef = useRef(0);
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const [target, setTarget] = useState<RegionCaptureTarget | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!active) {
      captureRequestRef.current += 1;
      startRef.current = null;
      setRect(null);
      setTarget(null);
      setError(null);
      setCapturing(false);
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    const updateHostRect = () => {
      const nextRect = hostRef.current?.getBoundingClientRect();
      setHostRect(nextRect ? DOMRect.fromRect(nextRect) : null);
    };
    updateHostRect();
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updateHostRect);
    window.addEventListener('scroll', updateHostRect, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updateHostRect);
      window.removeEventListener('scroll', updateHostRect, true);
    };
  }, [active, hostRef, onCancel]);

  useEffect(() => () => {
    captureRequestRef.current += 1;
  }, []);

  const localRect = useMemo(() => {
    if (!hostRect || !rect) return null;
    return {
      left: rect.left - hostRect.left,
      top: rect.top - hostRect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  }, [hostRect, rect]);

  const actionPosition = useMemo(() => {
    if (!hostRect || !localRect) return null;
    return getFloatingActionPosition({
      anchorX: localRect.left + localRect.width / 2,
      anchorY: localRect.top + localRect.height,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
      actionWidth: 288,
      actionHeight: 44,
      preferredPlacement: 'below',
    });
  }, [hostRect, localRect]);

  if (!active || !hostRect) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed z-[110] cursor-crosshair touch-none overflow-visible bg-blue-500/[0.03]"
      style={{
        left: hostRect.left,
        top: hostRect.top,
        width: hostRect.width,
        height: hostRect.height,
      }}
      aria-label={t('contentReference.regionSelection.ariaLabel')}
      onPointerDown={(event) => {
        if (capturing || event.button !== 0) return;
        const overlay = overlayRef.current;
        if (!overlay) return;
        overlay.style.pointerEvents = 'none';
        const underlyingElement = document.elementFromPoint(event.clientX, event.clientY);
        overlay.style.pointerEvents = '';
        const nextTarget = resolveTarget(underlyingElement);
        if (!nextTarget) {
          setError(t('contentReference.regionSelection.invalidStart'));
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        startRef.current = { x: event.clientX, y: event.clientY, target: nextTarget };
        setTarget(nextTarget);
        setRect({ left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });
        setError(null);
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start) return;
        const bounds = start.target.element.getBoundingClientRect();
        setRect(clampRect(rectFromPoints(start.x, start.y, event.clientX, event.clientY), bounds));
      }}
      onPointerUp={(event) => {
        const start = startRef.current;
        if (!start) return;
        startRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const bounds = start.target.element.getBoundingClientRect();
        const nextRect = clampRect(rectFromPoints(start.x, start.y, event.clientX, event.clientY), bounds);
        if (nextRect.right - nextRect.left < 8 || nextRect.bottom - nextRect.top < 8) {
          setRect(null);
          setTarget(null);
          setError(t('contentReference.regionSelection.tooSmall'));
          return;
        }
        setRect(nextRect);
      }}
    >
      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-blue-200 bg-white/95 px-3 py-1.5 text-[12px] text-blue-700 shadow-sm backdrop-blur dark:border-blue-800 dark:bg-neutral-950/95 dark:text-blue-300">
        {t('contentReference.regionSelection.hint')}
      </div>
      {localRect ? (
        <div
          className="pointer-events-none absolute border-2 border-blue-500 bg-blue-400/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.16)]"
          style={localRect}
        />
      ) : null}
      {localRect && target && rect && actionPosition ? (
        <div
          className={`absolute z-10 ${floatingSelectionGroupClassName}`}
          style={actionPosition}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            disabled={capturing}
            className="rounded-xl bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={async () => {
              const requestId = captureRequestRef.current + 1;
              captureRequestRef.current = requestId;
              setCapturing(true);
              setError(null);
              try {
                const capture = await captureTargetRegion(target, rect);
                if (captureRequestRef.current !== requestId) return;
                onCommit(capture);
              } catch {
                if (captureRequestRef.current !== requestId) return;
                setError(t('contentReference.regionSelection.captureFailed'));
                setCapturing(false);
              }
            }}
          >
            {capturing
              ? t('contentReference.regionSelection.capturing')
              : t('contentReference.addToChat')}
          </button>
          <button
            type="button"
            disabled={capturing}
            className="rounded-xl px-2.5 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            onClick={() => {
              setRect(null);
              setTarget(null);
              setError(null);
            }}
          >
            {t('contentReference.regionSelection.selectAgain')}
          </button>
          <button
            type="button"
            disabled={capturing}
            className="rounded-xl px-2.5 py-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            onClick={onCancel}
          >
            {t('contentReference.regionSelection.cancel')}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-red-600 px-3 py-1.5 text-[12px] text-white shadow-lg">
          {error}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
