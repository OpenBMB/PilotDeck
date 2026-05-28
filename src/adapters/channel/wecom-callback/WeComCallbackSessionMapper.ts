import { randomUUID } from "node:crypto";

export type WeComCallbackSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class WeComCallbackSessionMapper {
  constructor(
    private readonly state: WeComCallbackSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `wecom_callback:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `wecom_callback:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): WeComCallbackSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
