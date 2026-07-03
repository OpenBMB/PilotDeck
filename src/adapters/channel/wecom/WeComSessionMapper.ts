import { randomUUID } from "node:crypto";

export type WeComSessionMapperState = {
  activeByChatId: Record<string, string>;
};

export type WeComSessionMapperInput = {
  chatId: string;
  text: string;
  userId?: string;
  chatType?: "dm" | "group";
  groupSessionsPerUser?: boolean;
};

export class WeComSessionMapper {
  constructor(
    private readonly state: WeComSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: WeComSessionMapperInput): { sessionKey: string; command?: "new"; message: string } {
    const trimmed = input.text.trim();
    const scopeKey = this.scopeKey(input);
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `${scopeKey}:s_${this.uuid()}`;
      this.state.activeByChatId[scopeKey] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[scopeKey] ?? `${scopeKey}:general`,
      message: trimmed,
    };
  }

  snapshot(): WeComSessionMapperState {
    return { activeByChatId: { ...this.state.activeByChatId } };
  }

  private scopeKey(input: WeComSessionMapperInput): string {
    const chatType = input.chatType ?? "dm";
    const chatId = input.chatId.trim();
    const userId = input.userId?.trim();

    if (chatType === "group") {
      const perUser = input.groupSessionsPerUser !== false;
      return perUser && userId
        ? `wecom:group=${chatId}:user=${userId}`
        : `wecom:group=${chatId}`;
    }

    return `wecom:dm=${userId || chatId}`;
  }
}
