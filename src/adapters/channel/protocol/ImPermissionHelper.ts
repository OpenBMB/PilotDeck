import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

type PendingPermission = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload: unknown;
};

export class ImPermissionHelper {
  private readonly pending = new Map<string, PendingPermission>();

  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "permission_request" }): string | undefined {
    if (this.pending.has(chatId)) {
      return undefined;
    }
    this.pending.set(chatId, {
      sessionKey,
      requestId: event.requestId,
      toolName: event.toolName,
      payload: event.payload,
    });

    const lines = [
      `工具 ${event.toolName} 需要权限才能继续执行。`,
      "",
      "请求内容：",
      formatPayload(event.payload),
      "",
      "回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。",
    ];
    return lines.join("\n");
  }

  hasPending(chatId: string): boolean {
    return this.pending.has(chatId);
  }

  async answer(chatId: string, text: string, gateway: Gateway): Promise<string | undefined> {
    const entry = this.pending.get(chatId);
    if (!entry) return undefined;

    const trimmed = text.trim();
    if (trimmed !== "0" && trimmed !== "1" && trimmed !== "2") {
      return "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。";
    }

    this.pending.delete(chatId);
    if (trimmed === "0") {
      await gateway.permissionDecide({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        decision: "deny",
        reason: "User denied permission from IM channel.",
      });
      return "已拒绝，继续处理。";
    }

    await gateway.permissionDecide({
      sessionKey: entry.sessionKey,
      requestId: entry.requestId,
      decision: "allow",
      remember: trimmed === "2",
    });
    return trimmed === "2" ? "已允许本会话，继续执行。" : "已允许一次，继续执行。";
  }

  clear(chatId: string): void {
    this.pending.delete(chatId);
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
