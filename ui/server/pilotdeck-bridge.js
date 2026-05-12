/**
 * PilotDeck bridge — the only chat-execution entry point in `ui/server/`.
 *
 * The Web UI keeps speaking the legacy WebSocket protocol (`*-command`,
 * `abort-session`, `claude-permission-response`, NormalizedMessage event
 * frames). This module:
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

import { resolvePilotHome, createProjectId } from './utils/pilotPaths.js';
// Imported from TypeScript source — requires `node --import tsx` so the
// module is transformed at load time. Keeping the bridge off
// `dist/src/` is what lets `ui/server` survive `src/**` edits without
// `npm run build`; the gateway server (also tsx-launched) restarts and
// picks up the new code, while `ui/server` keeps running as a plain
// client.
import { createRemoteGateway } from '../../src/gateway/index.js';
import { createNormalizedMessage } from './pilotdeck-message.js';

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
const GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
const GATEWAY_CONNECT_RETRY_INTERVAL_MS = 250;

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

/** @type {Promise<import('../../src/gateway/index.js').Gateway> | null} */
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
    return typeof value === 'string' && /^web:s_/.test(value);
}

function newSessionKey() {
    return `web:s_${randomUUID()}`;
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
        };
        sessionState.set(sessionKey, state);
    } else {
        state.projectKey = projectKey;
        state.channelKey = channelKey;
    }
    return state;
}

function resolvePermissionMode(options) {
    const explicit = options?.permissionMode || options?.mode;
    if (explicit) return explicit;
    if (options?.toolsSettings?.skipPermissions === true) {
        return 'bypassPermissions';
    }
    return WEB_DEFAULT_PERMISSION_MODE;
}

/**
 * Map a `GatewayEvent` to one or more legacy `NormalizedMessage` frames.
 *
 * @param {object} event Gateway event payload.
 * @param {string} sessionId UI-facing session id.
 * @param {string} provider Provider hint (claude/cursor/codex/gemini/pilotdeck).
 * @returns {object[]} NormalizedMessage frames.
 */
function gatewayEventToFrames(event, sessionId, provider) {
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
        case 'tool_call_started':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_use',
                    toolId: event.toolCallId,
                    toolName: event.name,
                    toolInput: tryParseJson(event.argsPreview),
                }),
            ];
        case 'tool_call_finished':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_result',
                    toolId: event.toolCallId,
                    content: event.resultPreview ?? '',
                    isError: !event.ok,
                }),
            ];
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
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'interactive_prompt',
                    content:
                        event.questions
                            ?.map((q) => q.prompt)
                            .filter(Boolean)
                            .join('\n') ?? '',
                    requestId: event.requestId,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    questions: event.questions,
                    metadata: event.metadata,
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
        case 'error':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'error',
                    content: event.message,
                    code: event.code,
                    recoverable: event.recoverable,
                }),
            ];
        default:
            return [];
    }
}

function tryParseJson(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return value;
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
    const gw = await ensureGateway();
    const projectKey = options.projectPath || options.cwd || REPO_ROOT;
    const channelKey = 'web';

    const incoming = options.sessionId || options.sessionKey;
    const sessionKey = isPilotDeckSessionKey(incoming) ? incoming : newSessionKey();
    const isNewSession = sessionKey !== incoming;

    const state = ensureSessionState(sessionKey, projectKey, channelKey);

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

    try {
        const stream = gw.submitTurn({
            sessionKey,
            channelKey,
            projectKey,
            message: command ?? '',
            mode: resolvePermissionMode(options),
            runId,
        });
        for await (const event of stream) {
            if (event && event.type === 'error') {
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
            for (const frame of gatewayEventToFrames(event, sessionKey, provider)) {
                writer.send(frame);
            }
        }
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'complete',
                exitCode: 0,
                success: true,
            }),
        );
    } catch (error) {
        console.error(
            '[pilotdeck-bridge] runChatViaGateway threw:',
            error instanceof Error ? (error.stack || error.message) : error,
        );
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'error',
                content: error instanceof Error ? error.message : String(error),
            }),
        );
    } finally {
        state.active = false;
        state.runId = undefined;
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

export function isSessionActiveViaGateway(sessionId) {
    if (!isPilotDeckSessionKey(sessionId)) return false;
    return Boolean(sessionState.get(sessionId)?.active);
}

export function getActiveSessionIdsViaGateway() {
    return [...sessionState.values()]
        .filter((state) => state.active)
        .map((state) => state.sessionKey);
}

/**
 * Read persisted router stats from `~/.pilotdeck/router-stats.json`.
 *
 * Both the gateway server and this bridge run in different processes;
 * we no longer have an in-memory accessor (`getLocalGatewayRouterStats`
 * was tied to the bridge owning the gateway). The gateway server's
 * `TokenStatsCollector` periodically flushes to disk — this function
 * is the bridge's read-only window into that file.
 *
 * @returns {Map<string, {aggregate: object, records: object[]}>}
 */
function loadPersistedStatsFromDisk() {
    const result = new Map();
    try {
        const statsPath = path.join(GENERAL_HOME, 'router-stats.json');
        const raw = fs.readFileSync(statsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.sessions || typeof parsed.sessions !== 'object') {
            return result;
        }
        const allRecords = [];
        for (const sess of Object.values(parsed.sessions)) {
            if (sess && Array.isArray(sess.requestLog)) {
                allRecords.push(...sess.requestLog);
            }
        }
        allRecords.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
        if (allRecords.length > 0) {
            const snapshot = {
                aggregate: parsed.global || {},
                records: allRecords.slice(-1000),
            };
            // Key under GENERAL_HOME so the sidebar "general" project matches,
            // and also under REPO_ROOT for direct project matches.
            result.set(GENERAL_HOME, snapshot);
            if (REPO_ROOT !== GENERAL_HOME) {
                result.set(REPO_ROOT, snapshot);
            }
        }
    } catch {
        // File doesn't exist or is malformed — return empty map
    }
    return result;
}

/**
 * Read the first user prompt from a session transcript file to use as
 * a human-readable title. Cached for the lifetime of the process.
 */
const _sessionTitleCache = new Map();

function lookupSessionTitle(sessionId, projectKey) {
    if (_sessionTitleCache.has(sessionId)) return _sessionTitleCache.get(sessionId);
    const title = _readFirstPrompt(sessionId, projectKey);
    _sessionTitleCache.set(sessionId, title);
    return title;
}

function _readFirstPrompt(sessionId, projectKey) {
    const pilotHome = GENERAL_HOME;
    const candidates = projectKey
        ? [path.join(pilotHome, 'projects', createProjectId(projectKey), 'chats', `${sessionId}.jsonl`)]
        : [];
    const generalChatPath = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats', `${sessionId}.jsonl`);
    if (!candidates.includes(generalChatPath)) candidates.push(generalChatPath);
    try {
        const projectsDir = path.join(pilotHome, 'projects');
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const p = path.join(projectsDir, d.name, 'chats', `${sessionId}.jsonl`);
            if (!candidates.includes(p)) candidates.push(p);
        }
    } catch { /* ignore */ }

    for (const filePath of candidates) {
        try {
            const fd = fs.openSync(filePath, 'r');
            try {
                const buf = Buffer.alloc(4096);
                const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
                const head = buf.toString('utf-8', 0, bytesRead);
                const firstLine = head.split('\n').find(l => l.includes('"type":"accepted_input"'));
                if (firstLine) {
                    const parsed = JSON.parse(firstLine);
                    const text = parsed.messages
                        ?.flatMap(m => m.content ?? [])
                        .find(b => b.type === 'text')?.text;
                    if (text?.trim()) {
                        const trimmed = text.trim();
                        return trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
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
            let sessionEntry = sessionMap.get(record.sessionId);
            if (!sessionEntry) {
                sessionEntry = {
                    sessionId: record.sessionId,
                    title: lookupSessionTitle(record.sessionId, projectKey) || record.sessionId,
                    provider: record.provider || 'pilotdeck',
                    lastActivity: record.endedAt,
                    routing: {
                        total: makeBucket(),
                        byTier: {},
                        byScenario: {},
                        byRole: {},
                        byModel: {},
                        firstSeenAt: Date.parse(record.startedAt) || 0,
                        lastActiveAt: Date.parse(record.endedAt) || 0,
                    },
                };
                sessionMap.set(record.sessionId, sessionEntry);
            }
            mergeRecordIntoSession(sessionEntry.routing, record);
            const ended = Date.parse(record.endedAt) || 0;
            if (ended > (sessionEntry.routing.lastActiveAt || 0)) {
                sessionEntry.routing.lastActiveAt = ended;
                sessionEntry.lastActivity = record.endedAt;
            }
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
    };
}

function addBuckets(target, source) {
    target.inputTokens += source.inputTokens || 0;
    target.outputTokens += source.outputTokens || 0;
    target.cacheReadTokens += source.cacheReadTokens || 0;
    target.totalTokens += source.totalTokens || 0;
    target.requestCount += source.requestCount || 0;
    target.estimatedCost += source.estimatedCost || 0;
}

function mergeRecordIntoSession(routing, record) {
    const usage = record.usage || {};
    const cost = record.cost || {};
    const bucket = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        totalTokens:
            usage.totalTokens ??
            (usage.inputTokens || 0) + (usage.outputTokens || 0),
        requestCount: 1,
        estimatedCost: cost.total || 0,
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
