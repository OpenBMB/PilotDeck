import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GatewayAttachmentTurnComposerInput, GatewayAttachmentTurnComposition } from "../../gateway/dialog/GatewayAttachmentTurnComposerPort.js";
import type { SopJson } from "./SopExecutionClient.js";

/** Captures query before inline attachment conversion and retains files beyond a turn lease. */
export class SopInputCapture {
  private readonly cache = new Map<string, SopJson>();
  constructor(private readonly stateRoot: string) {}
  private location(sessionKey: string): string {
    return join(this.stateRoot, "sop-v4-input", Buffer.from(sessionKey).toString("base64url"));
  }

  async get(sessionKey: string): Promise<SopJson | undefined> {
    if (this.cache.has(sessionKey)) return this.cache.get(sessionKey);
    try {
      const value = JSON.parse(await readFile(join(this.location(sessionKey), "input.json"), "utf8")) as SopJson;
      this.cache.set(sessionKey, value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async prepare(input: GatewayAttachmentTurnComposerInput & { sessionKey: string }): Promise<GatewayAttachmentTurnComposition> {
    const files: SopJson[] = [];
    const directory = join(input.projectRoot!, ".sop-inputs", randomUUID());
    for (const attachment of input.attachments ?? []) {
      if (!attachment.path) throw new Error("SOP v4 requires staged attachment files");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${files.length}-${(attachment.name ?? "file").replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      await copyFile(attachment.path, path);
      files.push({ path, name: attachment.name ?? "file", mimeType: attachment.mimeType, sopAttachmentRef: true });
    }
    const previous = await this.get(input.sessionKey);
    const value = { originalQuery: input.message, latestUserMessage: input.message,
      files: files.length ? files : previous?.files ?? [], attachments: files.length ? files : previous?.files ?? [] };
    const location = this.location(input.sessionKey);
    await mkdir(location, { recursive: true });
    const { writeFile, rename } = await import("node:fs/promises");
    const pending = join(location, `${randomUUID()}.tmp`);
    await writeFile(pending, JSON.stringify(value), { mode: 0o600 });
    await rename(pending, join(location, "input.json"));
    this.cache.set(input.sessionKey, value);
    return { agentInput: { type: "text", text: `${input.message}\n\nRegistered file references (contents are not inline):\n${JSON.stringify(value.files)}` },
      allowedReadFiles: (value.files as SopJson[]).map(f => String(f.path)) };
  }
}
