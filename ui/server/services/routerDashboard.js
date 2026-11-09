import path from 'node:path';
import { promises as defaultFs } from 'node:fs';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { createProjectId, sanitizeSessionIdForPath } from '../utils/pilotPaths.js';
import { isRealUserRequestMessage } from '../../../src/model/protocol/userRequest.js';

/** Read-only projections for the dashboard, summary and individual session APIs. */
export function createRouterDashboard({ pilotHome, repoRoot, fs = defaultFs, maxCacheEntries = 128, maxCacheBytes = 8 * 1024 * 1024 }) {
    const GENERAL_HOME = pilotHome;
    const files = createProjectionCache(fs, maxCacheEntries, maxCacheBytes);

    function requestContext() {
        let directories, sessionIndex;
        const primaryDirectories = new Map();
        return {
            primary: projectKey => {
                if (!primaryDirectories.has(projectKey)) primaryDirectories.set(projectKey, (async () => {
                    const directory = path.join(pilotHome, 'projects', createProjectId(projectKey));
                    const cwd = (await missingAsEmpty(() => fs.readFile(path.join(directory, '.cwd'), 'utf8'), '')).trim();
                    return !cwd || path.resolve(cwd) === path.resolve(projectKey) ? directory : undefined;
                })());
                return primaryDirectories.get(projectKey);
            },
            directories: () => directories ??= (async () => {
                const root = path.join(pilotHome, 'projects');
                const entries = await missingAsEmpty(() => fs.readdir(root, { withFileTypes: true }), []);
                const result = [];
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const directory = path.join(root, entry.name);
                    const cwd = await missingAsEmpty(() => fs.readFile(path.join(directory, '.cwd'), 'utf8'), '');
                    result.push({ name: entry.name, directory, cwd: cwd.trim() });
                }
                return result;
            })(),
            sessions: async function () {
                return sessionIndex ??= (async () => {
                    const result = new Map();
                    for (const project of await this.directories()) {
                        const names = await missingAsEmpty(() => fs.readdir(path.join(project.directory, 'chats')), []);
                        const projectPath = project.cwd || (project.name === createProjectId(repoRoot) ? repoRoot : pilotHome);
                        for (const name of names) if (name.endsWith('.jsonl')) result.set(name.slice(0, -6), projectPath);
                    }
                    return result;
                })();
            },
        };
    }

    async function loadStats(context) {
        let records = await files.read(path.join(pilotHome, 'router', 'stats.jsonl'), parseStatsLines);
        if (records === undefined) {
            const parseLegacy = raw => {
                try {
                    const data = JSON.parse(raw);
                    return Object.values(data?.sessions ?? {}).flatMap(session => Array.isArray(session?.requestLog) ? session.requestLog : [])
                        .filter(record => record?.sessionId && record?.startedAt);
                } catch { return []; }
            };
            records = await files.read(path.join(pilotHome, 'router', 'stats.json'), parseLegacy)
                ?? await files.read(path.join(pilotHome, 'router-stats.json'), parseLegacy)
                ?? [];
        }
        const byProject = new Map();
        for (const record of records) {
            let projectKey = record.projectPath;
            if (!projectKey) {
                const index = await context.sessions();
                projectKey = index.get(sanitizeSessionIdForPath(record.sessionId)) || index.get(record.sessionId) || pilotHome;
            }
            if (!byProject.has(projectKey)) byProject.set(projectKey, []);
            byProject.get(projectKey).push(record);
        }
        return new Map([...byProject].map(([key, values]) => [key, {
            records: values.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')).slice(-1000),
        }]));
    }

    async function readTranscript(sessionId, projectKey, context) {
        const safeId = sanitizeSessionIdForPath(sessionId);
        const readDirectory = async directory => {
            const chats = path.join(directory, 'chats');
            for (const id of new Set([safeId, sessionId])) {
                const file = path.resolve(chats, `${id}.jsonl`);
                const relative = path.relative(chats, file);
                if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || file.includes('\0')) continue;
                const projection = await files.read(file, parseTranscript);
                if (projection !== undefined) return projection;
            }
        };
        // Known project paths take the direct route. Historical discovery is
        // needed only for missing files or collision-resistant storage IDs.
        const primary = await context.primary(projectKey);
        if (primary) {
            const found = await readDirectory(primary);
            if (found !== undefined) return found;
        }
        const directories = await context.directories();
        const exact = directories.filter(project => project.cwd && path.resolve(project.cwd) === path.resolve(projectKey));
        const candidates = [...exact.map(project => project.directory),
            path.join(pilotHome, 'projects', createProjectId(pilotHome)),
            ...directories.filter(project => !project.cwd).map(project => project.directory)];
        for (const directory of new Set(candidates)) {
            if (directory === primary) continue;
            const found = await readDirectory(directory);
            if (found !== undefined) return found;
        }
        return { title: null, turns: [] };
    }

    async function getRouterDashboardData() {
        const context = requestContext();
        return buildDashboard(await loadStats(context), context);
    }

    async function getRouterSessionStats(sessionId) {
        const context = requestContext();
        const dashboard = await buildDashboard(await loadStats(context), context, true, sessionId);
        for (const project of dashboard.projects) {
            const session = project.sessions.find(session => session.sessionId === sessionId);
            if (session) return { sessionId, projectName: project.name, routing: session.routing };
        }
        return null;
    }

    async function getRouterStatsSummary() {
        const context = requestContext();
        const data = await buildDashboard(await loadStats(context), context, false);
        const byScenario = {}, byProvider = {};
        for (const project of data.projects) for (const session of project.sessions) {
            for (const [scenario, bucket] of Object.entries(session.routing.byScenario)) {
                byScenario[scenario] ??= makeBucket(); addBuckets(byScenario[scenario], bucket);
            }
            for (const [model, bucket] of Object.entries(session.routing.byModel)) {
                const provider = model.includes('/') ? model.split('/', 1)[0] : model;
                byProvider[provider] ??= makeBucket(); addBuckets(byProvider[provider], bucket);
            }
        }
        return { lifetime: { total: data.overall.total, byScenario, byProvider, byTier: data.overall.byTier }, lastUpdatedAt: new Date().toISOString() };
    }

    async function buildDashboard(statsByProject, context, enrich = true, onlySessionId) {
        const projects = [];
        const overall = makeBucket();
        const overallByTier = {};
        const overallByRole = {};
        let overallSessionCount = 0;

        for (const [projectKey, snapshot] of statsByProject.entries()) {
            const records = Array.isArray(snapshot.records) ? snapshot.records : [];
            const sessionMap = new Map();
            for (const record of records) {
                if (onlySessionId && record.sessionId !== onlySessionId) continue;
                if (record.sessionId && record.sessionId.includes('::sub::')) continue;
                let sessionEntry = sessionMap.get(record.sessionId);
                if (!sessionEntry) {
                    sessionEntry = {
                        sessionId: record.sessionId,
                        title: record.sessionId,
                        provider: record.provider || 'pilotdeck',
                        lastActivity: record.endedAt,
                        userQueries: [],
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

            if (enrich) for (const sessionEntry of sessionMap.values()) {
                const projection = await readTranscript(sessionEntry.sessionId, projectKey, context);
                sessionEntry.title = projection.title || sessionEntry.sessionId;
                sessionEntry.userQueries = projection.turns.map(turn => turn.query).filter(Boolean).slice(0, 20);
                assignRequestQueries(sessionEntry.routing.requestLog, projection.turns);
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
    return { getRouterDashboardData, getRouterSessionStats, getRouterStatsSummary };
}

async function missingAsEmpty(read, empty) {
    try { return await read(); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return empty; throw error; }
}

/** File identity includes replacement and truncation, not only mtime. */
function fingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }

function createProjectionCache(fs, maxEntries, maxBytes) {
    const entries = new Map(), pending = new Map();
    let bytes = 0;
    const remove = key => { const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key); };
    return {
        async read(file, parse) {
            const stat = await missingAsEmpty(() => fs.stat(file), undefined);
            if (!stat?.isFile()) { remove(file); return undefined; }
            const version = fingerprint(stat);
            const cached = entries.get(file);
            if (cached?.version === version) { entries.delete(file); entries.set(file, cached); return cached.value; }
            const key = `${file}\0${version}`;
            if (pending.has(key)) return pending.get(key);
            const reading = (async () => {
                const raw = await missingAsEmpty(() => fs.readFile(file, 'utf8'), undefined);
                if (raw === undefined) { remove(file); return undefined; }
                const value = await parse(raw);
                const latest = await missingAsEmpty(() => fs.stat(file), undefined);
                // A concurrent append/replacement is visible on the next read;
                // never publish this projection under a newer file version.
                if (latest && fingerprint(latest) === version) {
                    remove(file);
                    const size = Buffer.byteLength(JSON.stringify(value));
                    if (maxEntries > 0 && size <= maxBytes) {
                        entries.set(file, { version, value, bytes: size }); bytes += size;
                        while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
                    }
                }
                return value;
            })();
            pending.set(key, reading);
            try { return await reading; } finally { pending.delete(key); }
        },
    };
}

async function visitLines(raw, visit) {
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
        if (index > 0 && index % 256 === 0) await yieldToRequests();
        if (!lines[index].trim()) continue;
        try { visit(JSON.parse(lines[index])); } catch { /* Incomplete writes and legacy malformed lines are ignored. */ }
    }
}

async function parseStatsLines(raw) {
    const records = [];
    await visitLines(raw, record => { if (record?.sessionId && record?.startedAt) records.push(record); });
    return records;
}

function preview(text, limit) { return text.length > limit ? `${text.slice(0, limit - 3)}…` : text; }

async function parseTranscript(raw) {
    const turns = [], byId = new Map();
    let current, title = null;
    await visitLines(raw, entry => {
        if (entry.type === 'accepted_input') {
            const text = (entry.messages ?? []).filter(message => isRealUserRequestMessage({ ...message, role: message.role ?? 'user', content: message.content ?? [] }))
                .flatMap(message => message.content ?? []).find(block => block.type === 'text')?.text?.trim();
            current = { id: entry.turnId, query: text ? preview(text, 120) : undefined, tools: [], prompts: [], modelCalls: 0 };
            turns.push(current); if (entry.turnId) byId.set(entry.turnId, current);
            if (!title && text) title = preview(text.split('[Document selections quoted by user:]')[0].trimEnd(), 80);
        } else if (entry.type === 'assistant_message') {
            const turn = (entry.turnId && byId.get(entry.turnId)) || current;
            if (!turn) return;
            turn.modelCalls++;
            const tools = (entry.message?.content ?? []).filter(block => block.type === 'tool_call' || block.type === 'tool_use').map(block => block.name).filter(Boolean);
            if (tools.length) turn.tools.push(tools);
        } else if (entry.type === 'subagent_started' && entry.promptPreview) {
            const turn = (entry.turnId && byId.get(entry.turnId)) || current;
            if (turn) turn.prompts.push(entry.promptPreview.length > 80 ? `${entry.promptPreview.slice(0, 80)}…` : entry.promptPreview);
        }
    });
    return { title, turns };
}

function assignRequestQueries(log, turns) {
    const byId = new Map(turns.filter(turn => turn.id).map(turn => [turn.id, turn]));
    const positions = new Map();
    let legacyTurn = 0, legacyCalls = 0;
    for (const entry of log) {
        const turn = entry.turnId ? byId.get(entry.turnId) : turns[legacyTurn];
        if (!turn) continue;
        let position = positions.get(turn);
        if (!position) { position = { main: 0, prompt: 0 }; positions.set(turn, position); }
        if (entry.role === 'sub') {
            if (turn.prompts[position.prompt]) { entry.query = turn.prompts[position.prompt++]; entry.isSubagentDispatch = true; }
            continue;
        }
        if (position.main === 0) {
            if (turn.query) entry.query = turn.query;
        } else {
            const tools = turn.tools[position.main - 1];
            entry.role = 'sub';
            if (tools?.some(name => ['agent', 'sessions_spawn', 'dispatch_agent'].includes(name)) && turn.prompts[position.prompt]) {
                entry.query = turn.prompts[position.prompt++]; entry.isSubagentDispatch = true;
            } else {
                delete entry.tier;
                if (tools?.length) entry.query = `→ ${[...new Set(tools)].join(', ')}`;
            }
        }
        position.main++;
        if (!entry.turnId && ++legacyCalls >= (turn.modelCalls || 1)) { legacyTurn++; legacyCalls = 0; }
    }
}
