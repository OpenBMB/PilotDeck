import type { Gateway, GatewayEvent } from "../protocol/types.js";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TextWebSocketConnection } from "./websocket.js";
import { SkillManagerError, SkillValidationError } from "../../extension/skills/index.js";

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
};

export class GatewayWsConnection {
  private authed = false;
  private readonly inFlightSessions = new Set<string>();

  constructor(
    private readonly ws: TextWebSocketConnection,
    private readonly options: GatewayWsConnectionOptions,
  ) {
    ws.onMessage((message) => void this.handleMessage(message));
    ws.onClose(() => this.abortInFlightTurns());
  }

  private abortInFlightTurns(): void {
    for (const sessionKey of this.inFlightSessions) {
      this.options.gateway
        .abortTurn({ sessionKey })
        .catch(() => undefined);
    }
    this.inFlightSessions.clear();
  }

  sendNotification(name: string, payload?: unknown): void {
    if (!this.authed) return;
    this.ws.sendText(JSON.stringify({ type: "notification", name, payload }));
  }

  onClose(callback: () => void): void {
    this.ws.onClose(callback);
  }

  private async handleMessage(message: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.ws.close(4002, "invalid_json");
      return;
    }

    if (!this.authed) {
      await this.handleHello(frame);
      return;
    }

    if (!isRequestFrame(frame)) {
      this.ws.close(4002, "invalid_frame");
      return;
    }
    await this.handleRequest(frame);
  }

  private async handleHello(frame: unknown): Promise<void> {
    if (!isHelloFrame(frame)) {
      this.ws.close(4001, "hello_required");
      return;
    }
    if (frame.protocolVersion !== PILOTDECK_GATEWAY_PROTOCOL_VERSION) {
      this.ws.close(4001, "protocol_mismatch");
      return;
    }
    if (frame.token !== this.options.token) {
      this.ws.close(4003, "auth_failed");
      return;
    }
    this.authed = true;
    this.ws.sendText(
      JSON.stringify({
        type: "hello_ok",
        protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
        serverVersion: this.options.serverVersion,
        serverInfo: await this.options.gateway.describeServer(),
      }),
    );
  }

  private async handleRequest(frame: WsRequestFrame): Promise<void> {
    try {
      if (frame.method === "submit_turn") {
        const sessionKey = (frame.params as { sessionKey?: string } | undefined)?.sessionKey;
        if (sessionKey) this.inFlightSessions.add(sessionKey);
        let seq = 0;
        let lastCompleted: GatewayEvent | undefined;
        try {
          for await (const event of this.options.gateway.submitTurn(frame.params as never)) {
            if (event.type === "turn_completed") {
              lastCompleted = event;
            }
            this.ws.sendText(JSON.stringify({ type: "event", id: frame.id, seq: seq++, final: false, event }));
          }
        } finally {
          if (sessionKey) this.inFlightSessions.delete(sessionKey);
        }
        const usage = lastCompleted?.type === "turn_completed" ? lastCompleted.usage : {};
        const finishReason = lastCompleted?.type === "turn_completed" ? lastCompleted.finishReason : "completed";
        this.ws.sendText(
          JSON.stringify({
            type: "event",
            id: frame.id,
            seq,
            final: true,
            event: { type: "turn_completed", usage, finishReason },
          }),
        );
        return;
      }

      const result = await this.dispatchRequest(frame);
      this.ws.sendText(JSON.stringify({ type: "response", id: frame.id, ok: true, result }));
    } catch (error) {
      // SkillManagerError carries a structured `code` we want to round-
      // trip to the client (so the UI can surface "conflict", "not_found",
      // "invalid_slug", etc. as actionable messages instead of a generic
      // 500). SkillValidationError additionally carries the structured
      // validation payload that powers the compliance panel.
      if (error instanceof SkillValidationError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              validation: error.validation,
            },
          }),
        );
        return;
      }
      if (error instanceof SkillManagerError) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
        return;
      }
      this.ws.sendText(
        JSON.stringify({
          type: "response",
          id: frame.id,
          ok: false,
          error: {
            code: "gateway_request_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private dispatchRequest(frame: WsRequestFrame): Promise<unknown> {
    switch (frame.method) {
      case "abort_turn":
        return this.options.gateway.abortTurn(frame.params as never).then(() => ({ ok: true }));
      case "list_sessions":
        return this.options.gateway.listSessions(frame.params as never);
      case "resume_session":
        return this.options.gateway.resumeSession(frame.params as never);
      case "new_session":
        return this.options.gateway.newSession(frame.params as never);
      case "close_session":
        return this.options.gateway.closeSession(frame.params as never).then(() => ({ ok: true }));
      case "describe_server":
        return this.options.gateway.describeServer();
      case "active_turn_snapshot":
        if (this.options.gateway.getActiveTurnSnapshot) {
          return this.options.gateway.getActiveTurnSnapshot(frame.params as never);
        }
        return Promise.resolve({
          active: false,
          sessionKey: (frame.params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
          events: [],
        });
      case "cron_create":
        return this.options.gateway.cronCreate(frame.params as never);
      case "cron_list":
        return this.options.gateway.cronList(frame.params as never);
      case "cron_delete":
        return this.options.gateway.cronDelete(frame.params as never);
      case "cron_stop":
        return this.options.gateway.cronStop(frame.params as never);
      case "cron_run_now":
        return this.options.gateway.cronRunNow(frame.params as never);
      case "elicitation_respond":
        return this.options.gateway.respondElicitation(frame.params as never);
      case "permission_decide":
        return this.options.gateway.permissionDecide(frame.params as never);
      case "grant_session_permission":
        return this.options.gateway.grantSessionPermission(frame.params as never);
      case "read_session_messages":
        return this.options.gateway.readSessionMessages(frame.params as never);
      case "read_subagent_messages":
        return this.options.gateway.readSubagentMessages(frame.params as never);
      case "fork_session":
        return this.options.gateway.forkSession(frame.params as never);
      case "list_projects":
        return this.options.gateway.listProjects();
      case "describe_project":
        return this.options.gateway.describeProject(frame.params as never);
      case "read_project_model_settings":
        return this.options.gateway.readProjectModelSettings(frame.params as never);
      case "save_project_model_settings":
        return this.options.gateway.saveProjectModelSettings(frame.params as never);
      case "reload_config":
        if (this.options.gateway.reloadConfig) {
          return this.options.gateway.reloadConfig();
        }
        return Promise.resolve({ reloaded: false });
      case "reload_extensions":
        if (this.options.gateway.reloadExtensions) {
          return this.options.gateway.reloadExtensions(frame.params as never);
        }
        return Promise.resolve({ reloaded: false });
      case "skill_list":
        return requireSkillMethod(this.options.gateway.skillsList, this.options.gateway)(frame.params as never);
      case "skill_read":
        return requireSkillMethod(this.options.gateway.skillRead, this.options.gateway)(frame.params as never);
      case "skill_write":
        return requireSkillMethod(this.options.gateway.skillWrite, this.options.gateway)(frame.params as never);
      case "skill_create":
        return requireSkillMethod(this.options.gateway.skillCreate, this.options.gateway)(frame.params as never);
      case "skill_delete":
        return requireSkillMethod(this.options.gateway.skillDelete, this.options.gateway)(frame.params as never);
      case "skill_import":
        return requireSkillMethod(this.options.gateway.skillImport, this.options.gateway)(frame.params as never);
      case "skill_validate":
        return requireSkillMethod(this.options.gateway.skillValidate, this.options.gateway)(frame.params as never);
      case "skill_scan":
        return requireSkillMethod(this.options.gateway.skillScan, this.options.gateway)(frame.params as never);
      case "always_on_apply":
        if (this.options.gateway.alwaysOnApply) {
          return this.options.gateway.alwaysOnApply(frame.params as never);
        }
        return Promise.resolve({ sessionKey: "", error: { code: "not_configured", message: "Always-On apply not available" } });
      case "always_on_rerun_plan":
        if (this.options.gateway.alwaysOnRerunPlan) {
          return this.options.gateway.alwaysOnRerunPlan(frame.params as never);
        }
        return Promise.resolve({ runId: "", error: { code: "not_configured", message: "Always-On rerun not available" } });
      default:
        throw new Error(`Unknown gateway method ${(frame as { method?: string }).method}.`);
    }
  }
}

/**
 * Guard for optional Skill RPC methods on the Gateway. The Gateway
 * interface marks every `skill*` method as optional so older
 * RemoteGateway-backed servers don't break the type contract. When a
 * client invokes a method this server's gateway doesn't implement, we
 * fail with a structured `not_configured` error instead of crashing
 * the dispatcher.
 */
function requireSkillMethod<TArg, TRet>(
  method: ((arg: TArg) => Promise<TRet>) | undefined,
  gateway: Gateway,
): (arg: TArg) => Promise<TRet> {
  if (!method) {
    throw new SkillManagerError(
      "not_configured",
      "Skill management is not enabled on this gateway.",
    );
  }
  return method.bind(gateway);
}

function isHelloFrame(value: unknown): value is WsHelloFrame {
  return (
    isRecord(value) &&
    value.type === "hello" &&
    typeof value.protocolVersion === "string" &&
    typeof value.clientName === "string" &&
    typeof value.clientVersion === "string" &&
    typeof value.token === "string"
  );
}

function isRequestFrame(value: unknown): value is WsRequestFrame {
  return (
    isRecord(value) &&
    value.type === "request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
