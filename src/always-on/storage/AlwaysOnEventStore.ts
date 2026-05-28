import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AlwaysOnPhaseEvent } from "../protocol/types.js";
import type { AlwaysOnPaths } from "./AlwaysOnPaths.js";

export class AlwaysOnEventStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async appendEvent(event: AlwaysOnPhaseEvent): Promise<void> {
    await mkdir(dirname(this.paths.eventsFile), { recursive: true });
    await appendFile(this.paths.eventsFile, JSON.stringify(event) + "\n", "utf-8");
  }

  async readEvents(opts?: { since?: string; limit?: number }): Promise<AlwaysOnPhaseEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.eventsFile, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    let events: AlwaysOnPhaseEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AlwaysOnPhaseEvent);
      } catch {
        // skip malformed lines
      }
    }

    if (opts?.since) {
      const sinceMs = Date.parse(opts.since);
      if (Number.isFinite(sinceMs)) {
        events = events.filter((e) => Date.parse(e.timestamp) >= sinceMs);
      }
    }

    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit && opts.limit > 0) {
      events = events.slice(0, opts.limit);
    }

    return events;
  }
}
