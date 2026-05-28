import { randomUUID } from "node:crypto";

export type WhatsAppSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class WhatsAppSessionMapper {
  constructor(
    private readonly state: WhatsAppSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `whatsapp:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `whatsapp:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): WhatsAppSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
