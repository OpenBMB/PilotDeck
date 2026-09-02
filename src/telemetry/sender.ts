import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AnalyticsEvent,
  AnalyticsEventEnvelope,
  TelemetryConfig,
  TelemetrySenderMetrics,
} from "./types.js";

type TelemetrySenderDeps = {
  fetchImpl?: typeof fetch;
};

export class TelemetrySender {
  private readonly fetchImpl: typeof fetch;
  private readonly queue: AnalyticsEventEnvelope[] = [];
  private readonly metrics: TelemetrySenderMetrics = {
    queued: 0,
    sent: 0,
    sendFailures: 0,
    retries: 0,
    dropped: 0,
    queueDepth: 0,
  };

  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private hasBeenEnabled: boolean;

  constructor(
    private config: TelemetryConfig,
    deps: TelemetrySenderDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hasBeenEnabled = this.config.enabled;
    this.restoreQueue();
    if (this.config.enabled) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.config.flushIntervalMs);
      this.timer.unref();
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    this.config = { ...this.config, enabled };
    if (enabled) {
      this.hasBeenEnabled = true;
      if (!this.timer) {
        this.timer = setInterval(() => {
          void this.flush();
        }, this.config.flushIntervalMs);
        this.timer.unref();
      }
    } else {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      void this.flush();
    }
  }

  enqueue(event: AnalyticsEvent): void {
    if (!this.config.enabled) {
      return;
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      this.metrics.dropped += 1;
      this.syncQueueDepth();
      return;
    }
    this.queue.push({ event, attempts: 0 });
    this.metrics.queued += 1;
    this.syncQueueDepth();
    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.flushing || this.queue.length === 0) {
      return;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.config.batchSize);
        try {
          await this.sendBatch(batch.map((item) => item.event));
          this.metrics.sent += batch.length;
          this.metrics.lastSuccessAt = new Date().toISOString();
        } catch {
          this.metrics.sendFailures += 1;
          for (const item of batch) {
            if (item.attempts + 1 > this.config.maxRetries) {
              this.metrics.dropped += 1;
              continue;
            }
            this.metrics.retries += 1;
            this.queue.unshift({ ...item, attempts: item.attempts + 1 });
          }
          break;
        } finally {
          this.syncQueueDepth();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.hasBeenEnabled) {
      this.persistQueue();
    }
  }

  snapshot(): TelemetrySenderMetrics {
    this.syncQueueDepth();
    return { ...this.metrics };
  }

  private async sendBatch(batch: AnalyticsEvent[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("telemetry_timeout"), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${trimTrailingSlash(this.config.baseUrl)}/collect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Telemetry upload failed (${response.status}).`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private restoreQueue(): void {
    try {
      const raw = readFileSync(this.config.queueFilePath, "utf8");
      const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as AnalyticsEventEnvelope;
          if (parsed?.event?.eventId) {
            this.queue.push({
              event: parsed.event,
              attempts: Math.max(0, Number(parsed.attempts) || 0),
            });
          }
        } catch {
          // Ignore malformed lines.
        }
      }
      this.syncQueueDepth();
      // Keep the queue file on disk; it will be overwritten on clean shutdown.
    } catch {
      // noop: file might not exist or malformed lines were ignored.
    }
  }

  private persistQueue(): void {
    try {
      mkdirSync(dirname(this.config.queueFilePath), { recursive: true });
      const lines = this.queue.map((item) => JSON.stringify(item));
      writeFileSync(
        this.config.queueFilePath,
        lines.length > 0 ? `${lines.join("\n")}\n` : "",
        "utf8",
      );
    } catch {
      // noop
    }
  }

  private syncQueueDepth(): void {
    this.metrics.queueDepth = this.queue.length;
  }
}

function trimTrailingSlash(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}
