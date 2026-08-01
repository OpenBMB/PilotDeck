import { networkFetchJson, networkPostJson } from "../../network/fetch.js";
import type {
  GroupChatInvocation,
  StaffDeckEmployeeSummary,
} from "../protocol/types.js";

type StaffDeckAgentProfile = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
};

type StaffDeckTurnResponse = {
  reply?: unknown;
  session_id?: unknown;
};

export type StaffDeckConnection = {
  baseUrl: string;
  tenantId: string;
  token?: string;
};

export type StaffDeckClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const MOCK_STAFFDECK_EMPLOYEES: StaffDeckEmployeeSummary[] = [
  {
    id: "mock-researcher",
    name: "Mock Research Analyst",
    description: "Collects evidence, clarifies assumptions, and compares options.",
    source: "mock",
  },
  {
    id: "mock-engineer",
    name: "Mock Solution Engineer",
    description: "Turns goals into an implementation design and highlights integration constraints.",
    source: "mock",
  },
  {
    id: "mock-reviewer",
    name: "Mock Risk Reviewer",
    description: "Challenges proposals, identifies failure modes, and recommends verification.",
    source: "mock",
  },
];

export class StaffDeckClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sessions = new Map<string, string>();

  constructor(options: StaffDeckClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  resolveConnection(env: NodeJS.ProcessEnv): StaffDeckConnection | undefined {
    const baseUrl = env.STAFFDECK_BASE_URL?.trim().replace(/\/$/u, "");
    const tenantId = env.STAFFDECK_TENANT_ID?.trim();
    if (!baseUrl || !tenantId) return undefined;
    return {
      baseUrl,
      tenantId,
      token: env.STAFFDECK_API_TOKEN?.trim() || undefined,
    };
  }

  async listEmployees(
    connection: StaffDeckConnection,
    signal?: AbortSignal,
  ): Promise<StaffDeckEmployeeSummary[]> {
    const url = new URL("/api/chat/agents", `${connection.baseUrl}/`);
    url.searchParams.set("tenant_id", connection.tenantId);
    const { json } = await networkFetchJson<StaffDeckAgentProfile[]>(
      url,
      { headers: authHeaders(connection.token) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.timeoutMs,
        retry: { maxRetries: 1 },
      },
    );
    if (!Array.isArray(json)) throw new Error("StaffDeck employee list response is not an array.");
    return json.flatMap((value): StaffDeckEmployeeSummary[] => {
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!id || !name) return [];
      return [{
        id,
        name,
        description: typeof value.description === "string" && value.description.trim()
          ? value.description.trim()
          : undefined,
        source: "staffdeck",
      }];
    });
  }

  async invoke(
    invocation: GroupChatInvocation,
    prompt: string,
    connection: StaffDeckConnection,
    signal?: AbortSignal,
  ): Promise<string> {
    const agentId = invocation.participant.employeeId;
    if (!agentId) throw new Error("StaffDeck participant is missing employeeId.");
    const sessionKey = `${invocation.room.id}:${invocation.participant.id}`;
    const existingSessionId = this.sessions.get(sessionKey);
    const { json } = await networkPostJson<StaffDeckTurnResponse>(
      new URL("/api/chat/turn", `${connection.baseUrl}/`),
      {
        tenant_id: connection.tenantId,
        agent_id: agentId,
        ...(existingSessionId ? { session_id: existingSessionId } : {}),
        channel: "pilotdeck_group_chat",
        message: prompt,
      },
      { headers: authHeaders(connection.token) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.timeoutMs,
        retry: { maxRetries: 0 },
      },
    );
    if (typeof json.session_id === "string" && json.session_id.trim()) {
      this.sessions.set(sessionKey, json.session_id.trim());
    }
    const reply = typeof json.reply === "string" ? json.reply.trim() : "";
    if (!reply) throw new Error("StaffDeck employee returned an empty response.");
    return reply;
  }
}

export function getMockStaffDeckEmployee(employeeId: string): StaffDeckEmployeeSummary | undefined {
  return MOCK_STAFFDECK_EMPLOYEES.find((employee) => employee.id === employeeId);
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
