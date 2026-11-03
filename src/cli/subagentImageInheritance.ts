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

/** Nested reports contain text, not trusted image metadata. Read the runtime-owned
 * child store instead, completing each edge before its report reaches its parent.
 * Existing images are verified idempotently but are not reported/delivered again.
 */
export function createSubagentImageFinalization(store: ImageStore): NonNullable<AgentRuntimeDependencies["finalizeSubagentArtifacts"]> {
  return async ({ parentSessionId, subagentSessionId, abortSignal }) => {
    abortSignal?.throwIfAborted();
    const existing = new Set((await store.list(parentSessionId)).map(image => image.imageId));
    const inherited = [];
    for (const image of await store.list(subagentSessionId)) {
      abortSignal?.throwIfAborted();
      const registered = await store.inheritOnce(subagentSessionId, image.imageId, parentSessionId);
      if (!existing.has(image.imageId)) inherited.push(describeImage(registered));
    }
    abortSignal?.throwIfAborted();
    return inherited;
  };
}
