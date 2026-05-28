import { randomUUID } from "node:crypto";

export type FeishuSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export class FeishuSessionMapper {
  constructor(
    private readonly state: FeishuSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { chatId: string; text: string }): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `feishu:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `feishu:chat=${input.chatId}:general`,
      message: trimmed,
    };
  }

  snapshot(): FeishuSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }
}
