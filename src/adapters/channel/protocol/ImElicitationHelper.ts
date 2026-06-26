import type { Gateway, GatewayEvent } from "../../../gateway/index.js";

/**
 * Lightweight helper that manages pending elicitation state for IM channels.
 *
 * IM channels process one turn at a time per chat (`activeChats` guard), so
 * user replies arrive through the normal inbound handler. When the agent emits
 * an `elicitation_request` the event stream blocks until `respondElicitation`
 * is called. This helper:
 *
 *   1. Captures the pending request when the channel sees an elicitation event.
 *   2. Formats the question(s) as a numbered-option text message.
 *   3. When the user's next message arrives, resolves the pending elicitation
 *      by mapping the reply (a number or label) back to the original option.
 */

type PendingElicitation = {
  sessionKey: string;
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
  fields?: Array<{
    id: string;
    label: string;
    description?: string;
    kind: "text" | "secret" | "multiline";
    required?: boolean;
  }>;
};

export class ImElicitationHelper {
  private readonly pending = new Map<string, PendingElicitation>();

  /**
   * Call when the event stream yields an `elicitation_request`.
   * Returns the formatted question text to send to the user.
   */
  capture(chatId: string, sessionKey: string, event: GatewayEvent & { type: "elicitation_request" }): string {
    this.pending.set(chatId, {
      sessionKey,
      requestId: event.requestId,
      questions: event.questions,
      fields: event.fields,
    });

    const lines: string[] = [];
    if (event.fields && event.fields.length > 0) {
      lines.push("需要你输入信息后才能继续。");
      for (const field of event.fields) {
        lines.push(`**${field.label}**`);
        if (field.description) lines.push(field.description);
        if (field.kind === "secret") {
          lines.push("该内容只会发送给正在运行的命令，不会回显到工具结果。");
        }
      }
      lines.push("", "直接回复内容继续，回复 0 取消。");
      return lines.join("\n");
    }

    for (const q of event.questions) {
      if (q.header) lines.push(`**${q.header}**`);
      if (q.question) lines.push(q.question);
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        lines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
      }
    }
    lines.push("", "回复数字选择（多选用逗号分隔），回复 0 取消。");
    return lines.join("\n");
  }

  hasPending(chatId: string): boolean {
    return this.pending.has(chatId);
  }

  /**
   * Call when the user sends a message while an elicitation is pending.
   * Parses the reply, calls `gateway.respondElicitation`, and clears state.
   * Returns a confirmation string to send back, or undefined if nothing to say.
   */
  async answer(chatId: string, text: string, gateway: Gateway): Promise<string | undefined> {
    const entry = this.pending.get(chatId);
    if (!entry) return undefined;
    this.pending.delete(chatId);

    const trimmed = text.trim();

    if (trimmed === "0") {
      await gateway.respondElicitation({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        answer: { type: "cancelled", reason: "user cancelled" },
      });
      return "已取消。";
    }

    const answers: Record<string, string | string[]> = {};
    const inputs: Record<string, string> = {};

    if (entry.fields && entry.fields.length > 0) {
      for (const field of entry.fields) {
        inputs[field.id] = trimmed;
      }
      await gateway.respondElicitation({
        sessionKey: entry.sessionKey,
        requestId: entry.requestId,
        answer: { type: "answered", answers, inputs },
      });
      return undefined;
    }

    for (const q of entry.questions) {
      const indices = trimmed.split(/[,，\s]+/).map((s) => Number.parseInt(s, 10)).filter((n) => !Number.isNaN(n));

      const selected: string[] = [];
      for (const idx of indices) {
        if (idx >= 1 && idx <= q.options.length) {
          selected.push(q.options[idx - 1].label);
        }
      }

      if (selected.length === 0) {
        selected.push(trimmed);
      }

      answers[q.question] = q.multiSelect ? selected : (selected[0] ?? trimmed);
    }

    await gateway.respondElicitation({
      sessionKey: entry.sessionKey,
      requestId: entry.requestId,
      answer: { type: "answered", answers },
    });
    return undefined;
  }

  clear(chatId: string): void {
    this.pending.delete(chatId);
  }
}
