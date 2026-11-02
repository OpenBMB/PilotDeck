import type { AgentRuntimeDependencies } from "../agent/runtime/AgentRuntimeDependencies.js";
import { ImageStore, type GeneratedImage } from "../tool/builtin/images/ImageStore.js";

function describeImage(image: GeneratedImage) {
  return {
    key: image.imageId,
    description: `image_id: ${image.imageId}; purpose: ${image.purpose ?? "deliverable"}; ${image.width}x${image.height}; session attachment: ${image.path}.`,
  };
}

/** Copy a snapshot of the parent's available images, including earlier child outputs. */
export function createSubagentImagePreparation(store: ImageStore, isEnabled: () => boolean): NonNullable<AgentRuntimeDependencies["prepareSubagentArtifacts"]> {
  return async ({ parentSessionId, subagentSessionId, abortSignal }) => {
    if (!isEnabled()) return [];
    abortSignal?.throwIfAborted();
    const images = await store.list(parentSessionId);
    const inherited = [];
    for (const image of images) {
      abortSignal?.throwIfAborted();
      inherited.push(describeImage(await store.inheritOnce(parentSessionId, image.imageId, subagentSessionId)));
    }
    abortSignal?.throwIfAborted();
    return inherited;
  };
}

/** Child ownership comes from the runtime, never from model-supplied session IDs. */
export function createSubagentImageInheritance(store: ImageStore): NonNullable<AgentRuntimeDependencies["inheritSubagentToolResult"]> {
  return async ({ parentSessionId, subagentSessionId, result }) => {
    if (result.type !== "success" || !["generate_image", "edit_image", "save_generated_image"].includes(result.toolName)) return;
    const image = (result.data as { imageGeneration?: { imageId?: unknown; sessionId?: unknown } } | undefined)?.imageGeneration;
    if (!image) return;
    if (typeof image.imageId !== "string" || image.sessionId !== subagentSessionId) {
      throw new Error("Subagent image attachment does not belong to the executing child session.");
    }
    const inherited = await store.inheritOnce(subagentSessionId, image.imageId, parentSessionId);
    return describeImage(inherited);
  };
}
