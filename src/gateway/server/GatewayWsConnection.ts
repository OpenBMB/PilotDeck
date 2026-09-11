import type { Gateway, GatewayEvent } from "../protocol/types.js";
import type { WsHelloFrame, WsRequestFrame } from "../protocol/frames.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../protocol/version.js";
import { SkillManagerError, SkillValidationError } from "../../extension/skills/index.js";
import { DialogGatewayError } from "../dialog/errors.js";

/** Transport-neutral server-side text channel used by GatewayWsConnection. */
export type GatewayTextConnection = {
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
};

export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
};

export class GatewayWsConnection {
  private authed = false;
  private readonly inFlightSessions = new Set<string>();

  constructor(
    private readonly ws: GatewayTextConnection,
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
        let lastError: GatewayEvent | undefined;
        try {
          for await (const event of this.options.gateway.submitTurn(frame.params as never)) {
            if (event.type === "turn_completed") {
              lastCompleted = event;
            }
            if (event.type === "error") {
              lastError = event;
            }
            this.ws.sendText(JSON.stringify({ type: "event", id: frame.id, seq: seq++, final: false, event }));
          }
        } finally {
          if (sessionKey) this.inFlightSessions.delete(sessionKey);
        }
        const terminalEvent = lastError ?? lastCompleted ?? {
          type: "error",
          code: "result_unknown",
          message: "Gateway stream ended without a terminal result.",
          recoverable: true,
        } as const;
        this.ws.sendText(
          JSON.stringify({
            type: "event",
            id: frame.id,
            seq,
            final: true,
            event: terminalEvent,
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
      if (error instanceof DialogGatewayError || hasStructuredErrorCode(error)) {
        this.ws.sendText(
          JSON.stringify({
            type: "response",
            id: frame.id,
            ok: false,
            error: {
              code: error.code,
              message: error instanceof Error ? error.message : String(error),
              ...("details" in error && error.details !== undefined ? { details: error.details } : {}),
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
      case "steer_turn":
        return this.options.gateway.steerTurn(frame.params as never);
      case "cancel_steer":
        return this.options.gateway.cancelSteer(frame.params as never);
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
      case "delete_session":
        if (this.options.gateway.deleteSession) return this.options.gateway.deleteSession(frame.params as never).then(() => ({ ok: true }));
        return Promise.reject(Object.assign(new Error("delete_session is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "export_session_transcript":
        if (this.options.gateway.exportSessionTranscript) return this.options.gateway.exportSessionTranscript(frame.params as never);
        return Promise.reject(Object.assign(new Error("export_session_transcript is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "restore_session_transcript":
        if (this.options.gateway.restoreSessionTranscript) return this.options.gateway.restoreSessionTranscript(frame.params as never);
        return Promise.reject(Object.assign(new Error("restore_session_transcript is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "rename_session":
        if (this.options.gateway.renameSession) return this.options.gateway.renameSession(frame.params as never);
        return Promise.reject(Object.assign(new Error("rename_session is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "tag_session":
        if (this.options.gateway.tagSession) return this.options.gateway.tagSession(frame.params as never);
        return Promise.reject(Object.assign(new Error("tag_session is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "record_agent_status_message":
        if (this.options.gateway.recordAgentStatusMessage) {
          return this.options.gateway.recordAgentStatusMessage(frame.params as never);
        }
        return Promise.resolve({ recorded: false });
      case "describe_server":
        return this.options.gateway.describeServer();
      case "project_files_list":
        return this.requireCapability("project_files_list", "projectFilesList", frame.params);
      case "commands_list":
        return this.requireCapability("commands_list", "commandsList", frame.params);
      case "model_catalog_list":
        return this.requireCapability("model_catalog_list", "modelCatalogList", frame.params);
      case "session_model_get":
        return this.requireCapability("session_model_get", "sessionModelGet", frame.params);
      case "session_model_set":
        return this.requireCapability("session_model_set", "sessionModelSet", frame.params);
      case "session_model_clear":
        return this.requireCapability("session_model_clear", "sessionModelClear", frame.params);
      case "active_turn_snapshot":
        if (this.options.gateway.getActiveTurnSnapshot) {
          return this.options.gateway.getActiveTurnSnapshot(frame.params as never);
        }
        return Promise.resolve({
          active: false,
          sessionKey: (frame.params as { sessionKey?: string } | undefined)?.sessionKey ?? "",
          events: [],
        });
      case "mcp_server_status":
        if (this.options.gateway.mcpServerStatus) return this.options.gateway.mcpServerStatus(frame.params as never);
        return Promise.reject(Object.assign(new Error("mcp_server_status is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "set_mcp_servers":
        if (this.options.gateway.setMcpServers) return this.options.gateway.setMcpServers(frame.params as never);
        return Promise.reject(Object.assign(new Error("set_mcp_servers is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "mcp_server_reconnect":
        if (this.options.gateway.reconnectMcpServer) return this.options.gateway.reconnectMcpServer(frame.params as never).then(() => ({ ok: true }));
        return Promise.reject(Object.assign(new Error("mcp_server_reconnect is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "mcp_server_toggle":
        if (this.options.gateway.toggleMcpServer) return this.options.gateway.toggleMcpServer(frame.params as never).then(() => ({ ok: true }));
        return Promise.reject(Object.assign(new Error("mcp_server_toggle is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "set_mcp_permission_mode_override":
        if (this.options.gateway.setMcpPermissionModeOverride) return this.options.gateway.setMcpPermissionModeOverride(frame.params as never);
        return Promise.reject(Object.assign(new Error("set_mcp_permission_mode_override is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "project_file_read":
        if (this.options.gateway.projectFileRead) return this.options.gateway.projectFileRead(frame.params as never);
        return Promise.reject(Object.assign(new Error("project_file_read is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "set_permission_mode":
        if (this.options.gateway.setPermissionMode) return this.options.gateway.setPermissionMode(frame.params as never);
        return Promise.reject(Object.assign(new Error("set_permission_mode is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "apply_flag_settings":
        if (this.options.gateway.applyFlagSettings) return this.options.gateway.applyFlagSettings(frame.params as never);
        return Promise.reject(Object.assign(new Error("apply_flag_settings is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "update_settings":
        if (this.options.gateway.updateSettings) return this.options.gateway.updateSettings(frame.params as never);
        return Promise.reject(Object.assign(new Error("update_settings is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "resolve_settings":
        if (this.options.gateway.resolveSettings) return this.options.gateway.resolveSettings();
        return Promise.reject(Object.assign(new Error("resolve_settings is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "set_session_thinking":
        if (this.options.gateway.setSessionThinking) return this.options.gateway.setSessionThinking(frame.params as never);
        return Promise.reject(Object.assign(new Error("set_session_thinking is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "output_styles_list":
        if (this.options.gateway.outputStylesList) return this.options.gateway.outputStylesList(frame.params as never);
        return Promise.reject(Object.assign(new Error("output_styles_list is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "set_output_style":
        if (this.options.gateway.setOutputStyle) return this.options.gateway.setOutputStyle(frame.params as never);
        return Promise.reject(Object.assign(new Error("set_output_style is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "reload_output_styles":
        if (this.options.gateway.reloadOutputStyles) return this.options.gateway.reloadOutputStyles(frame.params as never);
        return Promise.reject(Object.assign(new Error("reload_output_styles is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "usage_snapshot":
        if (this.options.gateway.usageSnapshot) return this.options.gateway.usageSnapshot(frame.params as never);
        return Promise.reject(Object.assign(new Error("usage_snapshot is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "model_usage_snapshot":
        if (this.options.gateway.modelUsageSnapshot) return this.options.gateway.modelUsageSnapshot(frame.params as never);
        return Promise.reject(Object.assign(new Error("model_usage_snapshot is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "rewind_files":
        if (this.options.gateway.rewindFiles) return this.options.gateway.rewindFiles(frame.params as never);
        return Promise.reject(Object.assign(new Error("rewind_files is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "background_task_stop":
        if (this.options.gateway.stopBackgroundTask) return this.options.gateway.stopBackgroundTask(frame.params as never);
        return Promise.reject(Object.assign(new Error("background_task_stop is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "background_tasks":
        if (this.options.gateway.backgroundTasks) return this.options.gateway.backgroundTasks(frame.params as never);
        return Promise.reject(Object.assign(new Error("background_tasks is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "hook_async_result":
        if (this.options.gateway.submitAsyncHookResult) return this.options.gateway.submitAsyncHookResult(frame.params as never);
        return Promise.reject(Object.assign(new Error("hook_async_result is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "seed_read_state":
        if (this.options.gateway.seedReadState) return this.options.gateway.seedReadState(frame.params as never);
        return Promise.reject(Object.assign(new Error("seed_read_state is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "supported_agents":
        if (this.options.gateway.supportedAgents) return this.options.gateway.supportedAgents();
        return Promise.reject(Object.assign(new Error("supported_agents is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "cron_create":
        return this.options.gateway.cronCreate(frame.params as never);
      case "cron_list":
        return this.options.gateway.cronList(frame.params as never);
      case "cron_update":
        return this.options.gateway.cronUpdate(frame.params as never);
      case "cron_delete":
        return this.options.gateway.cronDelete(frame.params as never);
      case "cron_stop":
        return this.options.gateway.cronStop(frame.params as never);
      case "cron_run_now":
        return this.options.gateway.cronRunNow(frame.params as never);
      case "elicitation_respond":
        return this.options.gateway.respondElicitation(frame.params as never);
      case "user_dialog_list":
        if (this.options.gateway.listUserDialogs) return this.options.gateway.listUserDialogs(frame.params as never);
        return Promise.reject(Object.assign(new Error("user_dialog_list is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "user_dialog_claim":
        if (this.options.gateway.claimUserDialog) return this.options.gateway.claimUserDialog(frame.params as never);
        return Promise.reject(Object.assign(new Error("user_dialog_claim is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "user_dialog_release":
        if (this.options.gateway.releaseUserDialog) return this.options.gateway.releaseUserDialog(frame.params as never);
        return Promise.reject(Object.assign(new Error("user_dialog_release is unavailable."), { code: "CAPABILITY_UNAVAILABLE" }));
      case "user_dialog_respond":
        return this.options.gateway.respondUserDialog(frame.params as never);
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
      case "replace_last_turn":
        return this.options.gateway.replaceLastTurn(frame.params as never);
      case "finalize_last_turn_replacement":
        return this.options.gateway.finalizeLastTurnReplacement(frame.params as never);
      case "list_projects":
        return this.options.gateway.listProjects();
      case "describe_project":
        return this.options.gateway.describeProject(frame.params as never);
      case "reload_config":
        if (this.options.gateway.reloadConfig) {
          return this.options.gateway.reloadConfig();
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
      case "prepare_weixin_login":
        if (this.options.gateway.prepareWeixinLogin) {
          return this.options.gateway.prepareWeixinLogin();
        }
        return Promise.resolve({
          requested: false,
          requestedAt: new Date().toISOString(),
          reason: "unsupported",
        });
      case "reload_extensions":
        if (this.options.gateway.reloadExtensions) {
          return this.options.gateway.reloadExtensions(frame.params as never);
        }
        return Promise.resolve({ reloaded: false, reason: "unsupported" });
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

  private requireCapability(
    capability: string,
    method: "projectFilesList" | "commandsList" | "modelCatalogList" | "sessionModelGet" | "sessionModelSet" | "sessionModelClear",
    params: unknown,
  ): Promise<unknown> {
    const handler = this.options.gateway[method] as ((input: never) => Promise<unknown>) | undefined;
    if (!handler) {
      return Promise.reject(Object.assign(new Error(`Gateway capability ${capability} is unavailable.`), {
        code: "CAPABILITY_UNAVAILABLE",
      }));
    }
    return handler.call(this.options.gateway, params as never);
  }
}

function hasStructuredErrorCode(error: unknown): error is Error & { code: string; details?: unknown } {
  return error instanceof Error
    && typeof (error as Error & { code?: unknown }).code === "string";
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
