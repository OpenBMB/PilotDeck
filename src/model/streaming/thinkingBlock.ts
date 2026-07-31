export type ThinkingBlockIdentity = {
  thinkingBlockId: string;
  thinkingBlockSeq: number;
};

type ThinkingBlockEntry = ThinkingBlockIdentity & {
  reasoningSnapshot: string;
};

export type ThinkingBlockTracker = {
  nextThinkingBlockSeq: number;
  blocksByKey: Map<string, ThinkingBlockEntry>;
};

export function createThinkingBlockTracker(): ThinkingBlockTracker {
  return {
    nextThinkingBlockSeq: 0,
    blocksByKey: new Map(),
  };
}

export function getThinkingBlockIdentity(
  tracker: ThinkingBlockTracker,
  key: string,
  options: {
    blockId?: string;
    blockSeq?: number;
    idPrefix?: string;
  } = {},
): ThinkingBlockIdentity {
  const existing = tracker.blocksByKey.get(key);
  if (existing) {
    return existing;
  }

  const seq = options.blockSeq ?? tracker.nextThinkingBlockSeq + 1;
  tracker.nextThinkingBlockSeq = Math.max(tracker.nextThinkingBlockSeq + 1, seq);
  const id = normalizeThinkingBlockId(options.blockId, options.idPrefix, seq);
  const entry: ThinkingBlockEntry = {
    thinkingBlockId: id,
    thinkingBlockSeq: seq,
    reasoningSnapshot: "",
  };
  tracker.blocksByKey.set(key, entry);
  return entry;
}

export function appendThinkingBlockText(
  tracker: ThinkingBlockTracker,
  key: string,
  text: string,
  options: {
    blockId?: string;
    blockSeq?: number;
    idPrefix?: string;
  } = {},
): { identity: ThinkingBlockIdentity; delta: string } {
  const identity = getThinkingBlockIdentity(tracker, key, options);
  const entry = tracker.blocksByKey.get(key)!;
  if (text.length === 0) {
    return { identity, delta: "" };
  }

  const previous = entry.reasoningSnapshot;
  let delta: string;
  if (previous.length > 0 && text.startsWith(previous)) {
    delta = text.slice(previous.length);
    entry.reasoningSnapshot = text;
  } else {
    delta = text;
    entry.reasoningSnapshot = `${previous}${text}`;
  }
  tracker.blocksByKey.set(key, entry);
  return { identity, delta };
}

export function clearThinkingBlock(tracker: ThinkingBlockTracker, key: string): void {
  tracker.blocksByKey.delete(key);
}

export function clearThinkingBlocks(tracker: ThinkingBlockTracker): void {
  tracker.blocksByKey.clear();
}

function normalizeThinkingBlockId(
  blockId: string | undefined,
  idPrefix: string | undefined,
  seq: number,
): string {
  const nativeId = typeof blockId === "string" ? blockId.trim() : "";
  if (nativeId.length > 0) {
    return nativeId;
  }
  const prefix = safeIdPart(idPrefix ?? "thinking");
  return `${prefix}_${seq}`;
}

function safeIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "thinking";
}
