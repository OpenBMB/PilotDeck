/**
 * PilotDeck bridge — the only chat-execution entry point in `ui/server/`.
 *
 *
 *   1. Connects to the standalone PilotDeck gateway server
 *      (`pilotdeck server`, default ws://127.0.0.1:18789/ws) as a
 *      WebSocket client. We never instantiate an in-process gateway
 *      here — that would create a second, divergent agent runtime that
 *      doesn't share `~/.pilotdeck/projects/<id>/chats/*.jsonl` writes
 *      and permission state with the CLI/TUI surfaces. One process, one
 *      gateway.
 *   2. Maps each old "sessionId" → PilotDeck "sessionKey" (1:1, generated
 *      on first turn and remembered for resume).
 *   3. Translates GatewayEvent → NormalizedMessage and writes back via
 *      `writer.send(...)` so the existing UI rendering pipeline stays
 *      unchanged.
 *   4. Tracks active runs so `abort-session` and the `complete` ack work.
 *
 * Anything that is NOT chat execution (project listing, files, git, mcp,
 * skills, taskmaster, memory, cron management) still runs through the
 * existing `ui/server/` route handlers — those are local/disk operations
 * that do not need an agent runtime.
 *
 * Two-process launch:
 *
 *   - `pilotdeck server` (port 18789) owns the gateway, agent loop,
 *     model router, MCP runtime, cron daemon, and on-disk session
 *     transcripts. Edit `src/**` then restart this process to pick up
 *     changes — no `npm run build` required when running via `tsx`.
 *   - `ui/server/index.js` (port 3001) is the express bridge: REST
 *     endpoints for non-agent UI concerns + a WebSocket adapter that
 *     re-shapes gateway events into the legacy NormalizedMessage frames
 *     the React frontend reducer still expects.
 *
 * The pair is started together via `cd ui && npm run dev` (or
 * `npm start`), which uses `concurrently` to launch both. Either order
 * is fine — the bridge retries the WebSocket handshake for
 * `GATEWAY_CONNECT_TIMEOUT_MS` so race conditions resolve themselves.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { installGlobalProxy } from '../../src/cli/proxy.js';
await installGlobalProxy();

import { resolvePilotHome, createProjectId, sanitizeSessionIdForPath } from './utils/pilotPaths.js';
// Read the gateway client straight from TypeScript source via tsx — the UI
// server is launched with `node --import tsx`, so no prior `npm run build`
// is required. (A prior tsx 4.x JSDoc dynamic-import parse bug was fixed by
// rewriting the offending @type annotation below to `ReturnType<typeof
// createRemoteGateway>`, which is why this import can live on `src/` again.)
import { createRemoteGateway } from '../../src/gateway/index.js';
import {
    createVisibleErrorStatusDetail,
    isVisibleFailureStatusDetail,
} from '../../src/status/agentStatus.js';
import { createNormalizedMessage } from './pilotdeck-message.js';
import { readPermissionSettings } from './services/permissionSettings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GENERAL_HOME = resolvePilotHome(process.env);

const GATEWAY_URL =
    process.env.PILOTDECK_GATEWAY_URL || 'ws://127.0.0.1:18789/ws';
const GATEWAY_TOKEN_PATH =
    process.env.PILOTDECK_GATEWAY_TOKEN_PATH ||
    path.join(GENERAL_HOME, 'server-token');
// The two processes (gateway + bridge) are typically started in
// parallel by `concurrently`. We allow up to 30 s for the gateway to
// come up before failing the first call — covers cold MCP startup on
// slower machines.
const GATEWAY_CONNECT_TIMEOUT_MS =
    Number.parseInt(process.env.PILOTDECK_BRIDGE_TIMEOUT ?? '', 10) || 60_000;
const GATEWAY_CONNECT_RETRY_INTERVAL_MS = 500;
const subagentActivityStarts = new Map();
/** @type {Map<string, string[]>} sessionId → [toolCallId, ...] for pending agent/Task tool calls */
const pendingAgentToolCalls = new Map();
const visibleFailureAgentStatusEvents = new Set([
    'model_empty_response_exhausted',
    'max_turns_reached',
    'max_output_recovery_exhausted',
    'model_request_failed',
    'tool_call_recovery_exhausted',
    'tool_error_loop',
    'lifecycle_blocked',
    'turn_failed',
    'turn_timeout',
    'gateway_submit_failed',
    'session_busy',
    'gateway_bridge_error',
    'gateway_stream_ended_without_completion',
    'web_http_request_failed',
    'project_unavailable',
    'config_invalid',
    'gateway_unavailable',
    'channel_submit_failed',
    'subagent_failed',
    'content_filter_stop',
    'unknown_finish_reason',
]);

function normalizeToolDisplayName(name) {
    const aliases = {
        agent: 'Task',
        ask_user_question: 'AskUserQuestion',
        bash: 'Bash',
        edit_file: 'Edit',
        glob: 'Glob',
        grep: 'Grep',
        read_file: 'Read',
        write_file: 'Write',
    };
    if (aliases[name]) return aliases[name];
    if (name === 'todo_write') return 'TodoWrite';
    if (name === 'todo_read') return 'TodoRead';
    return name;
}

function readOnlyModeToolDenyCode(text) {
    if (typeof text !== 'string') return undefined;
    if (/\[PLAN_MODE_VIOLATION\]/i.test(text) || /plan mode denies side-effecting tool\b/i.test(text)) {
        return 'plan_mode_denied';
    }
    if (/\[ASK_MODE_VIOLATION\]/i.test(text) || /ask mode denies side-effecting tool\b/i.test(text)) {
        return 'ask_mode_denied';
    }
    return undefined;
}

function isSearchToolName(name) {
    const normalized = String(name || '').toLowerCase();
    return normalized === 'grep' || normalized === 'glob';
}

function normalizeToolErrorCode(errorCode, resultPreview) {
    if (errorCode === 'plan_mode_violation') return 'plan_mode_denied';
    if (errorCode === 'ask_mode_violation') return 'ask_mode_denied';
    return readOnlyModeToolDenyCode(resultPreview) || errorCode;
}

function isVisibleFailureAgentStatus(event) {
    return event?.type === 'agent_status'
        && (visibleFailureAgentStatusEvents.has(event.event) || isVisibleFailureStatusDetail(event.detail))
        && event.detail?.visible !== false;
}

/**
 * Default permission mode for sessions started from the Web UI. We use
 * `default` so PilotDeck's `Permission.decide()` fully evaluates rules
 * + tool semantics — read-only tools allow, side-effecting tools either
 * surface an interactive `permission_request` (resolved via the banner)
 * or short-circuit on an allow rule the user accumulated this session.
 * Override with `PILOTDECK_WEB_PERMISSION_MODE`.
 */
const WEB_DEFAULT_PERMISSION_MODE =
    process.env.PILOTDECK_WEB_PERMISSION_MODE || 'default';


// Resolves to the Gateway returned by `createRemoteGateway`. We express
// the type via `typeof createRemoteGateway` (the symbol is already imported
// above) instead of a JSDoc dynamic-import annotation, because some tsx 4.x
// builds mis-parse such tokens inside JSDoc when running through
// `node --import tsx`, producing a spurious "Parse error" at EOF during
// ESM rewriting on fresh installs.
/** @type {ReturnType<typeof createRemoteGateway> | null} */
let gatewayPromise = null;

async function readGatewayToken() {
    try {
        const raw = await fsPromises.readFile(GATEWAY_TOKEN_PATH, 'utf8');
        const trimmed = raw.trim();
        return trimmed || null;
    } catch {
        return null;
    }
}

async function connectWithRetry() {
    const deadline = Date.now() + GATEWAY_CONNECT_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
        const token = await readGatewayToken();
        if (token) {
            try {
                const gateway = await createRemoteGateway({
                    url: GATEWAY_URL,
                    token,
                    clientName: 'web',
                });
                console.log(
                    `[pilotdeck-bridge] connected → ${GATEWAY_URL}`,
                );
                return gateway;
            } catch (error) {
                lastError = error;
            }
        }
        await new Promise((resolve) =>
            setTimeout(resolve, GATEWAY_CONNECT_RETRY_INTERVAL_MS),
        );
    }
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(
        `[pilotdeck-bridge] gateway connect failed after ${GATEWAY_CONNECT_TIMEOUT_MS}ms${detail}`,
    );
}

function ensureGateway() {
    if (!gatewayPromise) {
        gatewayPromise = connectWithRetry().catch((error) => {
            // Reset so the next caller retries instead of cementing the
            // failure forever. The deadline inside connectWithRetry()
            // already bounds individual attempts.
            gatewayPromise = null;
            throw error;
        });
    }
    return gatewayPromise;
}

function resetGatewayConnection() {
    gatewayPromise = null;
}

export function isGatewayUnavailableError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /gateway websocket (closed|is not connected)|failed to connect to gateway websocket|gateway hello timed out|gateway closed during hello|gateway connect failed/i.test(message);
}

/**
 * Public accessor for the shared gateway client. Other ui/server modules
 * (`projects.js`, etc.) await this so they share one WebSocket
 * connection instead of opening their own.
 */
export async function getPilotDeckGateway() {
    return ensureGateway();
}

export function getPilotDeckRepoRoot() {
    return REPO_ROOT;
}

/**
 * Per-session bookkeeping kept locally so abort + permission flows can
 * find their target without round-tripping to the gateway just to
 * resolve a sessionId. The gateway is still the source of truth for
 * the transcript and the agent state machine.
 */
const sessionState = new Map();

function isPilotDeckSessionKey(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (value.startsWith('new-session-')) return false;
    if (/^web[:_-]s_/.test(value)) return true;
    if (/^[a-z]+:/.test(value)) return true;
    return false;
}

function newSessionKey() {
    // On Windows, colons are illegal in filenames. The on-disk session file
    // is named after the key via sanitizeSessionIdForPath which replaces ':'
    // with '-'. Using '-' from the start avoids a mismatch between the key
    // the frontend holds (from session_created) and the key the session
    // listing returns (from the filename).
    const sep = process.platform === 'win32' ? '-' : ':';
    return `web${sep}s_${randomUUID()}`;
}

function ensureSessionState(sessionKey, projectKey, channelKey) {
    let state = sessionState.get(sessionKey);
    if (!state) {
        state = {
            sessionKey,
            projectKey,
            channelKey,
            runId: undefined,
            active: false,
            tokenBudget: null,
            hasVisibleFailureStatus: false,
        };
        sessionState.set(sessionKey, state);
    } else {
        state.projectKey = projectKey;
        state.channelKey = channelKey;
    }
    return state;
}

function clearActiveRunIfCurrent(state, runId) {
    if (!state || state.runId !== runId) return;
    state.active = false;
    state.runId = undefined;
}

export function getSessionTokenBudget(sessionKey) {
    const state = sessionState.get(sessionKey);
    return state?.tokenBudget || {
        used: 0,
        total: 0,
        unknown: true,
    };
}

/**
 * Convert UI-shape image attachments into Gateway-shape ChannelAttachment[].
 *
 * UI sends:
 *   { name, data: 'data:image/png;base64,XXX', path, size, mimeType }
 *
 * Gateway expects ChannelAttachment:
 *   { type: 'image', name, path, mimeType, content: <raw base64, no data: prefix>, bytes }
 *
 * The bare-base64 form matches how `CanonicalImageBlock` and the
 * AttachmentResolver store the payload elsewhere in the codebase.
 *
 * Returns undefined when there's nothing to forward — so callers can
 * spread it conditionally without injecting an empty array.
 *
 * @param {unknown} images
 * @returns {Array<{type:'image',name?:string,path?:string,mimeType:string,content:string,bytes?:number}>|undefined}
 */
function uiImagesToAttachments(images) {
    if (!Array.isArray(images) || images.length === 0) return undefined;
    const out = [];
    for (const img of images) {
        if (!img || typeof img !== 'object') continue;
        const raw = typeof img.data === 'string' ? img.data : '';
        if (!raw) continue;
        // Accept both bare base64 and full data URLs. We pluck the
        // declared mime out of the data URL when the caller did not
        // pass one explicitly, since we can't reliably guess otherwise.
        const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.*)$/);
        const mimeType = String(img.mimeType || dataUrlMatch?.[1] || 'image/png');
        const base64 = dataUrlMatch ? dataUrlMatch[2] : raw;
        if (!base64) continue;
        out.push({
            type: 'image',
            name: typeof img.name === 'string' ? img.name : undefined,
            ...(typeof img.path === 'string' && img.path ? { path: img.path } : {}),
            mimeType,
            content: base64,
            ...(typeof img.size === 'number' ? { bytes: img.size } : {}),
        });
    }
    return out.length > 0 ? out : undefined;
}

function uiFilesToAttachments(files) {
    if (!Array.isArray(files) || files.length === 0) return undefined;
    const out = [];
    for (const file of files) {
        if (!file || typeof file !== 'object') continue;
        if (file.kind === 'document-selection') continue;
        const filePath = typeof file.path === 'string' ? file.path : '';
        if (!filePath) continue;
        out.push({
            type: 'file',
            name: typeof file.name === 'string' ? file.name : undefined,
            path: filePath,
            mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined,
            ...(typeof file.size === 'number' ? { bytes: file.size } : {}),
        });
    }
    return out.length > 0 ? out : undefined;
}

function normalizePermissionMode(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === 'default' || value === 'plan' || value === 'bypassPermissions') return value;
    return 'default';
}

function normalizeRunMode(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === 'agent' || value === 'plan' || value === 'ask') return value;
    return 'agent';
}

function resolvePermissionMode(options) {
    const explicit = normalizePermissionMode(options?.permissionMode || options?.mode);
    // A literal "default" from the chat composer is the implicit
    // no-special-mode position of the per-turn picker, not a real
    // per-turn override. Let the user-level skipPermissions toggle
    // win over it. Genuine non-default picks (plan / bypassPermissions)
    // still take precedence — they're a deliberate per-turn decision.
    if (explicit && explicit !== 'default') return explicit;
    const persisted = readPermissionSettings();
    if (persisted.skipPermissions === true) {
        return 'bypassPermissions';
    }
    return explicit || normalizePermissionMode(WEB_DEFAULT_PERMISSION_MODE) || 'default';
}

/**
 * Map a `GatewayEvent` to one or more legacy `NormalizedMessage` frames.
 *
 * @param {object} event Gateway event payload.
 * @param {string} sessionId UI-facing session id.
 * @param {string} provider Provider hint (pilotdeck).
 * @returns {object[]} NormalizedMessage frames.
 */
export function gatewayEventToFrames(event, sessionId, provider) {
    const base = { sessionId, provider };
    switch (event.type) {
        case 'turn_started':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'started',
                }),
            ];
        case 'model_request_started':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'model_request_started',
                    model: event.model,
                    provider: event.provider,
                }),
            ];
        case 'assistant_text_delta':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'stream_delta',
                    content: event.text,
                }),
            ];
        case 'assistant_thinking_delta':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'thinking',
                    content: event.text,
                }),
            ];
        case 'tool_call_started': {
            const displayName = normalizeToolDisplayName(event.name);
            const rawName = String(event.name || '').toLowerCase();
            if (rawName === 'agent' || rawName === 'task') {
                const pending = pendingAgentToolCalls.get(base.sessionId) || [];
                pending.push(event.toolCallId);
                pendingAgentToolCalls.set(base.sessionId, pending);
            }
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_use',
                    toolId: event.toolCallId,
                    toolName: displayName,
                    toolInput: tryParseJson(event.argsPreview),
                }),
            ];
        }
        case 'tool_call_finished': {
            const normalizedErrorCode = normalizeToolErrorCode(event.errorCode, event.resultPreview);
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_result',
                    toolId: event.toolCallId,
                    content: event.resultPreview ?? '',
                    isError: !event.ok,
                    // errorCode lets the UI distinguish permission denials
                    // (`permission_denied` / `permission_required`) from
                    // ordinary execution failures (`tool_execution_failed`,
                    // `file_not_found`, …) so the "Add to Allowed Tools"
                    // affordance only fires for the former.
                    ...(normalizedErrorCode && { errorCode: normalizedErrorCode }),
                    // Inline tool-result images (e.g. read_file on a PNG).
                    // The wire shape uses raw base64; we wrap as data URLs
                    // here so the UI can drop them straight into <img src>.
                    ...(Array.isArray(event.images) && event.images.length > 0
                        ? {
                              toolResultImages: event.images.map((image) => ({
                                  data: `data:${image.mimeType};base64,${image.data}`,
                                  mimeType: image.mimeType,
                              })),
                          }
                        : {}),
                    ...(event.toolName === 'exit_plan_mode' && event.data?.planFilePath
                        ? {
                              planFilePath: event.data.planFilePath,
                              planTitle: event.data.planTitle,
                              planSummary: event.data.planSummary,
                          }
                        : {}),
                    ...(event.toolName === 'ask_user_question' && event.data
                        ? { toolUseResult: event.data }
                        : {}),
                    ...(isSearchToolName(event.toolName) && event.data
                        ? { toolUseResult: event.data }
                        : {}),
                }),
            ];
        }
        case 'permission_request':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'permission_request',
                    requestId: event.requestId,
                    toolName: event.toolName,
                    input: event.payload,
                    context: { provider },
                }),
            ];
        case 'elicitation_request':
            // Route structured elicitation through the same `permission_request`
            // shape the UI already uses for the permission banner, so the
            // registered `AskUserQuestion` PermissionPanel (rich multi-step
            // multi-select dialog) renders inline in the chat instead of the
            // legacy "wait in CLI" yellow box. We force `toolName` to the
            // PascalCase alias that matches `registerPermissionPanel('AskUserQuestion', ...)`
            // and tag the frame with `isElicitation: true` so the composer can
            // route the user's answer back through `elicitation-response`
            // (GatewayPermissionBus).
            if (event.toolName === 'exit_plan_mode') {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'permission_request',
                        requestId: event.requestId,
                        toolCallId: event.toolCallId,
                        toolName: 'ExitPlanModeV2',
                        input: {
                            plan: event.metadata?.plan,
                            planFilePath: event.metadata?.planFilePath,
                            questions: event.questions,
                            metadata: event.metadata,
                        },
                        context: { provider, originalToolName: event.toolName },
                        isElicitation: true,
                    }),
                ];
            }
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'permission_request',
                    requestId: event.requestId,
                    toolCallId: event.toolCallId,
                    toolName: 'AskUserQuestion',
                    input: {
                        questions: event.questions,
                        metadata: event.metadata,
                    },
                    context: { provider, originalToolName: event.toolName },
                    isElicitation: true,
                }),
            ];
        case 'elicitation_cancelled':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'permission_cancelled',
                    requestId: event.requestId,
                }),
            ];
        case 'structured_output':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'structured',
                    payload: event.payload,
                }),
            ];
        case 'plan_mode_changed':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: `mode:${event.mode}`,
                }),
            ];
        case 'turn_completed':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'complete',
                    exitCode: 0,
                    success: true,
                    finishReason: event.finishReason,
                    usage: event.usage,
                }),
            ];
        case 'context_budget':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'token_budget',
                    tokenBudget: {
                        used: event.used,
                        total: event.total,
                        ratio: event.ratio,
                        state: event.state,
                    },
                }),
            ];
        case 'error':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'error',
                    content: event.message,
                    code: event.code,
                    recoverable: event.recoverable,
                    userHint: event.userHint,
                }),
            ];
        case 'agent_status': {
            const subagentFrames = createSubagentStatusFrames(event, base);
            if (subagentFrames && subagentFrames.length > 0) return subagentFrames;

            const detail = event.detail || {};
            if (event.event === 'compact_started') {
                const compactProgress = {
                    level: detail.level || 1,
                    stage: detail.stage || 'compacting',
                    label: detail.label || detail.stage || 'Compacting',
                    state: 'running',
                    pre_tokens: detail.preTokens,
                    reason: detail.trigger,
                };
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'status',
                        text: 'compacting',
                        tokens: 0,
                        canInterrupt: true,
                        compactProgress,
                    }),
                ];
            }
            if (event.event === 'compact_completed') {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'compact_boundary',
                        trigger: detail.trigger || 'auto',
                        preTokens: detail.preTokens,
                        compactLevel: detail.level,
                        compactStage: detail.stage,
                        compactStageLabel: detail.stageLabel || detail.stage,
                        compactMetadata: detail,
                    }),
                ];
            }
            if (event.event === 'retry_progress') {
                const retryText = detail.reason === 'continuation'
                    ? 'Continuing response'
                    : detail.reason === 'rate_limit' || detail.reason === 'overloaded'
                        ? 'Switching model'
                        : 'Reconnecting';
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'status',
                        text: `${retryText}... ${detail.attempt}/${detail.maxAttempts}`,
                        tokens: 0,
                        canInterrupt: true,
                        retryProgress: {
                            attempt: detail.attempt,
                            maxAttempts: detail.maxAttempts,
                            delayMs: detail.delayMs,
                            reason: detail.reason,
                            provider: detail.provider,
                            model: detail.model,
                        },
                    }),
                ];
            }
            if (event.event === 'model_empty_response_exhausted') {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'error',
                        content: detail.message || 'The model returned empty content repeatedly, so this turn has stopped. Try again later or increase max output tokens.',
                        code: event.event,
                        recoverable: false,
                        userHint: detail.userHint,
                    }),
                ];
            }
            if (event.event === 'max_turns_reached') {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'error',
                        content: detail.message || 'Reached the maximum number of turns, so this turn has stopped. Increase maxTurns or split the task into smaller steps and try again.',
                        code: event.event,
                        recoverable: false,
                        userHint: detail.userHint,
                    }),
                ];
            }
            if (visibleFailureAgentStatusEvents.has(event.event) || isVisibleFailureStatusDetail(detail)) {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'error',
                        content: detail.message || 'Agent execution stopped before producing a complete response. Please retry or adjust the task.',
                        code: event.event,
                        recoverable: false,
                        userHint: detail.userHint,
                    }),
                ];
            }
            if (event.event === 'structured_output_completed' || event.event === 'turn_aborted') {
                return [
                    createNormalizedMessage({
                        ...base,
                        kind: 'status',
                        content: detail.message || 'This turn ended before producing a standard assistant response.',
                        code: event.event,
                        recoverable: false,
                        userHint: detail.userHint,
                    }),
                ];
            }
            return [];
        }
        default:
            return [];
    }
}

function createSubagentStatusFrames(event, base) {
    const detail = event?.detail || {};
    const detailFrames = createSubagentDetailFrames(event, base, detail);
    if (detailFrames) return detailFrames;

    const visibleEvents = [
        'subagent_started',
        'subagent_completed',
        'subagent_status',
    ];
    if (!visibleEvents.includes(event?.event)) return null;

    const subagentId = String(detail.subagentId || 'unknown');
    const status = normalizeSubagentStatus(event.event, detail);
    const subagentType = detail.subagentType || 'agent';
    const activityKey = `${base.sessionId || ''}:${subagentId}`;
    const nowMs = Date.now();
    const reportedDurationMs = Number(detail.durationMs);
    let startedAtMs = subagentActivityStarts.get(activityKey);
    if (event.event === 'subagent_started' || !startedAtMs) {
        startedAtMs = Number.isFinite(reportedDurationMs) && reportedDurationMs > 0
            ? nowMs - reportedDurationMs
            : nowMs;
        subagentActivityStarts.set(activityKey, startedAtMs);
    }

    const durationMs = Number.isFinite(reportedDurationMs) && reportedDurationMs >= 0
        ? reportedDurationMs
        : Math.max(0, nowMs - startedAtMs);
    const isDone = status === 'completed' || status === 'failed';
    const title = formatSubagentActivityTitle(subagentType, status);
    const activityDetail = formatSubagentActivityDetail(event.event, detail, status);
    const activity = createNormalizedMessage({
        ...base,
        id: `subagent_activity_${sanitizeMessageId(base.sessionId)}_${sanitizeMessageId(subagentId)}`,
        kind: 'agent_activity',
        activityId: `subagent:${subagentId}`,
        runId: `subagent:${subagentId}`,
        phase: 'subagent',
        state: status,
        title,
        detail: activityDetail,
        subagentId,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: isDone ? new Date(nowMs).toISOString() : null,
        durationMs,
        severity: status === 'failed' ? 'error' : undefined,
        toolName: 'agent',
    });
    if (isDone) {
        subagentActivityStarts.delete(activityKey);
    }

    const frames = [activity];

    if (event.event === 'subagent_started') {
        let toolCallId = detail.toolCallId;
        if (!toolCallId) {
            const pending = pendingAgentToolCalls.get(base.sessionId) || [];
            toolCallId = pending.shift();
            if (pending.length === 0) {
                pendingAgentToolCalls.delete(base.sessionId);
            } else {
                pendingAgentToolCalls.set(base.sessionId, pending);
            }
        } else {
            const pending = pendingAgentToolCalls.get(base.sessionId);
            if (pending) {
                const idx = pending.indexOf(toolCallId);
                if (idx !== -1) pending.splice(idx, 1);
                if (pending.length === 0) pendingAgentToolCalls.delete(base.sessionId);
            }
        }
        frames.push(createNormalizedMessage({
            ...base,
            id: `subagent_link_${sanitizeMessageId(base.sessionId)}_${sanitizeMessageId(subagentId)}`,
            kind: 'subagent_link',
            subagentId,
            subagentType,
            toolCallId: toolCallId || undefined,
        }));
    }

    return frames;
}

function createSubagentDetailFrames(event, base, detail) {
    const subagentId = String(detail.subagentId || '');
    if (!subagentId) return null;
    const detailSessionId = `${base.sessionId}::sub::${subagentId}`;
    const detailBase = {
        ...base,
        sessionId: base.sessionId,
        subagentId,
        isSubagentDetail: true,
    };

    switch (event?.event) {
        case 'subagent_text_delta':
            return [createNormalizedMessage({
                ...detailBase,
                id: `subagent_detail_delta_${sanitizeMessageId(detailSessionId)}_${Date.now()}`,
                kind: 'stream_delta',
                content: detail.text || '',
            })];
        case 'subagent_thinking_delta':
            return [createNormalizedMessage({
                ...detailBase,
                id: `subagent_detail_thinking_${sanitizeMessageId(detailSessionId)}_${Date.now()}`,
                kind: 'thinking',
                content: detail.text || '',
            })];
        case 'subagent_tool_call_started': {
            const toolCallId = String(detail.toolCallId || randomUUID());
            return [createNormalizedMessage({
                ...detailBase,
                id: `${detailSessionId}-tool-${toolCallId}`,
                kind: 'tool_use',
                toolName: normalizeToolDisplayName(detail.toolName || ''),
                toolInput: detail.input || {},
                toolId: toolCallId,
            })];
        }
        case 'subagent_tool_result': {
            const toolCallId = String(detail.toolCallId || randomUUID());
            return [createNormalizedMessage({
                ...detailBase,
                id: `${detailSessionId}-tool-${toolCallId}-result`,
                kind: 'tool_result',
                toolId: toolCallId,
                content: detail.content || detail.preview || '',
                isError: detail.ok === false,
                ...(detail.errorCode ? { errorCode: detail.errorCode } : {}),
            })];
        }
        case 'subagent_model_error':
            return [createNormalizedMessage({
                ...detailBase,
                id: `subagent_detail_error_${sanitizeMessageId(detailSessionId)}_${Date.now()}`,
                kind: 'error',
                content: detail.message || detail.error || 'Subagent model error',
            })];
        default:
            return null;
    }
}

function formatSubagentActivityDetail(eventName, detail, status) {
    const toolName = typeof detail?.toolName === 'string' ? detail.toolName : '';
    const rawStatus = String(detail?.status || '');
    if (status === 'failed') {
        return '执行失败';
    }
    if (status === 'completed') {
        return '已完成';
    }
    if ((rawStatus === 'tool_started' || rawStatus === 'running') && toolName) {
        return `正在执行 ${toolName}`;
    }
    if (rawStatus === 'tool_completed' && toolName) {
        return `已完成 ${toolName}`;
    }
    if (eventName === 'subagent_started' || rawStatus === 'waiting_model' || !toolName) {
        return '思考中';
    }
    return `正在执行 ${toolName}`;
}

function formatSubagentActivityTitle(subagentType, status) {
    if (status === 'completed') {
        return `Subagent ${subagentType} completed`;
    }
    if (status === 'failed') {
        return `Subagent ${subagentType} failed`;
    }
    return `Subagent ${subagentType} running`;
}

function normalizeSubagentStatus(eventName, detail) {
    if (eventName === 'subagent_completed') {
        return detail.success === false ? 'failed' : 'completed';
    }
    return 'running';
}

function sanitizeMessageId(value) {
    return String(value || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function tryParseJson(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function createBridgeFailureStatusEvent({ event, message, userHint, scope = 'turn', detail = {} }) {
    return {
        type: 'agent_status',
        event,
        detail: createVisibleErrorStatusDetail({
            message,
            code: event,
            userHint,
            scope,
            source: 'web_bridge',
            detail,
        }),
    };
}

function sendBridgeStatusEvent(writer, statusEvent, sessionKey, provider) {
    for (const frame of gatewayEventToFrames(statusEvent, sessionKey, provider)) {
        writer.send(frame);
    }
}

/**
 * Run a chat command through the PilotDeck gateway.
 *
 * The frontend addresses sessions by the PilotDeck `sessionKey` itself
 * (`web:s_<uuid>`). On the first turn we mint a key and announce it via
 * a `session_created` frame; the frontend stores that and uses it on
 * every subsequent turn (and after page refresh, since the URL embeds
 * it). The transcript on disk is named after the same key, so
 * `/api/sessions/<sessionKey>/messages` resolves cleanly.
 *
 * Permission grants accumulated via the in-banner "Allow + remember"
 * action are stored server-side for the duration of the agent session
 * (see `createGatewayPermissionHook`) — `toolsSettings.allowedTools`
 * pre-population from the legacy settings panel is currently NOT
 * re-played here because the override map lives in another process.
 * That feature can be restored by extending `submitTurn` to carry an
 * optional `permissionAllow[]` payload; not needed for the common
 * banner-driven flow.
 *
 * @param {string} command User prompt text.
 * @param {object} options Legacy options blob from the WS frame.
 * @param {{send: (msg: object) => void}} writer Existing writer.
 * @param {string} provider Provider hint (kept for legacy frame branding).
 */
export async function runChatViaGateway(
    command,
    options = {},
    writer,
    provider = 'pilotdeck',
) {
    const projectKey = options.projectPath || options.cwd || GENERAL_HOME;
    const channelKey = 'web';

    const incoming = options.sessionId || options.sessionKey;
    const sessionKey = isPilotDeckSessionKey(incoming) ? incoming : newSessionKey();
    const isNewSession = sessionKey !== incoming;

    const state = ensureSessionState(sessionKey, projectKey, channelKey);
    const staleRunId = state.active ? state.runId : undefined;

    if (isNewSession) {
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'session_created',
                newSessionId: sessionKey,
                sessionKey,
            }),
        );
    }

    const runId = randomUUID();
    state.runId = runId;
    state.active = true;
    state.hasVisibleFailureStatus = false;

    const attachments = [
        ...(uiImagesToAttachments(options?.images) || []),
        ...(uiFilesToAttachments(options?.attachments) || []),
    ];
    const resolvedMode = resolvePermissionMode(options);
    const basePermissionMode = normalizePermissionMode(options?.basePermissionMode);
    const runMode = normalizeRunMode(options?.runMode) || (resolvedMode === 'plan' ? 'plan' : 'agent');
    console.log(`[pilotdeck-bridge] submitTurn runMode=${runMode} mode=${resolvedMode} (options.permissionMode=${options?.permissionMode}, options.mode=${options?.mode})`);

    let gw = null;
    try {
        gw = await ensureGateway();

        // If a previous turn for this session is still in-flight (e.g. the
        // browser reloaded while a permission prompt was pending), abort it
        // before starting the new one. Without this the gateway rejects
        // with session_busy because the old turn's inFlightTurns slot is
        // still occupied.
        if (staleRunId) {
            console.log(
                `[pilotdeck-bridge] aborting stale turn ${staleRunId} for ${sessionKey} before resubmit`,
            );
            try {
                await gw.abortTurn({ sessionKey, runId: staleRunId, reason: 'system:stale_turn' });
            } catch (err) {
                console.warn('[pilotdeck-bridge] stale abort failed (continuing):', err?.message || err);
            }
        }

        const stream = gw.submitTurn({
            sessionKey,
            channelKey,
            projectKey,
            message: command ?? '',
            runMode,
            mode: resolvedMode,
            runId,
            ...(options?.thinking ? { thinking: options.thinking } : {}),
            ...(basePermissionMode ? { basePermissionMode } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(options.workspaceCwd ? { workspaceCwd: options.workspaceCwd } : {}),
        });

        let sawTurnCompleted = false;
        let sawGatewayError = false;
        for await (const event of stream) {
            if (isVisibleFailureAgentStatus(event)) {
                state.hasVisibleFailureStatus = true;
            }
            if (event && event.type === 'error') {
                sawGatewayError = true;
                console.error(
                    '[pilotdeck-bridge] gateway error event:',
                    JSON.stringify(
                        {
                            sessionKey,
                            projectKey,
                            runId,
                            code: event.code,
                            message: event.message,
                            recoverable: event.recoverable,
                        },
                        null,
                        2,
                    ),
                );
            }
            if (event && event.type === 'context_budget') {
                state.tokenBudget = {
                    used: event.used,
                    total: event.total,
                    ratio: event.ratio,
                    state: event.state,
                };
            }
            // Clear active flag as soon as we see turn_completed so that
            // a subsequent submitTurn from the user (who already sees the
            // input box) does NOT trigger the stale-abort path while we
            // wait for the async generator to fully close.
            if (event && event.type === 'turn_completed') {
                sawTurnCompleted = true;
                clearActiveRunIfCurrent(state, runId);
            }
            const suppressDuplicateError = event?.type === 'error' && state.hasVisibleFailureStatus;
            if (!suppressDuplicateError) {
                for (const frame of gatewayEventToFrames(event, sessionKey, provider)) {
                    writer.send(frame);
                }
            }
        }

        if (!sawTurnCompleted && !sawGatewayError) {
            const message = 'Gateway stream ended before turn_completed; no final assistant response was received.';
            const userHint = 'The model stream ended before PilotDeck received a final turn result. Please retry this message; if it repeats, check the gateway/model provider logs.';
            const statusEvent = createBridgeFailureStatusEvent({
                event: 'gateway_stream_ended_without_completion',
                message,
                userHint,
            });
            console.warn(`[pilotdeck-bridge] ${message}`, { sessionKey, projectKey, runId });
            await recordGatewayStatusMessage(gw, {
                sessionKey,
                turnId: runId,
                projectKey,
                event: statusEvent.event,
                text: message,
                detail: statusEvent.detail,
            });
            state.hasVisibleFailureStatus = true;
            sendBridgeStatusEvent(writer, statusEvent, sessionKey, provider);
        }
    } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const gatewayUnavailable = !gw || isGatewayUnavailableError(error);
        if (gatewayUnavailable) {
            resetGatewayConnection();
        }
        const message = gatewayUnavailable ? 'PilotDeck gateway is unavailable.' : rawMessage;
        const statusEvent = gatewayUnavailable
            ? createBridgeFailureStatusEvent({
                event: 'gateway_unavailable',
                message,
                userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
                scope: 'preflight',
                detail: {
                    gatewayUrl: GATEWAY_URL,
                },
            })
            : createBridgeFailureStatusEvent({
                event: 'gateway_bridge_error',
                message,
                userHint: 'The Web bridge failed while streaming this turn. Retry this message; if it repeats, check the UI server and gateway logs.',
            });

        console.error(
            '[pilotdeck-bridge] runChatViaGateway threw:',
            error instanceof Error ? (error.stack || error.message) : error,
        );
        if (gw) {
            await recordGatewayStatusMessage(gw, {
                sessionKey,
                turnId: runId,
                projectKey,
                event: statusEvent.event,
                text: message,
                detail: statusEvent.detail,
            });
        }
        state.hasVisibleFailureStatus = true;
        sendBridgeStatusEvent(writer, statusEvent, sessionKey, provider);
    } finally {
        clearActiveRunIfCurrent(state, runId);
    }
}

async function recordGatewayStatusMessage(gateway, { sessionKey, turnId, projectKey, event, text, detail }) {
    if (!gateway?.recordAgentStatusMessage) return;
    try {
        await gateway.recordAgentStatusMessage({
            sessionKey,
            turnId,
            projectKey,
            status: {
                event,
                kind: 'error',
                text,
                detail,
            },
        });
    } catch (error) {
        console.warn('[pilotdeck-bridge] failed to record gateway status message:', error?.message || error);
    }
}

export async function abortViaGateway(sessionId, _provider = 'pilotdeck') {
    const gw = await ensureGateway();
    const sessionKey = isPilotDeckSessionKey(sessionId) ? sessionId : null;
    if (!sessionKey) return false;
    const state = sessionState.get(sessionKey);
    try {
        await gw.abortTurn({ sessionKey, runId: state?.runId });
        return true;
    } catch (error) {
        console.warn('[pilotdeck-bridge] abortTurn failed:', error);
        return false;
    }
}

export async function decidePermissionViaGateway(requestId, decision, options = {}) {
    const gw = await ensureGateway();
    // PermissionBus is keyed by sessionKey + requestId. We don't know
    // which session owns the request, so try each known session.
    for (const state of sessionState.values()) {
        try {
            const result = await gw.permissionDecide({
                sessionKey: state.sessionKey,
                requestId,
                decision: decision === 'allow' || decision === true ? 'allow' : 'deny',
                remember: options.remember,
                reason: options.reason,
            });
            if (result?.delivered) return true;
        } catch (error) {
            console.warn('[pilotdeck-bridge] permissionDecide failed:', error);
        }
    }
    return false;
}

export async function grantSessionPermissionViaGateway(sessionId, entry) {
    const gw = await ensureGateway();
    if (!isPilotDeckSessionKey(sessionId) || typeof entry !== 'string' || !entry.trim()) {
        return false;
    }
    try {
        const result = await gw.grantSessionPermission({
            sessionKey: sessionId,
            entry,
        });
        return Boolean(result?.granted);
    } catch (error) {
        console.warn('[pilotdeck-bridge] grantSessionPermission failed:', error);
        return false;
    }
}

export function isSessionActiveViaGateway(sessionId) {
    if (!isPilotDeckSessionKey(sessionId)) return false;
    return Boolean(sessionState.get(sessionId)?.active);
}

export async function getActiveTurnSnapshotFramesViaGateway(sessionId, provider = 'pilotdeck') {
    if (!isPilotDeckSessionKey(sessionId)) return [];
    const gw = await ensureGateway();
    if (typeof gw.getActiveTurnSnapshot !== 'function') return [];
    const snapshot = await gw.getActiveTurnSnapshot({ sessionKey: sessionId });
    if (!snapshot?.active || !Array.isArray(snapshot.events)) return [];
    return snapshot.events.flatMap((event) => gatewayEventToFrames(event, sessionId, provider) || []);
}

export function getActiveSessionIdsViaGateway() {
    return [...sessionState.values()]
        .filter((state) => state.active)
        .map((state) => state.sessionKey);
}

/**
 * Read persisted router stats from `~/.pilotdeck/router/stats.json`.
 * Falls back to the legacy `~/.pilotdeck/router-stats.json` path.
 *
 * Both the gateway server and this bridge run in different processes;
 * we no longer have an in-memory accessor (`getLocalGatewayRouterStats`
 * was tied to the bridge owning the gateway). The gateway server's
 * `TokenStatsCollector` periodically flushes to disk — this function
 * is the bridge's read-only window into that file.
 *
 * @returns {Map<string, {aggregate: object, records: object[]}>}
 */
/**
 * Build a sessionId->projectPath lookup from the filesystem.
 * Scans project chat directories under ~/.pilotdeck/projects/ and maps
 * each session filename back to the actual project path (resolved via
 * the .cwd marker or well-known directory names).
 *
 * @returns {{ sessionIndex: Map<string,string>, dirToPath: Map<string,string> }}
 */
function _buildSessionProjectIndex() {
    const sessionIndex = new Map();
    const dirToPath = new Map();
    try {
        const projectsDir = path.join(GENERAL_HOME, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            // Resolve actual project path from .cwd marker (handles lossy encoding)
            const cwdFile = path.join(projectsDir, d.name, '.cwd');
            try {
                const realPath = fs.readFileSync(cwdFile, 'utf-8').trim();
                if (realPath) dirToPath.set(d.name, realPath);
            } catch { /* no .cwd — will use fallback below */ }

            const chatsDir = path.join(projectsDir, d.name, 'chats');
            let files;
            try { files = fs.readdirSync(chatsDir); } catch { continue; }
            for (const f of files) {
                if (!f.endsWith('.jsonl')) continue;
                const sessionId = f.slice(0, -6);
                sessionIndex.set(sessionId, d.name);
            }
        }
    } catch { /* projects dir may not exist yet */ }
    return { sessionIndex, dirToPath };
}

function loadPersistedStatsFromDisk() {
    const result = new Map();
    try {
        // Prefer new JSONL format, fall back to legacy JSON.
        const jsonlPath = path.join(GENERAL_HOME, 'router', 'stats.jsonl');
        const jsonPath = path.join(GENERAL_HOME, 'router', 'stats.json');
        const legacyPath = path.join(GENERAL_HOME, 'router-stats.json');

        let records;
        if (fs.existsSync(jsonlPath)) {
            records = _loadRecordsFromJsonl(jsonlPath);
        } else {
            records = _loadRecordsFromJson(jsonPath, legacyPath);
        }
        if (!records || records.length === 0) return result;

        // Build a filesystem-based sessionId→projectDirName index for
        // backward compatibility (records written before projectPath existed).
        const { sessionIndex: fsIndex, dirToPath } = _buildSessionProjectIndex();
        const generalProjectDirName = createProjectId(GENERAL_HOME);

        const resolveProjectPath = (dirName) => {
            if (dirName === generalProjectDirName) return GENERAL_HOME;
            const fromCwd = dirToPath.get(dirName);
            if (fromCwd) return fromCwd;
            const repoProjectDirName = createProjectId(REPO_ROOT);
            if (dirName === repoProjectDirName) return REPO_ROOT;
            return GENERAL_HOME;
        };

        const byProject = new Map();

        for (const rec of records) {
            let projectKey = rec.projectPath;
            if (!projectKey) {
                const sessionId = rec.sessionId;
                if (sessionId) {
                    const safeId = sanitizeSessionIdForPath(sessionId);
                    const dirName = fsIndex.get(safeId) || fsIndex.get(sessionId);
                    if (dirName) {
                        projectKey = resolveProjectPath(dirName);
                    }
                }
            }
            if (!projectKey) projectKey = GENERAL_HOME;

            if (!byProject.has(projectKey)) {
                byProject.set(projectKey, []);
            }
            byProject.get(projectKey).push(rec);
        }

        for (const [projectKey, projRecords] of byProject.entries()) {
            projRecords.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
            result.set(projectKey, {
                aggregate: {},
                records: projRecords.slice(-1000),
            });
        }
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            console.warn('[router-dashboard] failed to load router stats:', err?.message || err);
        }
    }
    return result;
}

function _loadRecordsFromJsonl(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const records = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
            const rec = JSON.parse(line);
            if (rec?.sessionId && rec?.startedAt) records.push(rec);
        } catch { /* skip malformed */ }
    }
    return records;
}

function _loadRecordsFromJson(jsonPath, legacyPath) {
    const statsPath = fs.existsSync(jsonPath) ? jsonPath : legacyPath;
    const raw = fs.readFileSync(statsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed?.sessions || typeof parsed.sessions !== 'object') return [];
    const records = [];
    for (const sess of Object.values(parsed.sessions)) {
        if (!sess || !Array.isArray(sess.requestLog)) continue;
        for (const rec of sess.requestLog) {
            if (rec?.sessionId && rec?.startedAt) records.push(rec);
        }
    }
    return records;
}

/**
 * Read the first user prompt from a session transcript file to use as
 * a human-readable title. Cached for the lifetime of the process.
 */
const _sessionTitleCache = new Map();
const DOCUMENT_SELECTION_PROMPT_MARKER = '[Document selections quoted by user:]';

function _stripDocumentSelectionPromptBlock(text) {
    if (typeof text !== 'string') return '';
    const markerIndex = text.indexOf(DOCUMENT_SELECTION_PROMPT_MARKER);
    return markerIndex >= 0 ? text.slice(0, markerIndex).trimEnd() : text;
}

function _formatPromptTitle(text) {
    const trimmed = _stripDocumentSelectionPromptBlock(text).trim();
    if (!trimmed) return null;
    return trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
}

function lookupSessionTitle(sessionId, projectKey) {
    if (_sessionTitleCache.has(sessionId)) return _sessionTitleCache.get(sessionId);
    const title = _readFirstPrompt(sessionId, projectKey);
    _sessionTitleCache.set(sessionId, title);
    return title;
}

function _readFirstPrompt(sessionId, projectKey) {
    const pilotHome = GENERAL_HOME;
    // Sessions are stored on disk under a sanitized filename (raw sessionId
    // may contain /, :, = which would split into nested dirs). We try
    // both the sanitized and raw form so this also resolves any legacy files
    // that pre-date the sanitize fix.
    const safeId = sanitizeSessionIdForPath(sessionId);
    const fileVariants = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    const candidates = [];
    if (projectKey) {
        for (const id of fileVariants) {
            candidates.push(path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${id}.jsonl`));
        }
    }
    // Also check the general workspace (sessions may live there)
    for (const id of fileVariants) {
        const generalChatPath = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats', `${id}.jsonl`);
        if (!candidates.includes(generalChatPath)) candidates.push(generalChatPath);
    }
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            for (const id of fileVariants) {
                const p = path.join(projectsDir, d.name, 'chats', `${id}.jsonl`);
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch { /* ignore */ }

    for (const filePath of candidates) {
        try {
            const fd = fs.openSync(filePath, 'r');
            try {
                const buf = Buffer.alloc(16384);
                const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
                const head = buf.toString('utf-8', 0, bytesRead);
                const firstLine = head.split('\n').find(l => l.includes('"type":"accepted_input"'));
                if (firstLine) {
                    const parsed = JSON.parse(firstLine);
                    const text = parsed.messages
                        ?.flatMap(m => m.content ?? [])
                        .find(b => b.type === 'text')?.text;
                    if (text?.trim()) {
                        const title = _formatPromptTitle(text);
                        if (title) return title;
                    }
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch { /* file not found or parse error — try next */ }
    }
    return null;
}

/**
 * Extract all user queries from a session's transcript JSONL file.
 * Returns up to `limit` trimmed strings (truncated at 120 chars).
 * Cache is invalidated when the transcript file changes (mtime check).
 */
const _userQueriesCache = new Map();

function extractUserQueries(sessionId, projectKey, limit = 20) {
    const cacheKey = `${sessionId}::${projectKey || ''}`;
    const cached = _userQueriesCache.get(cacheKey);
    if (cached) {
        const currentMtime = _getTranscriptMtime(sessionId, projectKey);
        if (currentMtime && currentMtime === cached.mtime) return cached.queries;
    }

    const queries = _readUserQueriesFromTranscript(sessionId, projectKey, limit);
    const mtime = _getTranscriptMtime(sessionId, projectKey);
    _userQueriesCache.set(cacheKey, { queries, mtime });
    return queries;
}

function _getTranscriptMtime(sessionId, projectKey) {
    const pilotHome = GENERAL_HOME;
    const safeId = sanitizeSessionIdForPath(sessionId);
    const fileVariants = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    const candidates = [];
    if (projectKey) {
        for (const id of fileVariants) {
            candidates.push(path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${id}.jsonl`));
        }
    }
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            for (const id of fileVariants) {
                const p = path.join(projectsDir, d.name, 'chats', `${id}.jsonl`);
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch { /* ignore */ }
    for (const filePath of candidates) {
        try {
            return fs.statSync(filePath).mtimeMs;
        } catch { /* next */ }
    }
    return null;
}

function _readUserQueriesFromTranscript(sessionId, projectKey, limit) {
    const pilotHome = GENERAL_HOME;
    const safeId = sanitizeSessionIdForPath(sessionId);
    const fileVariants = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    const candidates = [];
    if (projectKey) {
        for (const id of fileVariants) {
            candidates.push(path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${id}.jsonl`));
        }
    }
    for (const id of fileVariants) {
        const generalChatPath = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats', `${id}.jsonl`);
        if (!candidates.includes(generalChatPath)) candidates.push(generalChatPath);
    }
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            for (const id of fileVariants) {
                const p = path.join(projectsDir, d.name, 'chats', `${id}.jsonl`);
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch { /* ignore */ }

    for (const filePath of candidates) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const queries = [];
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type !== 'accepted_input') continue;
                    const text = entry.messages
                        ?.flatMap(m => m.content ?? [])
                        .find(b => b.type === 'text')?.text;
                    if (!text?.trim()) continue;
                    const trimmed = text.trim();
                    if (trimmed.length < 2) continue;
                    queries.push(trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed);
                    if (queries.length >= limit) break;
                } catch { /* skip malformed lines */ }
            }
            if (queries.length > 0) return queries;
        } catch { /* file not found — try next */ }
    }
    return [];
}

/**
 * Extract per-turn structure from a session transcript.
 * Returns an array of turn objects:
 *   { tools: string[][], modelCalls: number }
 *
 * - tools: one entry per assistant_message that has tool_call blocks
 *   e.g. [["glob"], ["read_file", "read_file"], ["edit_file"]]
 * - modelCalls: total assistant_messages in the turn (including the
 *   final text-only response)
 *
 * Continuation #N shows the tools from model call #N-1 that triggered it.
 */
const _toolSequenceCache = new Map();

function _extractToolSequence(sessionId, projectKey) {
    const cacheKey = `${sessionId}::${projectKey || ''}::tools`;
    const cached = _toolSequenceCache.get(cacheKey);
    if (cached) {
        const currentMtime = _getTranscriptMtime(sessionId, projectKey);
        if (currentMtime && currentMtime === cached.mtime) return cached.result;
    }

    const result = _readToolSequenceFromTranscript(sessionId, projectKey);
    const mtime = _getTranscriptMtime(sessionId, projectKey);
    _toolSequenceCache.set(cacheKey, { result, mtime });
    return result;
}

function _readToolSequenceFromTranscript(sessionId, projectKey) {
    const pilotHome = GENERAL_HOME;
    const safeId = sanitizeSessionIdForPath(sessionId);
    const fileVariants = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    const candidates = [];
    if (projectKey) {
        for (const id of fileVariants) {
            candidates.push(path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${id}.jsonl`));
        }
    }
    for (const id of fileVariants) {
        const generalChatPath = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats', `${id}.jsonl`);
        if (!candidates.includes(generalChatPath)) candidates.push(generalChatPath);
    }
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            for (const id of fileVariants) {
                const p = path.join(projectsDir, d.name, 'chats', `${id}.jsonl`);
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch { /* ignore */ }

    for (const filePath of candidates) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const turns = [];
            let currentTurn = null;

            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'accepted_input') {
                        currentTurn = { tools: [], modelCalls: 0 };
                        turns.push(currentTurn);
                    } else if (entry.type === 'assistant_message' && currentTurn) {
                        currentTurn.modelCalls++;
                        const content = entry.message?.content ?? [];
                        const toolNames = content
                            .filter(b => b.type === 'tool_call' || b.type === 'tool_use')
                            .map(b => b.name)
                            .filter(Boolean);
                        if (toolNames.length > 0) {
                            currentTurn.tools.push(toolNames);
                        }
                    }
                } catch { /* skip */ }
            }
            if (turns.length > 0) return turns;
        } catch { /* file not found */ }
    }
    return [];
}

/**
 * Assign user queries and tool names to requestLog entries.
 *
 * Primary method: group by `turnId` from router stats (each user turn
 * shares one turnId; all continuations within that turn have the same
 * turnId). The first request per turnId gets the user query; subsequent
 * requests become tool continuations with tool names from the transcript.
 *
 * Fallback: when turnId is absent (older stats without the field), uses
 * transcript model-call counts to partition entries.
 */
/**
 * Extract subagent prompts from a session transcript.
 * Returns a Map<turnId, promptPreview[]> for assigning prompts to subagent entries.
 */
const _subagentPromptCache = new Map();

function _extractSubagentPrompts(sessionId, projectKey) {
    const cacheKey = `${sessionId}::${projectKey || ''}::subprompts`;
    const cached = _subagentPromptCache.get(cacheKey);
    if (cached) {
        const currentMtime = _getTranscriptMtime(sessionId, projectKey);
        if (currentMtime && currentMtime === cached.mtime) return cached.result;
    }
    const result = _readSubagentPromptsFromTranscript(sessionId, projectKey);
    const mtime = _getTranscriptMtime(sessionId, projectKey);
    _subagentPromptCache.set(cacheKey, { result, mtime });
    return result;
}

function _readSubagentPromptsFromTranscript(sessionId, projectKey) {
    const pilotHome = GENERAL_HOME;
    const safeId = sanitizeSessionIdForPath(sessionId);
    const fileVariants = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    const candidates = [];
    if (projectKey) {
        for (const id of fileVariants) {
            candidates.push(path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${id}.jsonl`));
        }
    }
    for (const id of fileVariants) {
        const generalChatPath = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats', `${id}.jsonl`);
        if (!candidates.includes(generalChatPath)) candidates.push(generalChatPath);
    }
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            for (const id of fileVariants) {
                const p = path.join(projectsDir, d.name, 'chats', `${id}.jsonl`);
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch { /* ignore */ }

    const promptsByTurn = new Map();
    for (const filePath of candidates) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'subagent_started' && entry.turnId && entry.promptPreview) {
                        const list = promptsByTurn.get(entry.turnId) || [];
                        const preview = entry.promptPreview.length > 80
                            ? entry.promptPreview.slice(0, 80) + '…'
                            : entry.promptPreview;
                        list.push(preview);
                        promptsByTurn.set(entry.turnId, list);
                    }
                } catch { /* skip */ }
            }
            if (promptsByTurn.size > 0) return promptsByTurn;
        } catch { /* file not found */ }
    }
    return promptsByTurn;
}

function _assignQueriesToRequestLog(sessionEntry) {
    const log = sessionEntry.routing?.requestLog;
    const queries = sessionEntry.userQueries;
    if (!log || log.length === 0 || !queries || queries.length === 0) return;

    const turnStructure = _extractToolSequence(sessionEntry.sessionId, sessionEntry._projectKey);
    const subagentPrompts = _extractSubagentPrompts(sessionEntry.sessionId, sessionEntry._projectKey);
    const hasTurnIds = log.some(e => e.turnId);

    if (hasTurnIds) {
        _assignByTurnId(log, queries, turnStructure, subagentPrompts);
    } else {
        const mainEntries = log.filter(e => e.role === 'main');
        if (mainEntries.length === 0) return;
        _assignByModelCallCount(mainEntries, queries, turnStructure);
    }
}

function _assignByTurnId(allEntries, queries, turnStructure, subagentPrompts) {
    let turnIndex = 0;
    let currentTurnId = null;

    for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        if (entry.turnId !== currentTurnId) {
            currentTurnId = entry.turnId;
            if (entry.role === 'main') {
                entry.query = queries[Math.min(turnIndex, queries.length - 1)];
            }
            turnIndex++;
        } else {
            if (entry.role === 'main') {
                entry._savedTier = entry.tier;
                entry.role = 'sub';
                delete entry.tier;
            }
        }
    }

    const turnIds = [...new Set(allEntries.map(e => e.turnId).filter(Boolean))];
    for (let tIdx = 0; tIdx < turnIds.length; tIdx++) {
        const turnId = turnIds[tIdx];
        const turnEntries = allEntries.filter(e => e.turnId === turnId);
        const turnTools = turnStructure[tIdx]?.tools || [];
        const prompts = subagentPrompts?.get(turnId);
        let toolIdx = 0;
        let promptIdx = 0;

        for (let j = 1; j < turnEntries.length; j++) {
            const entry = turnEntries[j];
            if (entry.query === 'sub-agent') {
                if (prompts && promptIdx < prompts.length) {
                    entry.query = prompts[promptIdx];
                    entry.isSubagentDispatch = true;
                    if (entry._savedTier) { entry.tier = entry._savedTier; }
                    delete entry._savedTier;
                    promptIdx++;
                }
            } else if (!entry.query) {
                if (toolIdx < turnTools.length) {
                    const names = turnTools[toolIdx];
                    const isAgentCall = names.some(n => n === 'agent' || n === 'sessions_spawn' || n === 'dispatch_agent');
                    if (isAgentCall && prompts && promptIdx < prompts.length) {
                        entry.query = prompts[promptIdx];
                        entry.isSubagentDispatch = true;
                        if (entry._savedTier) { entry.tier = entry._savedTier; }
                        delete entry._savedTier;
                        promptIdx++;
                    } else {
                        entry.query = '→ ' + [...new Set(names)].join(', ');
                    }
                }
                toolIdx++;
            }
            delete entry._savedTier;
        }
    }
}

function _assignByModelCallCount(mainEntries, queries, turnStructure) {
    let turnIndex = 0;
    let posInTurn = 0;

    for (let i = 0; i < mainEntries.length; i++) {
        const turnInfo = turnStructure[turnIndex];
        const turnModelCalls = turnInfo ? turnInfo.modelCalls : 0;

        if (posInTurn === 0) {
            mainEntries[i].query = queries[Math.min(turnIndex, queries.length - 1)];
            posInTurn++;
        } else {
            mainEntries[i].role = 'sub';
            delete mainEntries[i].tier;
            const continuationIdx = posInTurn - 1;
            const turnTools = turnInfo?.tools;
            if (turnTools && continuationIdx < turnTools.length) {
                const names = turnTools[continuationIdx];
                mainEntries[i].query = '→ ' + [...new Set(names)].join(', ');
            }
            posInTurn++;
        }

        if (turnModelCalls > 0 && posInTurn >= turnModelCalls) {
            turnIndex++;
            posInTurn = 0;
        }
    }
}

/**
 * Build a `DashboardData` payload from persisted router stats. Shape
 * mirrors what `ui/src/hooks/useRoutingDashboard.ts` expects so the V2
 * Dashboard tab renders without changing any frontend code.
 */
export function getRouterDashboardData() {
    const statsByProject = loadPersistedStatsFromDisk();

    const projects = [];
    const overall = makeBucket();
    const overallByTier = {};
    const overallByRole = {};
    let overallSessionCount = 0;

    for (const [projectKey, snapshot] of statsByProject.entries()) {
        const records = Array.isArray(snapshot.records) ? snapshot.records : [];
        const sessionMap = new Map();
        for (const record of records) {
            if (record.sessionId && record.sessionId.includes('::sub::')) continue;
            let sessionEntry = sessionMap.get(record.sessionId);
            if (!sessionEntry) {
                sessionEntry = {
                    sessionId: record.sessionId,
                    _projectKey: projectKey,
                    title: lookupSessionTitle(record.sessionId, projectKey) || record.sessionId,
                    provider: record.provider || 'pilotdeck',
                    lastActivity: record.endedAt,
                    userQueries: extractUserQueries(record.sessionId, projectKey),
                    routing: {
                        total: makeBucket(),
                        byTier: {},
                        byScenario: {},
                        byRole: {},
                        byModel: {},
                        requestLog: [],
                        firstSeenAt: Date.parse(record.startedAt) || 0,
                        lastActiveAt: Date.parse(record.endedAt) || 0,
                    },
                };
                sessionMap.set(record.sessionId, sessionEntry);
            }
            const logRole = record.role === 'subagent' ? 'sub' : 'main';
            sessionEntry.routing.requestLog.push({
                ts: Date.parse(record.startedAt) || 0,
                turnId: record.turnId || undefined,
                role: logRole,
                tier: record.tier || record.scenarioType || undefined,
                model: `${record.provider || 'unknown'}/${record.model || 'unknown'}`,
                ...(record.role === 'subagent' ? { query: 'sub-agent' } : {}),
                tokens: (record.usage?.totalTokens ?? (record.usage?.inputTokens || 0) + (record.usage?.outputTokens || 0)),
                cost: record.cost?.total || 0,
                baselineCost: record.baselineCost ?? (record.cost?.total || 0),
                savedCost: (record.baselineCost ?? (record.cost?.total || 0)) - (record.cost?.total || 0),
            });
            mergeRecordIntoSession(sessionEntry.routing, record);
            const ended = Date.parse(record.endedAt) || 0;
            if (ended > (sessionEntry.routing.lastActiveAt || 0)) {
                sessionEntry.routing.lastActiveAt = ended;
                sessionEntry.lastActivity = record.endedAt;
            }
        }

        for (const sessionEntry of sessionMap.values()) {
            _assignQueriesToRequestLog(sessionEntry);
            delete sessionEntry._projectKey;
        }

        const sessions = [...sessionMap.values()];
        const aggregated = {
            total: makeBucket(),
            byTier: {},
            byRole: {},
            sessionCount: sessions.length,
            routedSessionCount: sessions.length,
        };
        for (const session of sessions) {
            addBuckets(aggregated.total, session.routing.total);
            for (const [tier, bucket] of Object.entries(session.routing.byTier)) {
                aggregated.byTier[tier] = aggregated.byTier[tier] || makeBucket();
                addBuckets(aggregated.byTier[tier], bucket);
            }
            for (const [role, bucket] of Object.entries(session.routing.byRole)) {
                aggregated.byRole[role] = aggregated.byRole[role] || makeBucket();
                addBuckets(aggregated.byRole[role], bucket);
            }
        }

        addBuckets(overall, aggregated.total);
        for (const [tier, bucket] of Object.entries(aggregated.byTier)) {
            overallByTier[tier] = overallByTier[tier] || makeBucket();
            addBuckets(overallByTier[tier], bucket);
        }
        for (const [role, bucket] of Object.entries(aggregated.byRole)) {
            overallByRole[role] = overallByRole[role] || makeBucket();
            addBuckets(overallByRole[role], bucket);
        }
        overallSessionCount += sessions.length;

        projects.push({
            name: deriveProjectName(projectKey),
            displayName: deriveProjectDisplayName(projectKey),
            fullPath: projectKey,
            sessions,
            aggregated,
        });
    }

    return {
        projects,
        overall: {
            total: overall,
            byTier: overallByTier,
            byRole: overallByRole,
            projectCount: projects.length,
            sessionCount: overallSessionCount,
        },
        unmatchedSessions: [],
    };
}

function makeBucket() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        estimatedCost: 0,
        baselineCost: 0,
        savedCost: 0,
    };
}

function addBuckets(target, source) {
    target.inputTokens += source.inputTokens || 0;
    target.outputTokens += source.outputTokens || 0;
    target.cacheReadTokens += source.cacheReadTokens || 0;
    target.totalTokens += source.totalTokens || 0;
    target.requestCount += source.requestCount || 0;
    target.estimatedCost += source.estimatedCost || 0;
    if (typeof target.baselineCost !== 'number') target.baselineCost = 0;
    if (typeof target.savedCost !== 'number') target.savedCost = 0;
    target.baselineCost += source.baselineCost || 0;
    target.savedCost += source.savedCost || 0;
}

function mergeRecordIntoSession(routing, record) {
    const usage = record.usage || {};
    const cost = record.cost || {};
    const actualCost = cost.total || 0;
    const baseline = record.baselineCost ?? actualCost;
    const bucket = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        totalTokens:
            usage.totalTokens ??
            (usage.inputTokens || 0) + (usage.outputTokens || 0),
        requestCount: 1,
        estimatedCost: actualCost,
        baselineCost: baseline,
        savedCost: baseline - actualCost,
    };
    addBuckets(routing.total, bucket);

    const tierKey = record.tier || record.scenarioType || 'default';
    routing.byTier[tierKey] = routing.byTier[tierKey] || makeBucket();
    addBuckets(routing.byTier[tierKey], bucket);

    const scenarioKey = record.scenarioType || 'default';
    routing.byScenario[scenarioKey] = routing.byScenario[scenarioKey] || makeBucket();
    addBuckets(routing.byScenario[scenarioKey], bucket);

    const roleKey = record.resolvedFrom === 'subagent' ? 'sub' : 'main';
    routing.byRole[roleKey] = routing.byRole[roleKey] || makeBucket();
    addBuckets(routing.byRole[roleKey], bucket);

    const modelKey = `${record.provider || 'unknown'}/${record.model || 'unknown'}`;
    routing.byModel[modelKey] = routing.byModel[modelKey] || makeBucket();
    addBuckets(routing.byModel[modelKey], bucket);
}

function isGeneralProject(projectKey) {
    return path.resolve(projectKey) === path.resolve(GENERAL_HOME);
}

function deriveProjectName(projectKey) {
    if (isGeneralProject(projectKey)) return 'general';
    return projectKey
        .replace(/^\/+/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-');
}

function deriveProjectDisplayName(projectKey) {
    if (isGeneralProject(projectKey)) return 'general';
    const parts = projectKey.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : projectKey;
}

/**
 * Per-session stats payload for `/api/ccr/stats/sessions/:id`. Returns
 * `null` when no router activity has been observed for the session yet.
 */
export function getRouterSessionStats(sessionId) {
    const dashboard = getRouterDashboardData();
    for (const project of dashboard.projects) {
        const session = project.sessions.find((s) => s.sessionId === sessionId);
        if (session) {
            return {
                sessionId,
                projectName: project.name,
                routing: session.routing,
            };
        }
    }
    return null;
}

/**
 * Lifetime aggregate suitable for `/api/ccr/stats/summary`.
 */
export function getRouterStatsSummary() {
    const data = getRouterDashboardData();
    const byScenario = {};
    const byProvider = {};
    const byTier = data.overall.byTier;
    for (const project of data.projects) {
        for (const session of project.sessions) {
            for (const [scenario, bucket] of Object.entries(session.routing.byScenario)) {
                byScenario[scenario] = byScenario[scenario] || makeBucket();
                addBuckets(byScenario[scenario], bucket);
            }
            for (const [model, bucket] of Object.entries(session.routing.byModel)) {
                const provider = model.includes('/') ? model.split('/', 1)[0] : model;
                byProvider[provider] = byProvider[provider] || makeBucket();
                addBuckets(byProvider[provider], bucket);
            }
        }
    }
    return {
        lifetime: {
            total: data.overall.total,
            byScenario,
            byProvider,
            byTier,
        },
        lastUpdatedAt: new Date().toISOString(),
    };
}

/**
 * Register a notification handler that forwards Always-On turn events
 * to all connected browser WebSocket clients as NormalizedMessage frames.
 *
 * Called once from `index.js` after the WebSocket server is ready, passing
 * the shared `connectedClients` set.
 *
 * @param {Set<import('ws').WebSocket>} clients
 */
export function registerAlwaysOnNotificationForwarding(clients) {
    const knownSessions = new Set();

    ensureGateway().then((gw) => {
        gw.onNotification((name, payload) => {
            if (name !== 'always-on:turn-event') return;
            const { sessionKey, channelKey, event } = payload ?? {};
            if (!sessionKey || !event) return;

            const provider = 'pilotdeck';

            if (!knownSessions.has(sessionKey)) {
                knownSessions.add(sessionKey);
                const createdFrame = createNormalizedMessage({
                    provider,
                    sessionId: sessionKey,
                    kind: 'session_created',
                    newSessionId: sessionKey,
                    sessionKey,
                    channelKey,
                });
                const createdMsg = JSON.stringify(createdFrame);
                for (const client of clients) {
                    if (client.readyState === 1) client.send(createdMsg);
                }
            }

            if (event.type === 'context_budget') {
                const aoState = ensureSessionState(sessionKey, '', channelKey || 'web');
                aoState.tokenBudget = {
                    used: event.used,
                    total: event.total,
                    ratio: event.ratio,
                    state: event.state,
                };
            }
            for (const frame of gatewayEventToFrames(event, sessionKey, provider)) {
                const msg = JSON.stringify(frame);
                for (const client of clients) {
                    if (client.readyState === 1) client.send(msg);
                }
            }

            if (event.type === 'turn_completed') {
                knownSessions.delete(sessionKey);
            }
        });
    }).catch((err) => {
        console.warn('[pilotdeck-bridge] failed to register always-on notification forwarding:', err?.message || err);
    });
}

export async function elicitationRespondViaGateway(requestId, answer) {
    const gw = await ensureGateway();
    for (const state of sessionState.values()) {
        try {
            const result = await gw.respondElicitation({
                sessionKey: state.sessionKey,
                requestId,
                answer,
            });
            if (result?.delivered) return true;
        } catch (error) {
            console.warn('[pilotdeck-bridge] respondElicitation failed:', error);
        }
    }
    return false;
}
