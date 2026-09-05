import { useCallback, useEffect, useRef, useState } from 'react';

/** Reveal text at the same pace on 60/120 Hz displays, draining the final tail. */
export function useTypewriter(fullText: string, isStreaming: boolean, baseCharsPerFrame = 3): string {
  const [displayLen, setDisplayLen] = useState(isStreaming ? 0 : fullText.length);
  const lengthRef = useRef(displayLen);
  const hasStreamedRef = useRef(isStreaming);
  const targetRef = useRef({ fullText, isStreaming, baseCharsPerFrame });
  targetRef.current = { fullText, isStreaming, baseCharsPerFrame };
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const budgetRef = useRef(0);

  const pump = useCallback((time: number) => {
    frameRef.current = null;
    const target = targetRef.current;
    const lag = target.fullText.length - lengthRef.current;
    if (lag <= 0) {
      lastTimeRef.current = null;
      return;
    }
    const elapsed = Math.min(64, Math.max(0, time - (lastTimeRef.current ?? time)));
    lastTimeRef.current = time;
    const rate = Math.max(target.baseCharsPerFrame * 60, lag / (target.isStreaming ? 0.2 : 0.08));
    budgetRef.current += rate * elapsed / 1000;
    const count = Math.floor(budgetRef.current);
    budgetRef.current -= count;
    if (count > 0) {
      lengthRef.current = Math.min(target.fullText.length, lengthRef.current + count);
      setDisplayLen(lengthRef.current);
    }
    if (lengthRef.current < target.fullText.length) frameRef.current = requestAnimationFrame(pump);
    else lastTimeRef.current = null;
  }, []);

  useEffect(() => {
    if (isStreaming) hasStreamedRef.current = true;
    if (!hasStreamedRef.current) {
      lengthRef.current = fullText.length;
      setDisplayLen(fullText.length);
      return;
    }
    if (lengthRef.current > fullText.length) {
      lengthRef.current = fullText.length;
      setDisplayLen(fullText.length);
    }
    if (frameRef.current === null && lengthRef.current < fullText.length) {
      lastTimeRef.current = performance.now();
      frameRef.current = requestAnimationFrame(pump);
    }
  }, [fullText, isStreaming, pump]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lastTimeRef.current = null;
  }, []);

  return !hasStreamedRef.current && !isStreaming ? fullText : fullText.slice(0, displayLen);
}
