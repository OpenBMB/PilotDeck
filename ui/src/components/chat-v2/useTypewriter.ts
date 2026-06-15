import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * Progressively reveals text with adaptive speed.
 * - When lag is large (burst arrival), renders fast to catch up
 * - When nearly caught up, renders at a smooth readable pace
 * - When not streaming (e.g. after refresh), shows full text immediately
 */
export function useTypewriter(fullText: string, isStreaming: boolean, baseCharsPerFrame = 3): string {
  const [displayLen, setDisplayLen] = useState(() =>
    isStreaming ? 0 : fullText.length,
  );
  const rafRef = useRef<number | null>(null);
  const targetLenRef = useRef(fullText.length);
  const baseCharsRef = useRef(baseCharsPerFrame);

  targetLenRef.current = fullText.length;
  baseCharsRef.current = baseCharsPerFrame;

  const pump = useCallback(() => {
    rafRef.current = null;
    setDisplayLen((prev) => {
      const target = targetLenRef.current;
      if (prev >= target) return prev;

      // Adaptive speed: faster when far behind, slower when nearly caught up
      const lag = target - prev;
      let chars: number;
      if (lag > 200) {
        chars = Math.ceil(lag * 0.15); // Catch up fast: ~15% of lag per frame
      } else if (lag > 50) {
        chars = Math.ceil(lag * 0.1); // Medium speed
      } else {
        chars = baseCharsRef.current; // Normal speed when nearly caught up
      }

      const next = Math.min(prev + chars, target);
      rafRef.current = requestAnimationFrame(pump);
      return next;
    });
  }, []);

  // Kick-start pump whenever new text arrives and pump is idle
  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplayLen(fullText.length);
      return;
    }
    if (rafRef.current === null && fullText.length > 0) {
      rafRef.current = requestAnimationFrame(pump);
    }
  }, [isStreaming, fullText.length, pump]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  if (!isStreaming) return fullText;
  return fullText.slice(0, displayLen);
}
