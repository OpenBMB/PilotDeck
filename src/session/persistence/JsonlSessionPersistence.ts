import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { readTranscript } from "../transcript/TranscriptReader.js";
import type { AgentTranscriptEntry } from "../transcript/TranscriptEntry.js";
import type {
  SessionPersistence,
  SessionPersistenceReadResult,
} from "./SessionPersistence.js";

export type JsonlSessionPersistenceOptions = {
  path: string;
};

export class JsonlSessionPersistence implements SessionPersistence {
  private writeTail: Promise<void> = Promise.resolve();
  private tailPrepared = false;

  constructor(private readonly options: JsonlSessionPersistenceOptions) {}

  append(entry: AgentTranscriptEntry): Promise<void> {
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await this.prepareTail();
      const flush = entry.type === "control_boundary" &&
        entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary";
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flush,
      });
    });
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async load(): Promise<SessionPersistenceReadResult> {
    await this.flush();
    return readTranscript(this.options.path);
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  private async prepareTail(): Promise<void> {
    if (this.tailPrepared) return;
    const file = await open(this.options.path, "a+", 0o600);
    try {
      const { size } = await file.stat();
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        await file.read(lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) {
          // Preserve crash debris but prevent the next record joining it.
          await file.appendFile("\n");
        }
      }
      this.tailPrepared = true;
    } finally {
      await file.close();
    }
  }
}
