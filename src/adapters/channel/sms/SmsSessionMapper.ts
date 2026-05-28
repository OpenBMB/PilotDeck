import { randomUUID } from "node:crypto";

export type SmsSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class SmsSessionMapper {
  constructor(
    private readonly state: SmsSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `sms:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `sms:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): SmsSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
