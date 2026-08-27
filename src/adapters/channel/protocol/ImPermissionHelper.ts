import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

type PendingPermission = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload: unknown;
};

export class ImPermissionHelper {
  private readonly pending = new Map<string, PendingPermission[]>();
  private readonly nextPrompts = new Map<string, string>();
  private readonly answering = new Set<string>();

  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "permission_request" }): string | undefined {
    const entries = this.pending.get(chatId) ?? [];
    entries.push({
      sessionKey,
      requestId: event.requestId,
      toolName: event.toolName,
      payload: event.payload,
    });
    this.pending.set(chatId, entries);

    return entries.length === 1 ? formatPermissionPrompt(entries[0]!) : undefined;
  }

  formatPending(chatId: string): string | undefined {
    const entries = this.pending.get(chatId);
    return entries && entries.length > 0 ? formatPermissionPrompt(entries[0]!) : undefined;
  }

  hasPending(chatId: string): boolean {
    return (this.pending.get(chatId)?.length ?? 0) > 0;
  }

  takeNextPrompt(chatId: string): string | undefined {
    const prompt = this.nextPrompts.get(chatId);
    this.nextPrompts.delete(chatId);
    return prompt;
  }

  async answer(chatId: string, text: string, gateway: Gateway): Promise<string | undefined> {
    if (this.answering.has(chatId)) return undefined;
    const entries = this.pending.get(chatId);
    if (!entries || entries.length === 0) return undefined;

    const trimmed = text.trim();
    if (trimmed !== "0" && trimmed !== "1" && trimmed !== "2") {
      return "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。";
    }

    this.answering.add(chatId);
    const entry = entries.shift();
    if (!entry) {
      this.answering.delete(chatId);
      return undefined;
    }
    if (entries.length === 0) this.pending.delete(chatId);
    else this.pending.set(chatId, entries);
    const deny = trimmed === "0";
    try {
      await gateway.permissionDecide({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        decision: deny ? "deny" : "allow",
        ...(deny ? { reason: "User denied permission from IM channel." } : {}),
        ...(!deny ? { remember: trimmed === "2" } : {}),
      });
      if (entries.length > 0) this.nextPrompts.set(chatId, formatPermissionPrompt(entries[0]!));
      if (trimmed === "0") return "已拒绝，继续处理。";
      if (trimmed === "2") return "已允许本会话，继续执行。";
      return "已允许一次，继续执行。";
    } finally {
      this.answering.delete(chatId);
    }
  }

  clear(chatId: string): void {
    this.pending.delete(chatId);
    this.nextPrompts.delete(chatId);
    this.answering.delete(chatId);
  }
}

function formatPayload(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    text = String(payload);
  }

  const trimmed = text.trim();
  if (trimmed.length <= 800) return trimmed || "(空)";
  return `${trimmed.slice(0, 800)}...`;
}

function formatPermissionPrompt(entry: PendingPermission): string {
  return [
    `工具 ${entry.toolName} 需要权限才能继续执行。`,
    "",
    "请求内容：",
    formatPayload(entry.payload),
    "",
    "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
  ].join("\n");
}
