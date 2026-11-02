import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname } from "node:path";
import sharp from "sharp";
import type { ImageGenerationConfig } from "../../pilot/config/imageGenerationConfig.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition, PilotDeckToolExecutionOutput, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import { withFileMutation } from "./filesystem/coordinateMutation.js";
import { ImageStore, type GeneratedImage, type ImagePurpose } from "./images/ImageStore.js";
import { requestOpenAIImage } from "./images/openaiImages.js";

export type ImageToolOptions = {
  store: ImageStore;
  getConfig: () => ImageGenerationConfig | undefined;
  fetchImpl?: typeof fetch;
};
type DrawInput = {
  prompt: string; purpose: ImagePurpose; size?: string; quality?: string; background?: string; output_path?: string;
  image_ids?: string[]; reference_paths?: string[];
};
type SaveInput = { image_id: string; output_path: string };

function enabled(options: ImageToolOptions): ImageGenerationConfig {
  const config = options.getConfig();
  if (config?.enabled !== true) throw new PilotDeckToolRuntimeError("tool_unavailable", "Image generation is disabled.");
  return config;
}

function outputPath(path: string, context: PilotDeckToolRuntimeContext): string {
  const resolved = resolvePilotDeckWorkspacePath(path, context, { forWrite: true });
  if (!resolved.ok) throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message);
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())) throw new PilotDeckToolRuntimeError("invalid_tool_input", "Output path must end in .png, .jpg, .jpeg, or .webp.");
  return resolved.absolutePath;
}

async function publish(image: GeneratedImage, path: string, context: PilotDeckToolRuntimeContext): Promise<string> {
  const target = outputPath(path, context);
  return withFileMutation(context, target, async () => {
    // Resolve again inside the workspace lease; never overwrite an existing file.
    outputPath(path, context);
    const source = await readFile(image.path, { signal: context.abortSignal });
    const format = extname(target).toLowerCase();
    const bytes = await sharp(source).toFormat(format === ".png" ? "png" : format === ".webp" ? "webp" : "jpeg").toBuffer();
    await context.fileHistory?.trackEdit(target, context.messageId ?? context.turnId);
    await mkdir(dirname(target), { recursive: true });
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, bytes, { flag: "wx", signal: context.abortSignal });
      context.abortSignal?.throwIfAborted();
      await link(staging, target);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PilotDeckToolRuntimeError("file_conflict", "The output file already exists. Choose a new path.");
      throw error;
    } finally { await unlink(staging).catch(() => {}); }
    await context.fileHistory?.recordEdit?.(target, context.messageId ?? context.turnId);
    return target;
  });
}

function result(image: GeneratedImage, deliver = true): PilotDeckToolExecutionOutput {
  return {
    content: [
      { type: "text", text: `Image is attached to this conversation. image_id: ${image.imageId}. purpose: ${image.purpose ?? "deliverable"}. ${image.width}x${image.height}. `
        + (image.savedTo ? `Saved to ${image.savedTo}.` : `Stored as a durable session attachment at ${image.path}; no project file was created. Use this local attachment path for document/PPT scripts. Use save_generated_image to save it later without regenerating.`) },
      // Hosts without the Web image card need a standard attachment event.
      // Deliver the original once, independently of optional project export.
      ...(deliver && image.purpose !== "intermediate"
        ? [{ type: "file" as const, path: image.path, mimeType: image.mimeType }]
        : []),
    ],
    data: { imageGeneration: image },
  };
}

export function createImageGenerationTools(options: ImageToolOptions): PilotDeckToolDefinition[] {
  const properties = {
    prompt: { type: "string", minLength: 1, maxLength: 32000, description: "Complete visual instructions, including subject, composition, style, and exact text if needed." },
    purpose: { type: "string", enum: ["intermediate", "deliverable"], description: "Decide from the user's main goal in this turn. deliverable: the user wants the image itself, including drawing, editing, comparing candidates, or drawing and saving a file. intermediate: the image is an asset used to build a website, app, document, PPT, or another deliverable. Independent of output_path: saving a standalone drawing does not make it intermediate; a document illustration can be intermediate without a project file." },
    size: { type: "string", description: "Optional output dimensions supported by the configured model, such as 1024x1024, 1536x1024, or auto." },
    quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
    background: { type: "string", enum: ["auto", "opaque", "transparent"] },
    output_path: { type: "string", description: "Optional workspace path. OMIT for casual drawing. Set only when the user requests a saved file or a project task needs a persistent image asset. Existing files are never overwritten." },
  };
  const tools = [false, true].map((edit): PilotDeckToolDefinition<DrawInput> => ({
    name: edit ? "edit_image" : "generate_image",
    title: edit ? "Edit image" : "Generate image",
    description: (edit ? "Edit or create an image using reference images. Supply image_ids returned by earlier generation or reference_paths for workspace/uploaded images. "
      : "Draw a new image from a text prompt using the configured OpenAI image service. ")
      + "Always specify purpose. Deliverable images are displayed in the main conversation; intermediate assets stay in the expandable execution process. Do not embed intermediate images in the final reply unless the user asks to see them separately. "
      + "Every result is stored as a durable session attachment by default. Do not invent output_path for casual drawing. "
      + "For PPT/document intermediate illustrations, use the session attachment; for a website or other task that requires image assets on disk, set output_path. "
      + "To save an existing result, use save_generated_image instead of regenerating. Provider settings and credentials are supplied by the host.",
    kind: "network",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "purpose"], properties: { ...properties,
      ...(edit ? {
        image_ids: { type: "array", maxItems: 16, items: { type: "string" }, description: "Image IDs from this conversation, in reference order." },
        reference_paths: { type: "array", maxItems: 16, items: { type: "string" }, description: "Existing workspace or registered uploaded image paths." },
      } : {}) } },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    validateInput: async (input, context) => {
      if (input.purpose !== "intermediate" && input.purpose !== "deliverable") return { ok: false, issues: [{ path: "purpose", code: "invalid_schema", message: "Specify whether the image is intermediate or deliverable, based on the user's goal." }] };
      if (input.output_path) outputPath(input.output_path, context);
      if (edit && !(input.image_ids?.length || input.reference_paths?.length)) return { ok: false, issues: [{ path: "image_ids", code: "invalid_schema", message: "Supply an image_id or reference path to edit." }] };
      if ((input.image_ids?.length ?? 0) + (input.reference_paths?.length ?? 0) > 16) return { ok: false, issues: [{ path: "image_ids", code: "invalid_schema", message: "At most 16 reference images are supported." }] };
      return { ok: true, input };
    },
    execute: async (input, context) => {
      const config = enabled(options);
      const references: Array<{ bytes: Buffer; mimeType: string }> = [];
      for (const id of input.image_ids ?? []) {
        const image = await options.store.get(context.sessionId, id);
        references.push({ bytes: await readFile(image.path, { signal: context.abortSignal }), mimeType: image.mimeType });
      }
      for (const path of input.reference_paths ?? []) {
        const resolved = resolvePilotDeckWorkspacePath(path, context, { mustExist: true, allowRegisteredReadFiles: true });
        if (!resolved.ok) throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message);
        const bytes = await readFile(resolved.absolutePath, { signal: context.abortSignal });
        if (bytes.length > 32 * 1024 * 1024) throw new Error("Reference image exceeds 32 MB.");
        const format = (await sharp(bytes).metadata()).format;
        const mimeType = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[format ?? ""];
        if (!mimeType) throw new Error("Reference must be a PNG, JPEG, or WebP image.");
        references.push({ bytes, mimeType });
      }
      const bytes = await requestOpenAIImage(config, { ...input, ...(edit ? { references } : {}) }, {
        env: context.env, signal: context.abortSignal, fetchImpl: options.fetchImpl,
      });
      const image = await options.store.save(context.sessionId, bytes, context.abortSignal, input.purpose);
      if (input.output_path) {
        try { image.savedTo = await publish(image, input.output_path, context); }
        catch (error) {
          if (context.abortSignal?.aborted) throw error;
          const output = result(image);
          output.content.push({ type: "text", text: `The image was generated, but saving to the project failed: ${error instanceof Error ? error.message : String(error)}. Use save_generated_image with the image_id; do not generate it again.` });
          return output;
        }
      }
      return result(image);
    },
  }));
  return [...tools, {
    name: "save_generated_image", title: "Save generated image", kind: "filesystem",
    description: "Save a previously generated session image to a workspace path without calling the image service again. Use when the user asks to save the image or a project needs the file. The original session attachment remains available. Never overwrites existing files.",
    inputSchema: { type: "object", additionalProperties: false, required: ["image_id", "output_path"], properties: {
      image_id: { type: "string" }, output_path: properties.output_path,
    } },
    isReadOnly: () => false, isConcurrencySafe: () => true,
    execute: async (input: SaveInput, context: PilotDeckToolRuntimeContext) => {
      enabled(options);
      const image = await options.store.get(context.sessionId, input.image_id);
      image.savedTo = await publish(image, input.output_path, context);
      return result(image, false);
    },
  } as PilotDeckToolDefinition<SaveInput>];
}
