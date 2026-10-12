import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRuntime } from "../ModelRuntime.js";
import type { CanonicalUsage } from "../protocol/canonical.js";
import { normalizeAnthropicUsage } from "../response/normalizeUsage.js";

const dayFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Append one numeric JSONL record per reported usage, independently of routing. */
export class UsageCounter {
  private pending: Promise<void> = Promise.resolve();
  private directoryReady = false;

  constructor(private readonly pilotHome: string, private readonly now = () => new Date()) {}

  record(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return;
    const directory = join(this.pilotHome, "usage", "daily");
    const file = join(directory, `${dayFormatter.format(this.now())}.jsonl`);
    this.pending = this.pending.then(async () => {
      if (!this.directoryReady) {
        await mkdir(directory, { recursive: true });
        this.directoryReady = true;
      }
      // Append also preserves counts when several instances share a Pilot home.
      await appendFile(file, `${tokens}\n`, "utf8");
    }).catch(() => {
      this.directoryReady = false;
      // A counter write must never fail an LLM call.
    });
  }

  async flush(): Promise<void> { await this.pending; }
}

function reportedTokens(usage: CanonicalUsage | undefined, anthropic = false): number | undefined {
  if (!usage) return undefined;
  if (!anthropic && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens! >= 0) {
    return usage.totalTokens;
  }
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .filter((value): value is number => Number.isSafeInteger(value) && value! >= 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/** Count conversation usage, excluding titles, without changing model execution. */
export function withUsageCounter(model: ModelRuntime, counter: Pick<UsageCounter, "record">): ModelRuntime {
  const record = (usage: CanonicalUsage | undefined, anthropic = false) => {
    try {
      const tokens = reportedTokens(usage, anthropic);
      if (tokens !== undefined) counter.record(tokens);
    } catch { /* Observation must not affect execution. */ }
  };
  return {
    ...model,
    async complete(request, options) {
      const response = await model.complete(request, options);
      if (request.metadata?.purpose !== "session_title_generation") record(response.usage);
      return response;
    },
    async *stream(request, options) {
      if (request.metadata?.purpose === "session_title_generation") {
        yield* model.stream(request, options);
        return;
      }
      let usage: CanonicalUsage | undefined;
      let anthropic = false;
      try { anthropic = model.getProviderProtocol(request.provider) === "anthropic"; } catch { /* optional metadata */ }
      const observe = (next: CanonicalUsage | undefined) => {
        if (!next) return;
        usage ??= {};
        // Provider stream usage is a snapshot, sometimes updated across chunks.
        for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
          if (next[key] !== undefined) usage[key] = next[key];
        }
      };
      try {
        for await (const event of model.stream(request, options)) {
          try {
            if (event.type === "request_started") {
              // A transport retry/continuation starts a separate reported call.
              record(usage, anthropic);
              usage = undefined;
            } else if (event.type === "usage") {
              observe(event.usage);
            } else if (anthropic && event.type === "message_start") {
              // Anthropic reports input/cache usage on message_start and output
              // usage later. Read raw data only here; leave canonical events intact.
              const raw = event.raw as { message?: { usage?: unknown } } | undefined;
              observe(normalizeAnthropicUsage(raw?.message?.usage));
            }
          } catch { /* A malformed usage record cannot interrupt the stream. */ }
          yield event;
        }
      } finally {
        record(usage, anthropic);
      }
    },
  };
}
