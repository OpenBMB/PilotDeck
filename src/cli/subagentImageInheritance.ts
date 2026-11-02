import type { AgentRuntimeDependencies } from "../agent/runtime/AgentRuntimeDependencies.js";
import { ImageStore } from "../tool/builtin/images/ImageStore.js";

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
    return {
      key: inherited.imageId,
      description: `image_id: ${inherited.imageId}; purpose: ${inherited.purpose ?? "deliverable"}; ${inherited.width}x${inherited.height}; session attachment: ${inherited.path}. Use this image_id with edit_image or save_generated_image in the parent session.`,
    };
  };
}
