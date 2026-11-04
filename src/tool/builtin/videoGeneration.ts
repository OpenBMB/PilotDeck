import { copyFile, link, mkdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname } from "node:path";
import type { VideoGenerationConfig } from "../../pilot/config/videoGenerationConfig.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { withFileMutation } from "./filesystem/coordinateMutation.js";
import { VideoStore, type GeneratedVideo, type VideoPurpose } from "./videos/VideoStore.js";
import { requestOpenAIVideo, type VideoRequest } from "./videos/openaiVideos.js";

export type VideoToolOptions = { store: VideoStore; getConfig: () => VideoGenerationConfig | undefined; fetchImpl?: typeof fetch; pollMs?: number };
type GenerateInput = VideoRequest & { purpose: VideoPurpose; output_path?: string };
type SaveInput = { video_id: string; output_path: string };
function enabled(options: VideoToolOptions): VideoGenerationConfig {
  const config = options.getConfig();
  if (config?.enabled !== true) throw new PilotDeckToolRuntimeError("tool_unavailable", "Video generation is disabled.");
  return config;
}
function outputPath(path: string, context: PilotDeckToolRuntimeContext): string {
  const resolved = resolvePilotDeckWorkspacePath(path, context, { forWrite: true });
  if (!resolved.ok) throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message);
  if (extname(path).toLowerCase() !== ".mp4") throw new PilotDeckToolRuntimeError("invalid_tool_input", "Output path must end in .mp4.");
  return resolved.absolutePath;
}
async function publish(video: GeneratedVideo, path: string, context: PilotDeckToolRuntimeContext): Promise<string> {
  const target = outputPath(path, context);
  return withFileMutation(context, target, async () => {
    outputPath(path, context); context.abortSignal?.throwIfAborted();
    await context.fileHistory?.trackEdit(target, context.messageId ?? context.turnId);
    await mkdir(dirname(target), { recursive: true }); const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(video.path, staging, constants.COPYFILE_EXCL); context.abortSignal?.throwIfAborted();
      await link(staging, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PilotDeckToolRuntimeError("file_conflict", "The output file already exists. Choose a new path.");
      throw error;
    } finally { await unlink(staging).catch(() => {}); }
    await context.fileHistory?.recordEdit?.(target, context.messageId ?? context.turnId); return target;
  });
}
function result(video: GeneratedVideo, deliver = true): PilotDeckToolExecutionOutput {
  return {
    content: [{ type: "text", text: `Video is attached to this conversation. video_id: ${video.videoId}. purpose: ${video.purpose}. `
      + (video.savedTo ? `Saved to ${video.savedTo}.` : `Stored as a durable session attachment at ${video.path}; no project file was created. Use save_generated_video to save it later without regenerating.`) },
      ...(deliver && video.purpose === "deliverable" ? [{ type: "file" as const, path: video.path, mimeType: video.mimeType }] : [])],
    data: { videoGeneration: video },
  };
}
export function createVideoGenerationTools(options: VideoToolOptions): PilotDeckToolDefinition[] {
  const output = { type: "string", description: "Optional workspace .mp4 path. Omit for a casual video request; set only when the user asks to save or a project needs a video asset. Existing files are never overwritten." };
  return [{
    name: "generate_video", title: "Generate video", kind: "network",
    description: "Generate a video from a text prompt using the configured OpenAI-compatible Videos API. This tool waits for the completed video. Always specify purpose: deliverable when the video itself is the user's goal; intermediate when it is an asset for a website, presentation, or another deliverable. Independent of output_path. Intermediate videos stay in the expandable execution process; do not embed them again in the final reply unless asked. Results are durable session attachments by default. To save an existing result use save_generated_video; never regenerate just to save. Host supplies model settings and credentials.",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "purpose"], properties: {
      prompt: { type: "string", minLength: 1, maxLength: 32000, description: "Describe the subject, action, camera movement, visual style, and sound if supported by the model." },
      purpose: { type: "string", enum: ["intermediate", "deliverable"], description: "Choose from the user's main goal, independently of whether it is saved to a project file." },
      seconds: { type: "number", exclusiveMinimum: 0, maximum: 60, description: "Optional duration in seconds supported by the configured model. Defaults to 5 seconds." },
      size: { type: "string", pattern: "^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$", description: "Optional WIDTHxHEIGHT supported by the configured model. Omit to use its default." },
      num_inference_steps: { type: "integer", minimum: 1, maximum: 200, description: "Optional diffusion steps for services that support this extension (for example vLLM-Omni). Omit to use the service default." },
      seed: { type: "integer", minimum: 0, maximum: 2147483647, description: "Optional reproducible seed for services supporting this extension." },
      extra_params: { type: "object", maxProperties: 32, description: "Optional model-specific overrides for services such as vLLM-Omni. Merged over the host configured defaults. For MiniMax-H3, task t2va creates a new video and aspect_ratio controls composition (for example 16:9 or 1:1); provide a matching ratio when requesting a different size." },
      output_path: output,
    } },
    isReadOnly: () => false, isConcurrencySafe: () => true,
    validateInput: async (input: GenerateInput, context: PilotDeckToolRuntimeContext) => {
      if (!["intermediate", "deliverable"].includes(input.purpose)) return { ok: false, issues: [{ path: "purpose", code: "invalid_schema", message: "Specify intermediate or deliverable based on the user's goal." }] };
      if (input.output_path) outputPath(input.output_path, context); return { ok: true, input };
    },
    execute: async (input: GenerateInput, context: PilotDeckToolRuntimeContext) => {
      const response = await requestOpenAIVideo(enabled(options), input, { env: context.env, signal: context.abortSignal, fetchImpl: options.fetchImpl, pollMs: options.pollMs });
      const video = await options.store.save(context.sessionId, response, context.abortSignal, input.purpose);
      if (input.output_path) {
        try { video.savedTo = await publish(video, input.output_path, context); }
        catch (error) {
          if (context.abortSignal?.aborted) throw error;
          const output = result(video); output.content.push({ type: "text", text: `The video was generated but project export failed: ${error instanceof Error ? error.message : String(error)}. Use save_generated_video with this video_id; do not regenerate.` }); return output;
        }
      }
      return result(video);
    },
  } as PilotDeckToolDefinition<GenerateInput>, {
    name: "save_generated_video", title: "Save generated video", kind: "filesystem",
    description: "Save an existing session video to a workspace .mp4 path without generating again. The original attachment stays available. Never overwrites files.",
    inputSchema: { type: "object", additionalProperties: false, required: ["video_id", "output_path"], properties: { video_id: { type: "string" }, output_path: output } },
    isReadOnly: () => false, isConcurrencySafe: () => true,
    execute: async (input: SaveInput, context: PilotDeckToolRuntimeContext) => {
      enabled(options); const video = await options.store.get(context.sessionId, input.video_id);
      video.savedTo = await publish(video, input.output_path, context); return result(video, false);
    },
  } as PilotDeckToolDefinition<SaveInput>];
}
