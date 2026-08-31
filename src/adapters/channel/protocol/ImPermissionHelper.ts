import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

type PendingPermission = {
  sessionKey: string;
  requestId: string;
  toolName: string;
  payload: unknown;
};

type PendingPrompt = {
  text: string;
  requestId: string;
};

export type ImPermissionAnswerResult = {
  text?: string;
  /** True only for the invocation that completed a permission decision. */
  canAdvance: boolean;
  /** True when the caller should retry delivery of an already queued prompt. */
  retryPrompt?: boolean;
  answerToken?: number;
};

export class ImPermissionHelper {
  private readonly pending = new Map<string, PendingPermission[]>();
  private readonly nextPrompts = new Map<string, PendingPrompt>();
  private readonly promptDelivering = new Set<string>();
  private readonly retryPromptPending = new Set<string>();
  private readonly initialPromptPending = new Set<string>();
  private readonly answering = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly answerTokens = new Map<string, number>();
  private nextAnswerToken = 1;

  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "permission_request" }): string | undefined {
    const entries = this.pending.get(chatId) ?? [];
    entries.push({
      sessionKey,
      requestId: event.requestId,
      toolName: event.toolName,
      payload: event.payload,
    });
    this.pending.set(chatId, entries);

    if (entries.length !== 1 || this.answering.has(chatId)) return undefined;
    const prompt = formatPermissionPrompt(entries[0]!);
    this.answering.add(chatId);
    this.nextPrompts.set(chatId, { text: prompt, requestId: entries[0]!.requestId });
    this.initialPromptPending.add(chatId);
    return prompt;
  }

  formatPending(chatId: string): string | undefined {
    const entries = this.pending.get(chatId);
    return entries && entries.length > 0 ? formatPermissionPrompt(entries[0]!) : undefined;
  }

  hasPending(chatId: string): boolean {
    return (this.pending.get(chatId)?.length ?? 0) > 0 || this.answering.has(chatId);
  }

  isAnswering(chatId: string): boolean {
    return this.answering.has(chatId);
  }

  takeNextPrompt(chatId: string): string | undefined {
    // Status replies from answer() are non-advancing. Do not let an inbound
    // reply during initial delivery or an in-flight decision consume the
    // queued prompt and clear the lock.
    if (this.promptDelivering.has(chatId) || this.initialPromptPending.has(chatId) || this.inFlight.has(chatId)) return undefined;
    const prompt = this.nextPrompts.get(chatId);
    if (!prompt) return undefined;
    this.promptDelivering.add(chatId);
    return prompt.text;
  }

  getPromptRequestId(chatId: string): string | undefined {
    return this.nextPrompts.get(chatId)?.requestId;
  }

  confirmInitialPrompt(chatId: string, delivered: boolean | void = true, expectedRequestId?: string): void {
    if (!this.answering.has(chatId) || !this.nextPrompts.has(chatId)) return;
    if (expectedRequestId !== undefined && this.nextPrompts.get(chatId)?.requestId !== expectedRequestId) return;
    if (!delivered) {
      this.initialPromptPending.delete(chatId);
      this.retryPromptPending.add(chatId);
      return;
    }
    this.nextPrompts.delete(chatId);
    this.initialPromptPending.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.answering.delete(chatId);
  }

  confirmNextPrompt(chatId: string, delivered: boolean | void = true, expectedRequestId?: string): void {
    if (!this.promptDelivering.has(chatId)) return;
    if (expectedRequestId !== undefined && this.nextPrompts.get(chatId)?.requestId !== expectedRequestId) return;
    this.promptDelivering.delete(chatId);
    if (!delivered) {
      this.retryPromptPending.add(chatId);
      return;
    }
    this.nextPrompts.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.answering.delete(chatId);
  }

  /** Release a completed answer when the adapter cannot deliver its reply. */
  releaseAnswer(chatId: string, answerToken?: number): void {
    if (answerToken !== undefined && this.answerTokens.get(chatId) !== answerToken) return;
    // Keep the queued prompt and lock intact so a failed delivery cannot let
    // the next inbound message decide the unseen request.
    this.promptDelivering.delete(chatId);
    if (this.nextPrompts.has(chatId)) this.retryPromptPending.add(chatId);
  }

  async answer(chatId: string, text: string, gateway: Gateway): Promise<string | undefined> {
    return (await this.answerWithState(chatId, text, gateway))?.text;
  }

  async answerWithState(chatId: string, text: string, gateway: Gateway): Promise<ImPermissionAnswerResult | undefined> {
    if (this.answering.has(chatId)) {
      // Keep ordinary messages inside the permission flow while the RPC or
      // prompt delivery is pending. The structured result prevents adapters
      // from treating these status messages as completed decisions.
      if (this.inFlight.has(chatId)) return { text: "权限决定处理中，请稍候。", canAdvance: false };
      if (this.initialPromptPending.has(chatId)) return { text: "权限提示发送中，请稍候。", canAdvance: false };
      return this.retryPromptPending.has(chatId)
        ? { text: "上一条权限提示发送失败，正在重试。", canAdvance: false, retryPrompt: true }
        : undefined;
    }
    const entries = this.pending.get(chatId);
    if (!entries || entries.length === 0) return undefined;

    const trimmed = text.trim();
    if (trimmed !== "0" && trimmed !== "1" && trimmed !== "2") {
      return { text: "请回复 1 允许一次，回复 2 允许本会话，回复 0 拒绝。", canAdvance: false };
    }

    this.answering.add(chatId);
    this.inFlight.add(chatId);
    const answerToken = this.nextAnswerToken++;
    this.answerTokens.set(chatId, answerToken);
    const generation = (this.generations.get(chatId) ?? 0) + 1;
    this.generations.set(chatId, generation);
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
      if ((this.generations.get(chatId) ?? 0) !== generation) return undefined;
      const remaining = this.pending.get(chatId) ?? entries;
      if (remaining.length > 0) {
        this.nextPrompts.set(chatId, {
          text: formatPermissionPrompt(remaining[0]!),
          requestId: remaining[0]!.requestId,
        });
      }
      if (trimmed === "0") return { text: "已拒绝，继续处理。", canAdvance: true, answerToken };
      if (trimmed === "2") return { text: "已允许本会话，继续执行。", canAdvance: true, answerToken };
      return { text: "已允许一次，继续执行。", canAdvance: true, answerToken };
    } catch (error) {
      if ((this.generations.get(chatId) ?? 0) === generation) {
        const currentEntries = this.pending.get(chatId) ?? entries;
        this.pending.set(chatId, [entry, ...currentEntries]);
        this.nextPrompts.delete(chatId);
        this.retryPromptPending.delete(chatId);
        this.answering.delete(chatId);
      }
      throw error;
    } finally {
      if ((this.generations.get(chatId) ?? 0) === generation) {
        this.inFlight.delete(chatId);
        if ((this.pending.get(chatId)?.length ?? 0) === 0 && !this.nextPrompts.has(chatId)) {
          this.answering.delete(chatId);
        }
        this.generations.delete(chatId);
      } else if (!this.pending.has(chatId) && !this.inFlight.has(chatId) && !this.answering.has(chatId)) {
        this.generations.delete(chatId);
      }
    }
  }

  clear(chatId: string): void {
    if (this.inFlight.has(chatId)) {
      this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
    } else {
      this.generations.delete(chatId);
    }
    this.pending.delete(chatId);
    this.nextPrompts.delete(chatId);
    this.promptDelivering.delete(chatId);
    this.retryPromptPending.delete(chatId);
    this.initialPromptPending.delete(chatId);
    this.inFlight.delete(chatId);
    this.answerTokens.delete(chatId);
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
