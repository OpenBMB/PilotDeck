import { randomUUID } from "node:crypto";

export type BlueBubblesSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class BlueBubblesSessionMapper {
  constructor(
    private readonly state: BlueBubblesSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `bluebubbles:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `bluebubbles:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): BlueBubblesSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
