import { randomUUID } from "node:crypto";

export type QQSessionMapperState = {
  activeByChatKey: Record<string, string>;
};

export class QQSessionMapper {
  constructor(
    private readonly state: QQSessionMapperState = { activeByChatKey: {} },
    private readonly uuid: () => string = randomUUID,
  ) {}

  resolve(input: { groupId: string; userId: string; text: string }): {
    sessionKey: string;
    command?: "new";
    message: string;
  } {
    const chatKey = `${input.groupId}:${input.userId}`;
    const trimmed = input.text.trim();

    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `qq:group=${input.groupId}:user=${input.userId}:s_${this.uuid()}`;
      this.state.activeByChatKey[chatKey] = sessionKey;
      return {
        sessionKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey:
        this.state.activeByChatKey[chatKey] ??
        `qq:group=${input.groupId}:user=${input.userId}:general`,
      message: trimmed,
    };
  }

  snapshot(): QQSessionMapperState {
    return { activeByChatKey: { ...this.state.activeByChatKey } };
  }
}
