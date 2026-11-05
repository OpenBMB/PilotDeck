import { VideoJobManager } from "../tool/builtin/videos/VideoJobManager.js";
import type { AgentRuntimeDependencies } from "../agent/runtime/AgentRuntimeDependencies.js";
import { VideoStore, type GeneratedVideo } from "../tool/builtin/videos/VideoStore.js";

function describeVideo(video: GeneratedVideo) {
  return {
    key: video.videoId,
    description: `video_id: ${video.videoId}; purpose: ${video.purpose ?? "deliverable"}; session attachment: ${video.path}.`,
  };
}

/** Copy a snapshot of the parent's available videos, including earlier child outputs. */
export function createSubagentVideoPreparation(store: VideoStore, isEnabled: () => boolean): NonNullable<AgentRuntimeDependencies["prepareSubagentArtifacts"]> {
  return async ({ parentSessionId, subagentSessionId, abortSignal }) => {
    if (!isEnabled()) return [];
    await new VideoJobManager({ store, getConfig: () => undefined }).registerParent(parentSessionId, subagentSessionId);
    abortSignal?.throwIfAborted();
    const videos = await store.list(parentSessionId);
    const inherited = [];
    for (const video of videos) {
      abortSignal?.throwIfAborted();
      inherited.push(describeVideo(await store.inheritOnce(parentSessionId, video.videoId, subagentSessionId)));
    }
    abortSignal?.throwIfAborted();
    return inherited;
  };
}

/** Child ownership comes from the runtime, never from model-supplied session IDs. */
export function createSubagentVideoInheritance(store: VideoStore): NonNullable<AgentRuntimeDependencies["inheritSubagentToolResult"]> {
  return async ({ parentSessionId, subagentSessionId, result }) => {
    if (result.type !== "success" || !["generate_video", "save_generated_video"].includes(result.toolName)) return;
    const video = (result.data as { videoGeneration?: { videoId?: unknown; sessionId?: unknown } } | undefined)?.videoGeneration;
    if (!video) return;
    if (typeof video.videoId !== "string" || video.sessionId !== subagentSessionId) {
      throw new Error("Subagent video attachment does not belong to the executing child session.");
    }
    const inherited = await store.inheritOnce(subagentSessionId, video.videoId, parentSessionId);
    return describeVideo(inherited);
  };
}
