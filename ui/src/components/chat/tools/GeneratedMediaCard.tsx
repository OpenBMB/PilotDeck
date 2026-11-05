import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types/types';
import { AnimatedDisclosure } from '../../ui/AnimatedDisclosure';
import GeneratedImageCard from './GeneratedImageCard';
import GeneratedVideoCard from './GeneratedVideoCard';
export default function GeneratedMediaCard({ message, running, visible = true }: { message: ChatMessage; running: boolean; visible?: boolean }) {
  // Freeze the last visible frame during exit. A completed intermediate must not
  // start loading an image/player that belongs in the tool's on-demand details.
  const lastVisible = useRef({ message, running });
  useLayoutEffect(() => { if (visible) lastVisible.current = { message, running }; }, [message, running, visible]);
  const frame = visible ? { message, running } : lastVisible.current;
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (visible || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [visible, mounted]);
  return <AnimatedDisclosure expanded={visible} data-media-surface>
    {mounted ? frame.message.toolName === 'generate_video' ? <GeneratedVideoCard {...frame} /> : <GeneratedImageCard {...frame} /> : null}
  </AnimatedDisclosure>;
}
