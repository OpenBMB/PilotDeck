import type { CanonicalMessage } from "../../model/index.js";
import type {
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
} from "./MemoryResolver.js";

export type MemoryAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: MemoryDiagnostic[];
};

export type MemoryAttachmentBuilderInput = MemoryRetrieveInput & {
  timeoutMs?: number;
};

/**
 * Build attachment messages from MemoryResolver output. Used by both:
 *   - PromptAssembler input (Phase 6): turn-start memory section
 *   - CompactionEngine.buildPostCompactMessages: post-compact reinjection
 *
 * Failure is non-fatal; diagnostics surface upstream.
 */
export class MemoryAttachmentBuilder {
  constructor(private readonly resolver: MemoryResolver) {}

  async build(input: MemoryAttachmentBuilderInput): Promise<MemoryAttachmentBuilderResult> {
    if (input.signal?.aborted) {
      return { attachments: [], diagnostics: [] };
    }
    const controller = new AbortController();
    const detachAbort = forwardAbort(input.signal, controller);
    const timeoutMs = input.timeoutMs;
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`Memory retrieval timed out after ${timeoutMs}ms.`)), timeoutMs)
      : undefined;
    try {
      const result = await Promise.race([
        this.resolver.retrieve({ ...input, signal: controller.signal }),
        waitForAbort(controller.signal),
      ]);
      if (!result.systemContext || result.systemContext.trim().length === 0) {
        return { attachments: [], diagnostics: result.diagnostics ?? [] };
      }
      const attachments: CanonicalMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `<memory-context>\n${result.systemContext.trim()}\n</memory-context>`,
            },
          ],
        },
      ];
      return { attachments, diagnostics: result.diagnostics ?? [] };
    } catch (error) {
      if (controller.signal.aborted) {
        if (input.signal?.aborted) {
          return { attachments: [], diagnostics: [] };
        }
        return {
          attachments: [],
          diagnostics: [{
            code: "memory_provider_error",
            severity: "warning",
            message: timeoutMs && timeoutMs > 0
              ? `MemoryResolver.retrieve timed out after ${timeoutMs}ms.`
              : "MemoryResolver.retrieve was aborted.",
          }],
        };
      }
      return {
        attachments: [],
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "warning",
            message: `MemoryResolver.retrieve failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    } finally {
      if (timer) clearTimeout(timer);
      detachAbort?.();
    }
  }
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throwAbortError(signal.reason);
  }
  return await new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwAbortError(reason?: unknown): never {
  throw createAbortError(reason);
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}
