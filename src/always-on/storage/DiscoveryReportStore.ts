import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiscoveryRunHistoryEvent } from "../protocol/types.js";
import { reportMarkdownPath, runEventsPath, type AlwaysOnPaths } from "./AlwaysOnPaths.js";

export class DiscoveryReportStore {
  constructor(private readonly paths: AlwaysOnPaths) {}

  async writeReport(runId: string, markdown: string): Promise<string> {
    const filePath = reportMarkdownPath(this.paths, runId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  async appendRunEvent(runId: string, payload: Record<string, unknown>): Promise<void> {
    const filePath = runEventsPath(this.paths, runId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(payload) + "\n", "utf-8");
  }

  async appendHistory(event: DiscoveryRunHistoryEvent): Promise<void> {
    await mkdir(dirname(this.paths.runHistoryFile), { recursive: true });
    await appendFile(this.paths.runHistoryFile, JSON.stringify(event) + "\n", "utf-8");
  }
}
