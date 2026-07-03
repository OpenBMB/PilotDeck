import { randomUUID } from "node:crypto";

export type WeComSessionMapperState = {
  activeByChatId: Record<string, string>;
  projectByScopeKey?: Record<string, string>;
};

export type WeComSessionMapperScopeInput = {
  chatId: string;
  userId?: string;
  chatType?: "dm" | "group";
  groupSessionsPerUser?: boolean;
};

export type WeComSessionMapperInput = WeComSessionMapperScopeInput & {
  text: string;
};

export type WeComResolveResult = {
  sessionKey: string;
  projectKey?: string;
  command?: "new";
  message: string;
};

export class WeComSessionMapper {
  constructor(
    private readonly state: WeComSessionMapperState = { activeByChatId: {} },
    private readonly uuid: () => string = randomUUID,
  ) {
    this.state.projectByScopeKey ??= {};
  }

  resolve(input: WeComSessionMapperInput): WeComResolveResult {
    const trimmed = input.text.trim();
    const scopeKey = this.scopeKey(input);
    const projectKey = this.state.projectByScopeKey?.[scopeKey];
    if (trimmed === "/new" || trimmed.startsWith("/new ")) {
      const sessionKey = `${scopeKey}:s_${this.uuid()}`;
      this.state.activeByChatId[scopeKey] = sessionKey;
      return {
        sessionKey,
        projectKey,
        command: "new",
        message: trimmed.slice("/new".length).trim(),
      };
    }

    return {
      sessionKey: this.state.activeByChatId[scopeKey] ?? `${scopeKey}:general`,
      projectKey,
      message: trimmed,
    };
  }

  bindProject(input: WeComSessionMapperScopeInput, projectKey: string): void {
    this.state.projectByScopeKey ??= {};
    this.state.projectByScopeKey[this.scopeKey(input)] = projectKey;
  }

  getProject(input: WeComSessionMapperScopeInput): string | undefined {
    return this.state.projectByScopeKey?.[this.scopeKey(input)];
  }

  snapshot(): WeComSessionMapperState {
    return {
      activeByChatId: { ...this.state.activeByChatId },
      projectByScopeKey: { ...this.state.projectByScopeKey },
    };
  }

  private scopeKey(input: WeComSessionMapperScopeInput): string {
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
