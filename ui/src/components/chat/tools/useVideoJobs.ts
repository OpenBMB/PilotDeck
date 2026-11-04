import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { ChatMessage } from '../types/types';
import { videoAttachment, type VideoJobView } from './videoPresentation';

/** Poll the host's durable record, never the provider or a model. This remains
 * mounted when execution traces are collapsed or the original turn has ended. */
export function useVideoJobs(messages: ChatMessage[]) {
  const [jobs, setJobs] = useState<Record<string, VideoJobView>>({});
  const calls = messages.filter(m => m.toolName === 'generate_video' && m.sessionId && m.toolId && !videoAttachment(m))
    .map(m => ({ session: String(m.sessionId), call: m.toolId!, turn: m.turnId || m.runId || '', settled: Boolean(m.toolResult) }));
  const scope = JSON.stringify(calls);
  useEffect(() => {
    if (!calls.length) return;
    let disposed = false;
    let polling = false;
    const finished = new Set<string>();
    const controller = new AbortController();
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { await Promise.all(JSON.parse(scope).map(async ({ session, call, turn, settled }: { session: string; call: string; turn: string; settled: boolean }) => {
        const key = JSON.stringify([session, call, turn]);
        if (finished.has(key)) return;
        try {
          const response = await authenticatedFetch(`/api/video-generation/jobs/${encodeURIComponent(session)}/call/${encodeURIComponent(call)}${turn && !session.includes('::sub::') ? `?turnId=${encodeURIComponent(turn)}` : ''}`, { signal: controller.signal, suppressServerErrorToast: true });
          if (!response.ok) { if (response.status === 404 && settled) finished.add(key); return; }
          const job: VideoJobView = await response.json();
          if (['completed', 'failed', 'cancelled'].includes(job.state)) finished.add(key);
          if (!disposed) setJobs(old => JSON.stringify(old[key]) === JSON.stringify(job) ? old : { ...old, [key]: job });
        } catch { /* The next local poll also recovers a restarted Web host. */ }
      })); } finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 2500);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, [scope]);
  return useMemo(() => messages.map(message => {
    const job = jobs[JSON.stringify([message.sessionId, message.toolId, message.turnId || message.runId || ''])];
    if (!job) return message;
    return { ...message, videoJob: job, ...(job.video ? { toolResult: {
      ...message.toolResult, content: `Video recovered. video_id: ${job.video.videoId}.`, isError: false, toolUseResult: { videoGeneration: job.video },
    } } : {}) };
  }), [messages, jobs]);
}
