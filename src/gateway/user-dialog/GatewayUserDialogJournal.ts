import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { AgentProjectSessionStorage } from "../../session/storage/ProjectSessionStorage.js";
import type {
  GatewayRecoveredUserDialog,
  GatewayUserDialogRequestEvent,
} from "../protocol/types.js";

type GatewayUserDialogJournalRecord = {
  version: 1;
  dialogs: GatewayUserDialogRequestEvent[];
};

export type GatewayUserDialogJournalOptions = {
  now?: () => Date;
};

/**
 * Returns a Gateway-local journal path next to a persistent transcript. SDK
 * ephemeral sessions intentionally have no path and therefore no restart
 * recovery state.
 */
export function createGatewayUserDialogJournal(
  storage: Pick<AgentProjectSessionStorage, "transcriptPath">,
  options: GatewayUserDialogJournalOptions = {},
): GatewayUserDialogJournal | undefined {
  if (!storage.transcriptPath || !isAbsolute(storage.transcriptPath)) return undefined;
  return new GatewayUserDialogJournal(`${storage.transcriptPath}.dialogs.json`, options);
}

/**
 * Small, Gateway-owned durable journal for a single session's live dialogs.
 * It is separate from the transcript because a dialog may be waiting while a
 * turn is active. After process loss the original AgentLoop cannot resume,
 * but the request remains available until a renderer either records a
 * recovery answer or explicitly supersedes it with a new turn.
 */
export class GatewayUserDialogJournal {
  private readonly now: () => Date;

  constructor(readonly path: string, options: GatewayUserDialogJournalOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(event: GatewayUserDialogRequestEvent): void {
    const record = this.read();
    const index = record.dialogs.findIndex((candidate) => candidate.requestId === event.requestId);
    if (index >= 0) record.dialogs[index] = structuredClone(event);
    else record.dialogs.push(structuredClone(event));
    this.write(record);
  }

  remove(requestId: string): void {
    const record = this.read();
    const dialogs = record.dialogs.filter((dialog) => dialog.requestId !== requestId);
    if (dialogs.length === record.dialogs.length) return;
    if (dialogs.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    this.write({ version: 1, dialogs });
  }

  /**
   * Projects records left by a prior process as restart-terminal state.
   * Unlike the original implementation this deliberately does not remove the
   * journal. A Gateway-owned recovery response needs the request contract to
   * validate and persist the human answer before the next turn is created.
   */
  recover(): GatewayRecoveredUserDialog[] {
    const record = this.read();
    if (record.dialogs.length === 0) return [];
    const terminatedAt = this.now().toISOString();
    return record.dialogs.map((request) => ({
      type: "user_dialog_terminated",
      request: structuredClone(request),
      reason: "gateway_restarted" as const,
      terminatedAt,
      recovery: "next_turn_context" as const,
    }));
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  private read(): GatewayUserDialogJournalRecord {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<GatewayUserDialogJournalRecord>;
      if (parsed.version !== 1 || !Array.isArray(parsed.dialogs)
        || parsed.dialogs.some((dialog) => !isDialogRequest(dialog))) {
        throw new Error("invalid dialog journal record");
      }
      return { version: 1, dialogs: parsed.dialogs.map((dialog) => structuredClone(dialog)) };
    } catch (error) {
      if (isMissing(error)) return { version: 1, dialogs: [] };
      throw new Error(`Unable to read Gateway user-dialog journal ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private write(record: GatewayUserDialogJournalRecord): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

function isDialogRequest(value: unknown): value is GatewayUserDialogRequestEvent {
  return Boolean(value && typeof value === "object"
    && (value as { type?: unknown }).type === "user_dialog_request"
    && typeof (value as { requestId?: unknown }).requestId === "string"
    && typeof (value as { dialogKind?: unknown }).dialogKind === "string");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}
