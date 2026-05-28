import { randomUUID } from "node:crypto";

export type EmailSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class EmailSessionMapper {
  constructor(
    private readonly state: EmailSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `email:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `email:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): EmailSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
