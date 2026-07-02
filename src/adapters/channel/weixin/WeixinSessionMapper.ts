import { randomUUID } from "node:crypto";

export type WeixinSessionMapperState = {
  activeByChatId: Record<string, string>;
  projectByChatId?: Record<string, string>;
};

export type WeixinResolveResult = {
  sessionKey: string;
  projectKey?: string;
  command?: "new";
  message: string;
};

export class WeixinSessionMapper {
  constructor(
    private readonly state: WeixinSessionMapperState = { activeByChatId: {}, projectByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {
    this.state.projectByChatId ??= {};
  }

  resolve(input: { chatId: string; text: string }): WeixinResolveResult {
    const trimmed = input.text.trim();
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `weixin:chat=${input.chatId}:s_${this.uuid()}`;
      this.state.activeByChatId[input.chatId] = sessionKey;
      return {
        sessionKey,
        projectKey: this.state.projectByChatId?.[input.chatId],
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[input.chatId] ?? `weixin:chat=${input.chatId}:general`,
      projectKey: this.state.projectByChatId?.[input.chatId],
      message: trimmed,
    };
  }

  bindProject(chatId: string, projectKey: string): void {
    this.state.projectByChatId ??= {};
    this.state.projectByChatId[chatId] = projectKey;
  }

  getProject(chatId: string): string | undefined {
    return this.state.projectByChatId?.[chatId];
  }

  getSession(chatId: string): string {
    return this.state.activeByChatId[chatId] ?? `weixin:chat=${chatId}:general`;
  }

  snapshot(): WeixinSessionMapperState {
    return {
      activeByChatId: { ...this.state.activeByChatId },
      projectByChatId: { ...this.state.projectByChatId },
    };
  }
}
