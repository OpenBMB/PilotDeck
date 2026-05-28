import { randomUUID } from "node:crypto";

export type SignalSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class SignalSessionMapper {
  constructor(
    private readonly state: SignalSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `signal:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `signal:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): SignalSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
