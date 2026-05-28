import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GENERAL_PROJECT_META_DIR } from "./general-projects.js";
import { hashText, nowIso } from "./utils/id.js";
const MANIFEST_FILE = "MEMORY.md";
const PROJECT_META_FILE = "project.meta.md";
const GLOBAL_DIR = "global";
const USER_DIR = "UserIdentity";
const USER_NOTES_DIR = "UserIdentityNotes";
const PROJECT_DIR = "Project";
const FEEDBACK_DIR = "Feedback";
const DEFAULT_USER_PROFILE_RELATIVE_PATH = join(GLOBAL_DIR, USER_DIR, "user-profile.md");
const DEFAULT_PROJECT_NAME = "Current Project";
const DEFAULT_PROJECT_STATUS = "in_progress";
export const TMP_PROJECT_ID = "_tmp";
export const CURRENT_PROJECT_ID = "current_project";
function ensureDir(path) {
    mkdirSync(path, { recursive: true });
}
function normalizeWhitespace(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
function normalizeDescription(value, fallback = "") {
    return normalizeWhitespace(value) || normalizeWhitespace(fallback);
}
function slugify(value) {
    const normalized = normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "memory-item";
}
function uniqueStrings(values, max = 50) {
    const seen = new Set();
    const next = [];
    for (const value of values) {
        const normalized = normalizeWhitespace(value);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        next.push(normalized);
        if (next.length >= max)
            break;
    }
    return next;
}
function splitLines(value) {
    return value.replace(/\r\n/g, "\n").split("\n");
}
function trimContentLines(content, maxLines) {
    if (maxLines <= 0)
        return "";
    const lines = splitLines(content);
    if (lines.length <= maxLines)
        return content;
    return `${lines.slice(0, maxLines).join("\n")}\n...`;
}
function previewContent(content, maxChars = 220) {
    const normalized = normalizeWhitespace(content.replace(/^#+\s+/gm, ""));
    if (normalized.length <= maxChars)
        return normalized;
    return `${normalized.slice(0, maxChars)}...`;
}
function parseBoolean(value) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
function parseInteger(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseStringArray(value) {
    const raw = normalizeWhitespace(value);
    if (!raw)
        return [];
    if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return uniqueStrings(parsed.filter((item) => typeof item === "string"));
            }
        }
        catch {
            // Fall through.
        }
    }
    return uniqueStrings(raw.split("|"));
}
function parseFrontmatterBlock(raw) {
    if (!raw.startsWith("---\n"))
        return undefined;
    const endIndex = raw.indexOf("\n---\n", 4);
    if (endIndex === -1)
        return undefined;
    const header = raw.slice(4, endIndex);
    const body = raw.slice(endIndex + 5).replace(/^\n+/, "");
    const values = new Map();
    for (const line of splitLines(header)) {
        const separator = line.indexOf(":");
        if (separator <= 0)
            continue;
        values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const type = values.get("type");
    const scope = values.get("scope");
    if ((type !== "user" && type !== "project" && type !== "feedback" && type !== "general_project_meta")
        || (scope !== "global" && scope !== "project")) {
        return undefined;
    }
    return {
        frontmatter: {
            name: values.get("name") ?? "",
            description: values.get("description") ?? "",
            type,
            scope,
            ...(values.get("project_id") ? { projectId: values.get("project_id") } : {}),
            ...(values.get("source_kind") ? { sourceKind: values.get("source_kind") } : {}),
            ...(values.get("source_workspace_path") ? { sourceWorkspacePath: values.get("source_workspace_path") } : {}),
            ...(values.get("source_project_id") ? { sourceProjectId: values.get("source_project_id") } : {}),
            updatedAt: values.get("updated_at") ?? nowIso(),
            ...(values.get("dream_updated_at") ? { dreamUpdatedAt: values.get("dream_updated_at") } : {}),
            ...(values.get("captured_at") ? { capturedAt: values.get("captured_at") } : {}),
            ...(values.get("source_session_key") ? { sourceSessionKey: values.get("source_session_key") } : {}),
            ...(parseBoolean(values.get("deprecated")) !== undefined
                ? { deprecated: parseBoolean(values.get("deprecated")) }
                : {}),
            ...(parseInteger(values.get("dream_attempts")) !== undefined
                ? { dreamAttempts: parseInteger(values.get("dream_attempts")) }
                : {}),
        },
        body,
    };
}
function renderFrontmatter(frontmatter) {
    const lines = [
        "---",
        `name: ${normalizeWhitespace(frontmatter.name)}`,
        `description: ${normalizeDescription(frontmatter.description, frontmatter.name)}`,
        `type: ${frontmatter.type}`,
        `scope: ${frontmatter.scope}`,
        ...(frontmatter.projectId ? [`project_id: ${frontmatter.projectId}`] : []),
        ...(frontmatter.sourceKind ? [`source_kind: ${frontmatter.sourceKind}`] : []),
        ...(frontmatter.sourceWorkspacePath ? [`source_workspace_path: ${frontmatter.sourceWorkspacePath}`] : []),
        ...(frontmatter.sourceProjectId ? [`source_project_id: ${frontmatter.sourceProjectId}`] : []),
        `updated_at: ${frontmatter.updatedAt}`,
        ...(frontmatter.dreamUpdatedAt ? [`dream_updated_at: ${frontmatter.dreamUpdatedAt}`] : []),
        ...(frontmatter.capturedAt ? [`captured_at: ${frontmatter.capturedAt}`] : []),
        ...(frontmatter.sourceSessionKey ? [`source_session_key: ${frontmatter.sourceSessionKey}`] : []),
        ...(typeof frontmatter.deprecated === "boolean" ? [`deprecated: ${frontmatter.deprecated ? "true" : "false"}`] : []),
        ...(typeof frontmatter.dreamAttempts === "number" ? [`dream_attempts: ${frontmatter.dreamAttempts}`] : []),
        "---",
        "",
    ];
    return `${lines.join("\n")}`;
}
function parseMarkdownSections(body) {
    const sections = new Map();
    let current = "";
    let bucket = [];
    for (const line of splitLines(body.trim())) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading) {
            if (current)
                sections.set(current, bucket);
            current = heading[1].trim().toLowerCase();
            bucket = [];
            continue;
        }
        if (!current)
            continue;
        bucket.push(line);
    }
    if (current)
        sections.set(current, bucket);
    return sections;
}
function parseListSection(lines) {
    if (!lines)
        return [];
    return uniqueStrings(lines
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean));
}
function parseParagraphSection(lines) {
    if (!lines)
        return "";
    return normalizeWhitespace(lines.join(" ").trim());
}
function splitFactText(text) {
    return uniqueStrings(text
        .replace(/\r/g, "\n")
        .split(/\n|[，,；;。.!?]/)
        .map((line) => normalizeWhitespace(line))
        .filter((line) => line.length >= 2));
}
function parseFactSection(lines) {
    if (!lines)
        return [];
    const facts = lines.flatMap((line) => {
        const stripped = line.replace(/^\s*-\s*/, "").trim();
        if (!stripped)
            return [];
        return /^\s*-\s*/.test(line) ? [stripped] : splitFactText(stripped);
    });
    return uniqueStrings(facts);
}
function buildUserBody(candidate) {
    const identityBackground = uniqueStrings([
        ...splitFactText(candidate.profile || candidate.summary || candidate.description || ""),
        ...(candidate.relationships ?? []).map((item) => normalizeWhitespace(item)),
    ]);
    const lines = [];
    if (identityBackground.length > 0) {
        lines.push("## 身份背景", ...identityBackground.map((item) => `- ${item}`), "");
    }
    if (lines.length === 0) {
        lines.push("## 身份背景", "- 暂无稳定用户画像信息。", "");
    }
    return `${lines.join("\n").trim()}\n`;
}
function buildProjectBody(candidate) {
    const lines = [];
    if (normalizeWhitespace(candidate.stage)) {
        lines.push("## Current Stage", normalizeWhitespace(candidate.stage), "");
    }
    const sections = [
        ["Decisions", candidate.decisions],
        ["Constraints", candidate.constraints],
        ["Next Steps", candidate.nextSteps],
        ["Blockers", candidate.blockers],
        ["Timeline", candidate.timeline],
        ["Notes", candidate.notes],
    ];
    for (const [title, values] of sections) {
        const normalized = uniqueStrings(values ?? []);
        if (normalized.length === 0)
            continue;
        lines.push(`## ${title}`, ...normalized.map((item) => `- ${item}`), "");
    }
    if (normalizeWhitespace(candidate.summary)) {
        lines.push("## Summary", normalizeWhitespace(candidate.summary), "");
    }
    return `${lines.join("\n").trim()}\n`;
}
function buildFeedbackBody(candidate) {
    const lines = [
        "## Rule",
        normalizeWhitespace(candidate.rule || candidate.description || candidate.summary || candidate.name),
        "",
    ];
    if (normalizeWhitespace(candidate.why))
        lines.push("## Why", normalizeWhitespace(candidate.why), "");
    if (normalizeWhitespace(candidate.howToApply)) {
        lines.push("## How To Apply", normalizeWhitespace(candidate.howToApply), "");
    }
    const notes = uniqueStrings(candidate.notes ?? []);
    if (notes.length > 0)
        lines.push("## Notes", ...notes.map((item) => `- ${item}`), "");
    return `${lines.join("\n").trim()}\n`;
}
function buildGeneralProjectMetaBody(input) {
    const lines = [
        "## Summary",
        normalizeDescription(input.description, input.projectName),
        "",
        "## Status",
        normalizeWhitespace(input.status) || DEFAULT_PROJECT_STATUS,
        "",
    ];
    const sourceNotes = uniqueStrings([
        input.sourceKind === "workspace_external_mirror" ? "This project mirrors a read-only external workspace project." : "",
        input.sourceWorkspacePath ? `Source workspace: ${input.sourceWorkspacePath}` : "",
        input.sourceProjectId ? `Source project id: ${input.sourceProjectId}` : "",
    ]);
    if (sourceNotes.length > 0) {
        lines.push("## Source", ...sourceNotes.map((item) => `- ${item}`), "");
    }
    return `${lines.join("\n").trim()}\n`;
}
function buildRecordBody(candidate) {
    if (normalizeWhitespace(candidate.body)) {
        return `${candidate.body.trim()}\n`;
    }
    if (candidate.type === "general_project_meta") {
        return buildGeneralProjectMetaBody({
            projectName: candidate.name,
            description: candidate.description,
            status: candidate.stage || DEFAULT_PROJECT_STATUS,
            ...(candidate.sourceKind
                ? { sourceKind: candidate.sourceKind }
                : {}),
            ...(candidate.sourceWorkspacePath
                ? { sourceWorkspacePath: candidate.sourceWorkspacePath }
                : {}),
            ...(candidate.sourceProjectId
                ? { sourceProjectId: candidate.sourceProjectId }
                : {}),
        });
    }
    if (candidate.type === "user")
        return buildUserBody(candidate);
    if (candidate.type === "feedback")
        return buildFeedbackBody(candidate);
    return buildProjectBody(candidate);
}
function candidateDescription(candidate) {
    if (candidate.type === "user") {
        return normalizeDescription(candidate.description, candidate.profile || candidate.summary || candidate.name);
    }
    if (candidate.type === "feedback") {
        return normalizeDescription(candidate.description, candidate.rule || candidate.summary || candidate.name);
    }
    return normalizeDescription(candidate.description, candidate.summary
        || candidate.stage
        || uniqueStrings(candidate.blockers ?? [])[0]
        || uniqueStrings(candidate.decisions ?? [])[0]
        || candidate.name);
}
function buildFrontmatter(candidate, existing) {
    const scope = candidate.type === "user" ? "global" : candidate.scope || "project";
    return {
        name: normalizeWhitespace(candidate.name) || normalizeWhitespace(existing?.name) || "memory-item",
        description: candidateDescription(candidate) || normalizeWhitespace(existing?.description) || "memory-item",
        type: candidate.type,
        scope,
        ...(scope === "project" ? { projectId: normalizeWhitespace(candidate.projectId) || normalizeWhitespace(existing?.projectId) || CURRENT_PROJECT_ID } : {}),
        ...(candidate.type === "general_project_meta" && candidate.sourceKind
            ? { sourceKind: candidate.sourceKind }
            : existing?.sourceKind
                ? { sourceKind: existing.sourceKind }
                : {}),
        ...(candidate.type === "general_project_meta" && candidate.sourceWorkspacePath
            ? { sourceWorkspacePath: candidate.sourceWorkspacePath }
            : existing?.sourceWorkspacePath
                ? { sourceWorkspacePath: existing.sourceWorkspacePath }
                : {}),
        ...(candidate.type === "general_project_meta" && candidate.sourceProjectId
            ? { sourceProjectId: candidate.sourceProjectId }
            : existing?.sourceProjectId
                ? { sourceProjectId: existing.sourceProjectId }
                : {}),
        updatedAt: nowIso(),
        ...(existing?.dreamUpdatedAt ? { dreamUpdatedAt: existing.dreamUpdatedAt } : {}),
        ...(candidate.capturedAt || existing?.capturedAt ? { capturedAt: candidate.capturedAt || existing?.capturedAt } : {}),
        ...(candidate.sourceSessionKey || existing?.sourceSessionKey
            ? { sourceSessionKey: candidate.sourceSessionKey || existing?.sourceSessionKey }
            : {}),
        ...(typeof existing?.deprecated === "boolean" ? { deprecated: existing.deprecated } : {}),
        ...(typeof existing?.dreamAttempts === "number" ? { dreamAttempts: existing.dreamAttempts } : {}),
    };
}
function mergeCandidates(primary, incoming) {
    if (primary.type !== incoming.type)
        return primary;
    if (primary.type === "user") {
        return {
            ...primary,
            profile: normalizeWhitespace(incoming.profile || primary.profile || primary.description || incoming.description),
            preferences: uniqueStrings([...(primary.preferences ?? []), ...(incoming.preferences ?? [])]),
            constraints: uniqueStrings([...(primary.constraints ?? []), ...(incoming.constraints ?? [])]),
            relationships: uniqueStrings([...(primary.relationships ?? []), ...(incoming.relationships ?? [])]),
            description: normalizeDescription(incoming.description, primary.description),
        };
    }
    if (primary.type === "feedback") {
        return {
            ...primary,
            name: normalizeWhitespace(incoming.name || primary.name),
            description: normalizeDescription(incoming.description, primary.description),
            rule: normalizeWhitespace(incoming.rule || primary.rule || incoming.description || primary.description),
            why: normalizeWhitespace(incoming.why || primary.why),
            howToApply: normalizeWhitespace(incoming.howToApply || primary.howToApply),
            notes: uniqueStrings([...(primary.notes ?? []), ...(incoming.notes ?? [])]),
        };
    }
    if (primary.type === "general_project_meta") {
        return {
            ...primary,
            projectId: normalizeWhitespace(incoming.projectId || primary.projectId),
            name: normalizeWhitespace(incoming.name || primary.name),
            description: normalizeDescription(incoming.description, primary.description),
            stage: normalizeWhitespace(incoming.stage || primary.stage),
            ...(incoming.sourceKind
                ? { sourceKind: incoming.sourceKind }
                : primary.sourceKind
                    ? { sourceKind: primary.sourceKind }
                    : {}),
            ...(incoming.sourceWorkspacePath
                ? { sourceWorkspacePath: incoming.sourceWorkspacePath }
                : primary.sourceWorkspacePath
                    ? { sourceWorkspacePath: primary.sourceWorkspacePath }
                    : {}),
            ...(incoming.sourceProjectId
                ? { sourceProjectId: incoming.sourceProjectId }
                : primary.sourceProjectId
                    ? { sourceProjectId: primary.sourceProjectId }
                    : {}),
        };
    }
    return {
        ...primary,
        name: normalizeWhitespace(incoming.name || primary.name),
        description: normalizeDescription(incoming.description, primary.description),
        summary: normalizeWhitespace(incoming.summary || primary.summary),
        stage: normalizeWhitespace(incoming.stage || primary.stage),
        decisions: uniqueStrings([...(primary.decisions ?? []), ...(incoming.decisions ?? [])]),
        constraints: uniqueStrings([...(primary.constraints ?? []), ...(incoming.constraints ?? [])]),
        nextSteps: uniqueStrings([...(primary.nextSteps ?? []), ...(incoming.nextSteps ?? [])]),
        blockers: uniqueStrings([...(primary.blockers ?? []), ...(incoming.blockers ?? [])]),
        timeline: uniqueStrings([...(primary.timeline ?? []), ...(incoming.timeline ?? [])]),
        notes: uniqueStrings([...(primary.notes ?? []), ...(incoming.notes ?? [])]),
    };
}
function sameOrigin(record, candidate) {
    return Boolean(candidate.capturedAt
        && candidate.sourceSessionKey
        && record.capturedAt === candidate.capturedAt
        && record.sourceSessionKey === candidate.sourceSessionKey
        && record.type === candidate.type);
}
function sortEntries(entries) {
    return [...entries].sort((left, right) => {
        if (right.updatedAt !== left.updatedAt)
            return right.updatedAt.localeCompare(left.updatedAt);
        return left.relativePath.localeCompare(right.relativePath);
    });
}
function renderManifestSection(title, entries, linkResolver) {
    if (entries.length === 0)
        return [];
    return [
        `## ${title}`,
        ...entries.map((entry) => `- [${entry.name}](${linkResolver?.(entry) ?? entry.relativePath}) — ${entry.description}`),
        "",
    ];
}
function renderProjectMeta(record) {
    return [
        "---",
        `project_id: ${record.projectId}`,
        `project_name: ${record.projectName}`,
        `description: ${record.description}`,
        `status: ${record.status}`,
        `created_at: ${record.createdAt}`,
        `updated_at: ${record.updatedAt}`,
        ...(record.dreamUpdatedAt ? [`dream_updated_at: ${record.dreamUpdatedAt}`] : []),
        "---",
        "",
        "## Summary",
        record.description,
        "",
    ].join("\n");
}
function parseProjectMeta(absolutePath) {
    if (!existsSync(absolutePath))
        return undefined;
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = parseFrontmatterBlock(raw);
    const values = new Map();
    if (raw.startsWith("---\n")) {
        const endIndex = raw.indexOf("\n---\n", 4);
        if (endIndex !== -1) {
            for (const line of splitLines(raw.slice(4, endIndex))) {
                const separator = line.indexOf(":");
                if (separator <= 0)
                    continue;
                values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
            }
        }
    }
    const projectName = normalizeWhitespace(values.get("project_name"));
    if (!projectName)
        return undefined;
    const description = normalizeDescription(values.get("description"), projectName);
    return {
        projectId: CURRENT_PROJECT_ID,
        projectName,
        description,
        status: normalizeWhitespace(values.get("status")) || DEFAULT_PROJECT_STATUS,
        createdAt: values.get("created_at") ?? parsed?.frontmatter.updatedAt ?? nowIso(),
        updatedAt: values.get("updated_at") ?? parsed?.frontmatter.updatedAt ?? nowIso(),
        ...(values.get("dream_updated_at") ? { dreamUpdatedAt: values.get("dream_updated_at") } : {}),
        relativePath: PROJECT_META_FILE,
        absolutePath,
    };
}
function normalizeProjectStatus(value) {
    const normalized = normalizeWhitespace(value);
    return normalized || DEFAULT_PROJECT_STATUS;
}
export class FileMemoryStore {
    rootDir;
    workspaceMode;
    manageProjectMeta;
    manageProjectFiles;
    manageUserProfile;
    userProfileRelativePath;
    userNotesRelativeDir;
    appendOnlyUserEntries;
    enableManifest;
    manifestUserEntriesProvider;
    constructor(rootDir, options = {}) {
        this.rootDir = rootDir;
        this.workspaceMode = options.workspaceMode ?? "single";
        this.manageProjectMeta = options.manageProjectMeta ?? true;
        this.manageProjectFiles = options.manageProjectFiles ?? true;
        this.manageUserProfile = options.manageUserProfile ?? true;
        this.userProfileRelativePath = this.manageUserProfile
            ? (options.userProfileRelativePath === undefined
                ? DEFAULT_USER_PROFILE_RELATIVE_PATH
                : options.userProfileRelativePath)
            : null;
        this.userNotesRelativeDir = this.manageUserProfile
            ? (options.userNotesRelativeDir === undefined ? null : options.userNotesRelativeDir)
            : null;
        this.appendOnlyUserEntries = this.manageUserProfile
            ? Boolean(options.appendOnlyUserEntries)
            : false;
        this.enableManifest = options.enableManifest ?? true;
        this.manifestUserEntriesProvider = options.manifestUserEntriesProvider;
        this.ensureLayout();
    }
    getRootDir() {
        return this.rootDir;
    }
    getWorkspaceMode() {
        return this.workspaceMode;
    }
    isGeneralMode() {
        return this.workspaceMode === "general";
    }
    getUserProfileRelativePath() {
        return this.userProfileRelativePath;
    }
    projectMetaPath() {
        return this.resolveRelativePath(PROJECT_META_FILE);
    }
    requireUserProfileRelativePath() {
        if (!this.manageUserProfile || !this.userProfileRelativePath) {
            throw new Error("Global user profile storage is disabled for this store");
        }
        return this.userProfileRelativePath;
    }
    ensureLayout() {
        ensureDir(this.rootDir);
        if (this.manageUserProfile && this.userProfileRelativePath) {
            ensureDir(dirname(this.resolveRelativePath(this.userProfileRelativePath)));
        }
        if (this.manageUserProfile && this.userNotesRelativeDir) {
            ensureDir(this.resolveRelativePath(this.userNotesRelativeDir));
        }
        if (this.manageProjectFiles) {
            ensureDir(join(this.rootDir, PROJECT_DIR));
            ensureDir(join(this.rootDir, FEEDBACK_DIR));
        }
        if (this.manageProjectMeta && this.isGeneralMode()) {
            ensureDir(join(this.rootDir, GENERAL_PROJECT_META_DIR));
        }
    }
    resolveRelativePath(relativePath) {
        return resolve(this.rootDir, relativePath);
    }
    isPathWithinRoot(relativePath) {
        const absolutePath = this.resolveRelativePath(relativePath);
        const rel = relative(this.rootDir, absolutePath);
        return rel === relativePath || (!rel.startsWith("..") && !rel.includes(".."));
    }
    readMarkdownFile(relativePath) {
        if (!this.isPathWithinRoot(relativePath))
            return undefined;
        const absolutePath = this.resolveRelativePath(relativePath);
        if (!existsSync(absolutePath))
            return undefined;
        return parseFrontmatterBlock(readFileSync(absolutePath, "utf8"));
    }
    buildManifestEntry(relativePath) {
        const parsed = this.readMarkdownFile(relativePath);
        if (!parsed)
            return undefined;
        return {
            ...parsed.frontmatter,
            ...(parsed.frontmatter.scope === "project"
                ? {
                    projectId: normalizeWhitespace(parsed.frontmatter.projectId) || CURRENT_PROJECT_ID,
                }
                : {}),
            file: relativePath.split("/").pop() ?? relativePath,
            relativePath,
            absolutePath: this.resolveRelativePath(relativePath),
        };
    }
    writeRecord(input) {
        const absolutePath = this.resolveRelativePath(input.relativePath);
        ensureDir(dirname(absolutePath));
        const rendered = `${renderFrontmatter(input.frontmatter)}${input.body.trim()}\n`;
        writeFileSync(absolutePath, rendered, "utf8");
        this.repairManifests();
        return this.getMemoryRecordsByIds([input.relativePath], 5000)[0];
    }
    collectDirectoryRecords(relativeDir) {
        const directory = join(this.rootDir, relativeDir);
        if (!existsSync(directory))
            return [];
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .filter((entry) => entry.name !== MANIFEST_FILE && entry.name !== PROJECT_META_FILE)
            .map((entry) => this.buildManifestEntry(join(relativeDir, entry.name)))
            .filter((entry) => Boolean(entry));
    }
    collectAllEntries() {
        const entries = [];
        if (this.manageProjectMeta && this.isGeneralMode()) {
            entries.push(...this.collectDirectoryRecords(GENERAL_PROJECT_META_DIR));
        }
        if (this.manageProjectFiles) {
            entries.push(...this.collectDirectoryRecords(PROJECT_DIR));
            entries.push(...this.collectDirectoryRecords(FEEDBACK_DIR));
        }
        if (this.manageUserProfile && this.userProfileRelativePath) {
            const userEntry = this.buildManifestEntry(this.userProfileRelativePath);
            if (userEntry)
                entries.push(userEntry);
        }
        if (this.manageUserProfile && this.userNotesRelativeDir) {
            entries.push(...this.collectDirectoryRecords(this.userNotesRelativeDir));
        }
        return sortEntries(entries);
    }
    readProjectMetaFile() {
        if (!this.manageProjectMeta || this.isGeneralMode())
            return undefined;
        return parseProjectMeta(this.projectMetaPath());
    }
    buildProjectMetaSeed() {
        const entries = this.collectAllEntries().filter((entry) => entry.scope === "project" && !entry.deprecated);
        const firstProject = entries.find((entry) => entry.type === "project");
        const firstFeedback = entries.find((entry) => entry.type === "feedback");
        const first = firstProject ?? firstFeedback;
        if (!first) {
            return {
                projectName: DEFAULT_PROJECT_NAME,
                description: "Current project memory.",
                status: DEFAULT_PROJECT_STATUS,
            };
        }
        return {
            projectName: firstProject?.name || DEFAULT_PROJECT_NAME,
            description: firstProject?.description || first.description || DEFAULT_PROJECT_NAME,
            status: DEFAULT_PROJECT_STATUS,
        };
    }
    generalProjectMetaRelativePath(projectId, projectName) {
        const normalizedProjectId = normalizeWhitespace(projectId) || hashText(`${projectName}:${nowIso()}`).slice(0, 12);
        return join(GENERAL_PROJECT_META_DIR, `${slugify(projectName || normalizedProjectId)}-${normalizedProjectId.slice(0, 12)}.md`);
    }
    toGeneralProjectMetaRecord(record) {
        if (record.type !== "general_project_meta")
            return undefined;
        return {
            projectId: normalizeWhitespace(record.projectId) || CURRENT_PROJECT_ID,
            projectName: record.name,
            description: normalizeDescription(record.description, record.name),
            status: parseParagraphSection(parseMarkdownSections(record.content).get("status")) || DEFAULT_PROJECT_STATUS,
            ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
            ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
            ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
            createdAt: record.capturedAt || record.updatedAt,
            updatedAt: record.updatedAt,
            ...(record.dreamUpdatedAt ? { dreamUpdatedAt: record.dreamUpdatedAt } : {}),
            relativePath: record.relativePath,
            absolutePath: record.absolutePath,
        };
    }
    listGeneralProjectMetaEntries(includeDeprecated = false) {
        return this.collectAllEntries()
            .filter((entry) => entry.type === "general_project_meta")
            .filter((entry) => includeDeprecated || !entry.deprecated);
    }
    upsertGeneralProjectMeta(input) {
        if (!this.manageProjectMeta || !this.isGeneralMode()) {
            throw new Error("General project metadata is disabled for this store");
        }
        const normalizedProjectId = normalizeWhitespace(input.projectId) || hashText(`${normalizeWhitespace(input.projectName)}:${normalizeWhitespace(input.sourceWorkspacePath)}:${normalizeWhitespace(input.sourceProjectId)}:${nowIso()}`).slice(0, 16);
        const existing = this.listProjectMetas().find((meta) => meta.projectId === normalizedProjectId);
        const relativePath = existing?.relativePath ?? this.generalProjectMetaRelativePath(normalizedProjectId, input.projectName);
        const frontmatter = {
            name: normalizeWhitespace(input.projectName) || existing?.projectName || DEFAULT_PROJECT_NAME,
            description: normalizeDescription(input.description, existing?.description || input.projectName),
            type: "general_project_meta",
            scope: "project",
            projectId: normalizedProjectId,
            ...(input.sourceKind || existing?.sourceKind ? { sourceKind: input.sourceKind || existing?.sourceKind } : {}),
            ...(input.sourceWorkspacePath || existing?.sourceWorkspacePath
                ? { sourceWorkspacePath: input.sourceWorkspacePath || existing?.sourceWorkspacePath }
                : {}),
            ...(input.sourceProjectId || existing?.sourceProjectId
                ? { sourceProjectId: input.sourceProjectId || existing?.sourceProjectId }
                : {}),
            updatedAt: nowIso(),
            ...(existing?.createdAt ? { capturedAt: existing.createdAt } : {}),
            ...(normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt)
                ? { dreamUpdatedAt: normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt) }
                : {}),
        };
        const record = this.writeRecord({
            relativePath,
            frontmatter,
            body: buildGeneralProjectMetaBody({
                projectName: frontmatter.name,
                description: frontmatter.description,
                status: normalizeProjectStatus(input.status || existing?.status || DEFAULT_PROJECT_STATUS),
                ...(frontmatter.sourceKind ? { sourceKind: frontmatter.sourceKind } : {}),
                ...(frontmatter.sourceWorkspacePath ? { sourceWorkspacePath: frontmatter.sourceWorkspacePath } : {}),
                ...(frontmatter.sourceProjectId ? { sourceProjectId: frontmatter.sourceProjectId } : {}),
            }),
        });
        return this.toGeneralProjectMetaRecord(record);
    }
    upsertProjectMeta(input = {}) {
        if (!this.manageProjectMeta) {
            throw new Error("Project metadata is disabled for this store");
        }
        if (this.isGeneralMode()) {
            return this.upsertGeneralProjectMeta({
                projectId: input.projectId,
                projectName: normalizeWhitespace(input.projectName) || DEFAULT_PROJECT_NAME,
                description: input.description,
                status: input.status,
                ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
                ...(input.sourceWorkspacePath ? { sourceWorkspacePath: input.sourceWorkspacePath } : {}),
                ...(input.sourceProjectId ? { sourceProjectId: input.sourceProjectId } : {}),
                ...(input.dreamUpdatedAt ? { dreamUpdatedAt: input.dreamUpdatedAt } : {}),
            });
        }
        const existing = this.readProjectMetaFile();
        const seed = this.buildProjectMetaSeed();
        const projectName = normalizeWhitespace(input.projectName)
            || existing?.projectName
            || seed.projectName;
        const description = normalizeDescription(input.description, existing?.description || seed.description || projectName);
        const next = {
            projectId: CURRENT_PROJECT_ID,
            projectName,
            description,
            status: normalizeProjectStatus(input.status || existing?.status || seed.status),
            createdAt: existing?.createdAt ?? nowIso(),
            updatedAt: nowIso(),
            ...(normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt)
                ? { dreamUpdatedAt: normalizeWhitespace(input.dreamUpdatedAt || existing?.dreamUpdatedAt) }
                : {}),
            relativePath: PROJECT_META_FILE,
            absolutePath: this.projectMetaPath(),
        };
        writeFileSync(next.absolutePath, `${renderProjectMeta(next).trim()}\n`, "utf8");
        this.repairManifests();
        return next;
    }
    ensureProjectMeta(input = {}) {
        if (this.isGeneralMode()) {
            const normalizedProjectId = normalizeWhitespace(input.projectId);
            const existing = normalizedProjectId ? this.getProjectMeta(normalizedProjectId) : undefined;
            return existing ?? this.upsertProjectMeta(input);
        }
        return this.readProjectMetaFile() ?? this.upsertProjectMeta(input);
    }
    findExistingRecordForCandidate(candidate) {
        const allEntries = this.collectAllEntries();
        const sameSource = allEntries.find((entry) => sameOrigin(entry, candidate));
        if (sameSource)
            return sameSource;
        if (candidate.type === "user") {
            if (this.appendOnlyUserEntries)
                return undefined;
            return this.manageUserProfile && this.userProfileRelativePath
                ? allEntries.find((entry) => entry.relativePath === this.userProfileRelativePath)
                : undefined;
        }
        return undefined;
    }
    nextRecordRelativePath(candidate) {
        if (candidate.type === "user") {
            if (!this.appendOnlyUserEntries)
                return this.requireUserProfileRelativePath();
            const directory = this.userNotesRelativeDir ?? USER_NOTES_DIR;
            const seed = `${candidate.type}:${candidate.name}:${candidate.description}:${candidate.capturedAt ?? ""}:${candidate.sourceSessionKey ?? nowIso()}`;
            return join(directory, `${slugify(candidate.name)}-${hashText(seed).slice(0, 10)}.md`);
        }
        const directory = candidate.type === "feedback" ? FEEDBACK_DIR : PROJECT_DIR;
        const seed = `${candidate.type}:${candidate.projectId ?? ""}:${candidate.name}:${candidate.description}:${candidate.capturedAt ?? ""}:${candidate.sourceSessionKey ?? nowIso()}`;
        return join(directory, `${slugify(candidate.name)}-${hashText(seed).slice(0, 10)}.md`);
    }
    resolveManifestLinkPath(entry) {
        const rel = relative(this.rootDir, entry.absolutePath).replace(/\\/g, "/");
        if (!rel || rel.startsWith(".."))
            return rel || entry.relativePath;
        return entry.relativePath;
    }
    buildManifest() {
        const projectMeta = this.readProjectMetaFile();
        const generalProjectMetas = this.isGeneralMode() ? this.listProjectMetas() : [];
        const allEntries = this.collectAllEntries();
        const active = allEntries.filter((entry) => !entry.deprecated);
        const deprecated = allEntries.filter((entry) => entry.deprecated);
        const projectEntries = active.filter((entry) => entry.type === "project");
        const feedbackEntries = active.filter((entry) => entry.type === "feedback");
        const userEntries = this.manageUserProfile
            ? active.filter((entry) => entry.type === "user")
            : sortEntries((this.manifestUserEntriesProvider?.() ?? []).filter((entry) => !entry.deprecated));
        const lines = [
            "# EdgeClaw Memory",
            "",
            `Updated: ${nowIso()}`,
            "",
            ...(projectMeta
                ? [
                    "## Current Project Meta",
                    `- [${projectMeta.projectName}](${PROJECT_META_FILE}) — ${projectMeta.description}`,
                    "",
                ]
                : []),
            ...(generalProjectMetas.length > 0
                ? [
                    "## General Projects",
                    ...generalProjectMetas.map((meta) => `- [${meta.projectName}](${meta.relativePath}) — ${meta.description}`),
                    "",
                ]
                : []),
            ...renderManifestSection("Project Memory", projectEntries),
            ...renderManifestSection("Feedback Memory", feedbackEntries),
            ...renderManifestSection("User Memory", userEntries, (entry) => this.resolveManifestLinkPath(entry)),
            ...renderManifestSection("Deprecated", deprecated),
        ];
        return `${lines.join("\n").trim()}\n`;
    }
    repairManifests() {
        this.ensureLayout();
        if (!this.enableManifest) {
            return {
                changed: 0,
                summary: "Manifest management is disabled for this store.",
                memoryFileCount: this.collectAllEntries().length,
            };
        }
        const manifestPath = this.resolveRelativePath(MANIFEST_FILE);
        const nextContent = this.buildManifest();
        const previousContent = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
        if (previousContent !== nextContent) {
            writeFileSync(manifestPath, nextContent, "utf8");
            return {
                changed: 1,
                summary: "Rebuilt workspace memory manifest.",
                memoryFileCount: this.collectAllEntries().length,
            };
        }
        return {
            changed: 0,
            summary: "Workspace memory manifest already up to date.",
            memoryFileCount: this.collectAllEntries().length,
        };
    }
    listMemoryEntries(options = {}) {
        const normalizedProjectId = normalizeWhitespace(options.projectId);
        if (normalizedProjectId && !this.isGeneralMode() && normalizedProjectId !== CURRENT_PROJECT_ID)
            return [];
        const kinds = new Set(options.kinds ?? ["user", "feedback", "project"]);
        const normalizedQuery = normalizeWhitespace(options.query).toLowerCase();
        const filtered = this.collectAllEntries()
            .filter((entry) => kinds.has(entry.type))
            .filter((entry) => !options.scope || entry.scope === options.scope)
            .filter((entry) => {
            if (!normalizedProjectId)
                return true;
            if (entry.type === "general_project_meta")
                return entry.projectId === normalizedProjectId;
            if (entry.scope !== "project")
                return true;
            return (entry.projectId || CURRENT_PROJECT_ID) === normalizedProjectId;
        })
            .filter((entry) => options.includeDeprecated || !entry.deprecated)
            .filter((entry) => {
            if (!normalizedQuery)
                return true;
            const haystack = [entry.name, entry.description, entry.relativePath].join(" ").toLowerCase();
            return haystack.includes(normalizedQuery);
        });
        const offset = Math.max(0, options.offset ?? 0);
        const limit = Math.max(1, options.limit ?? (filtered.length || 1));
        return filtered.slice(offset, offset + limit);
    }
    countMemoryEntries(options = {}) {
        return this.listMemoryEntries(options).length;
    }
    getMemoryRecordsByIds(ids, maxLines = 80) {
        return ids
            .map((id) => {
            const entry = this.buildManifestEntry(id);
            const parsed = entry ? this.readMarkdownFile(entry.relativePath) : undefined;
            if (!entry || !parsed)
                return undefined;
            const content = trimContentLines(parsed.body.trim(), maxLines);
            return {
                ...entry,
                content,
                preview: previewContent(parsed.body),
            };
        })
            .filter((record) => Boolean(record));
    }
    getUserSummary() {
        if (!this.manageUserProfile || !this.userProfileRelativePath) {
            return {
                identityBackground: [],
                files: [],
            };
        }
        const record = this.getMemoryRecordsByIds([this.userProfileRelativePath], 5000)[0];
        if (!record) {
            return {
                identityBackground: [],
                files: [],
            };
        }
        const sections = parseMarkdownSections(record.content);
        return {
            identityBackground: uniqueStrings(parseFactSection(sections.get("身份背景"))),
            files: [record],
        };
    }
    upsertUserProfile(candidate) {
        const relativePath = this.requireUserProfileRelativePath();
        const existing = this.buildManifestEntry(relativePath);
        const frontmatter = buildFrontmatter({
            ...candidate,
            type: "user",
            scope: "global",
            name: normalizeWhitespace(candidate.name) || "user-profile",
            description: normalizeDescription(candidate.description, candidate.name || "User profile"),
        }, existing);
        return this.writeRecord({
            relativePath,
            frontmatter,
            body: buildRecordBody(candidate),
        });
    }
    upsertCandidate(candidate) {
        let resolvedCandidate = candidate;
        if (candidate.type !== "user" && this.manageProjectMeta) {
            if (this.isGeneralMode()) {
                const projectId = normalizeWhitespace(candidate.projectId)
                    || this.ensureProjectMeta({
                        projectName: candidate.type === "project" ? candidate.name : candidate.description || candidate.name,
                        description: candidate.description,
                    }).projectId;
                resolvedCandidate = {
                    ...candidate,
                    projectId,
                };
            }
            else {
                this.ensureProjectMeta({
                    ...(candidate.type === "project" ? { projectName: candidate.name } : {}),
                    description: candidate.description,
                });
            }
        }
        const existing = this.findExistingRecordForCandidate(resolvedCandidate);
        const frontmatter = buildFrontmatter(resolvedCandidate, existing);
        const relativePath = existing?.relativePath ?? this.nextRecordRelativePath(resolvedCandidate);
        const record = this.writeRecord({
            relativePath,
            frontmatter,
            body: buildRecordBody(resolvedCandidate),
        });
        if (resolvedCandidate.type === "project" && !this.isGeneralMode()) {
            const projectMeta = this.readProjectMetaFile();
            if (projectMeta) {
                const autoSeedLike = normalizeWhitespace(projectMeta.projectName).toLowerCase() === DEFAULT_PROJECT_NAME.toLowerCase()
                    || /workspace memory$/i.test(projectMeta.description)
                    || normalizeWhitespace(projectMeta.description).toLowerCase() === "current project memory.";
                this.upsertProjectMeta({
                    ...(autoSeedLike ? { projectName: resolvedCandidate.name } : {}),
                    ...(autoSeedLike && resolvedCandidate.description ? { description: resolvedCandidate.description } : {}),
                    status: projectMeta.status,
                });
            }
        }
        return record;
    }
    toCandidate(record) {
        const sections = parseMarkdownSections(record.content);
        if (record.type === "general_project_meta") {
            return {
                type: "general_project_meta",
                scope: "project",
                projectId: record.projectId,
                name: record.name,
                description: record.description,
                body: record.content,
                ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
                ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
                ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
                ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
                stage: parseParagraphSection(sections.get("status")),
            };
        }
        if (record.type === "user") {
            const identityFacts = parseFactSection(sections.get("身份背景"));
            return {
                type: "user",
                scope: "global",
                name: record.name,
                description: record.description,
                body: record.content,
                ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
                ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
                profile: identityFacts.join("；") || normalizeWhitespace(record.content),
                relationships: identityFacts,
            };
        }
        if (record.type === "feedback") {
            return {
                type: "feedback",
                scope: "project",
                ...(record.projectId ? { projectId: record.projectId } : {}),
                name: record.name,
                description: record.description,
                body: record.content,
                ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
                ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
                rule: parseParagraphSection(sections.get("rule")),
                why: parseParagraphSection(sections.get("why")),
                howToApply: parseParagraphSection(sections.get("how to apply")),
                notes: parseListSection(sections.get("notes")),
            };
        }
        return {
            type: "project",
            scope: "project",
            ...(record.projectId ? { projectId: record.projectId } : {}),
            name: record.name,
            description: record.description,
            body: record.content,
            ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
            ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
            stage: parseParagraphSection(sections.get("current stage")),
            decisions: parseListSection(sections.get("decisions")),
            constraints: parseListSection(sections.get("constraints")),
            nextSteps: parseListSection(sections.get("next steps")),
            blockers: parseListSection(sections.get("blockers")),
            timeline: parseListSection(sections.get("timeline")),
            notes: parseListSection(sections.get("notes")),
            summary: parseParagraphSection(sections.get("summary")),
        };
    }
    editEntry(input) {
        const existing = this.getMemoryRecordsByIds([input.relativePath], 5000)[0];
        if (!existing)
            throw new Error(`Memory entry not found: ${input.relativePath}`);
        const candidate = this.toCandidate(existing);
        const next = {
            ...candidate,
            name: normalizeWhitespace(input.name) || candidate.name,
            description: normalizeDescription(input.description, candidate.description),
        };
        if (input.fields) {
            delete next.body;
            if (typeof input.fields.stage === "string")
                next.stage = normalizeWhitespace(input.fields.stage);
            if (input.fields.decisions)
                next.decisions = uniqueStrings(input.fields.decisions);
            if (input.fields.constraints)
                next.constraints = uniqueStrings(input.fields.constraints);
            if (input.fields.nextSteps)
                next.nextSteps = uniqueStrings(input.fields.nextSteps);
            if (input.fields.blockers)
                next.blockers = uniqueStrings(input.fields.blockers);
            if (input.fields.timeline)
                next.timeline = uniqueStrings(input.fields.timeline);
            if (input.fields.notes)
                next.notes = uniqueStrings(input.fields.notes);
            if (typeof input.fields.rule === "string")
                next.rule = normalizeWhitespace(input.fields.rule);
            if (typeof input.fields.why === "string")
                next.why = normalizeWhitespace(input.fields.why);
            if (typeof input.fields.howToApply === "string")
                next.howToApply = normalizeWhitespace(input.fields.howToApply);
        }
        return this.writeRecord({
            relativePath: input.relativePath,
            frontmatter: {
                ...existing,
                ...(existing.scope === "project" && existing.projectId ? { projectId: existing.projectId } : {}),
                name: next.name,
                description: candidateDescription(next),
                updatedAt: nowIso(),
            },
            body: buildRecordBody(next),
        });
    }
    markEntriesDeprecated(relativePaths) {
        const mutatedIds = [];
        for (const relativePath of relativePaths) {
            const record = this.getMemoryRecordsByIds([relativePath], 5000)[0];
            if (!record)
                continue;
            this.writeRecord({
                relativePath,
                frontmatter: {
                    ...record,
                    ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
                    updatedAt: nowIso(),
                    deprecated: true,
                },
                body: record.content,
            });
            mutatedIds.push(relativePath);
        }
        return { mutatedIds, deletedProjectIds: [] };
    }
    restoreEntries(relativePaths) {
        const mutatedIds = [];
        for (const relativePath of relativePaths) {
            const record = this.getMemoryRecordsByIds([relativePath], 5000)[0];
            if (!record)
                continue;
            this.writeRecord({
                relativePath,
                frontmatter: {
                    ...record,
                    ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
                    updatedAt: nowIso(),
                    deprecated: false,
                },
                body: record.content,
            });
            mutatedIds.push(relativePath);
        }
        return { mutatedIds, deletedProjectIds: [] };
    }
    deleteEntries(relativePaths) {
        const mutatedIds = [];
        for (const relativePath of relativePaths) {
            if (!this.isPathWithinRoot(relativePath))
                continue;
            const absolutePath = this.resolveRelativePath(relativePath);
            if (!existsSync(absolutePath))
                continue;
            unlinkSync(absolutePath);
            mutatedIds.push(relativePath);
        }
        this.repairManifests();
        return { mutatedIds, deletedProjectIds: [] };
    }
    reassignProjectEntries(input) {
        const fromProjectId = normalizeWhitespace(input.fromProjectId);
        const toProjectId = normalizeWhitespace(input.toProjectId);
        if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) {
            return { mutatedIds: [] };
        }
        const entries = this.listMemoryEntries({
            kinds: ["project", "feedback"],
            scope: "project",
            projectId: fromProjectId,
            includeDeprecated: true,
            limit: 5000,
            offset: 0,
        });
        const mutatedIds = [];
        for (const entry of entries) {
            const record = this.getMemoryRecordsByIds([entry.relativePath], 5000)[0];
            if (!record)
                continue;
            this.writeRecord({
                relativePath: entry.relativePath,
                frontmatter: {
                    ...record,
                    projectId: toProjectId,
                    updatedAt: nowIso(),
                },
                body: record.content,
            });
            mutatedIds.push(entry.relativePath);
        }
        return { mutatedIds };
    }
    archiveTmpEntries(_) {
        throw new Error("archive_tmp is not supported in EdgeClaw current-project memory mode");
    }
    listProjectMetas(_options = {}) {
        if (!this.manageProjectMeta)
            return [];
        if (this.isGeneralMode()) {
            const ids = this.listGeneralProjectMetaEntries().map((entry) => entry.relativePath);
            return this.getMemoryRecordsByIds(ids, 5000)
                .map((record) => this.toGeneralProjectMetaRecord(record))
                .filter((record) => Boolean(record));
        }
        const meta = this.readProjectMetaFile();
        return meta ? [meta] : [];
    }
    listProjectIdentityHints(_options = {}) {
        if (!this.manageProjectMeta)
            return [];
        if (this.isGeneralMode()) {
            return this.listProjectMetas().map((projectMeta) => ({
                identityKey: projectMeta.projectId,
                projectId: projectMeta.projectId,
                projectName: projectMeta.projectName,
                description: projectMeta.description,
                updatedAt: projectMeta.updatedAt,
                scope: "formal",
            }));
        }
        const meta = this.readProjectMetaFile();
        if (!meta)
            return [];
        const projectMeta = meta;
        return [{
                identityKey: CURRENT_PROJECT_ID,
                projectId: CURRENT_PROJECT_ID,
                projectName: projectMeta.projectName,
                description: projectMeta.description,
                updatedAt: projectMeta.updatedAt,
                scope: "formal",
            }];
    }
    getProjectMeta(projectId = CURRENT_PROJECT_ID) {
        if (!this.manageProjectMeta)
            return undefined;
        const normalized = normalizeWhitespace(projectId);
        if (this.isGeneralMode()) {
            return this.listProjectMetas().find((meta) => meta.projectId === normalized);
        }
        if (normalized && normalized !== CURRENT_PROJECT_ID)
            return undefined;
        return this.readProjectMetaFile();
    }
    hasVisibleProjectMemory(projectId = CURRENT_PROJECT_ID) {
        if (!this.manageProjectFiles)
            return false;
        const normalized = normalizeWhitespace(projectId);
        if (normalized && !this.isGeneralMode() && normalized !== CURRENT_PROJECT_ID)
            return false;
        return this.collectAllEntries().some((entry) => (entry.scope === "project"
            && entry.type !== "general_project_meta"
            && !entry.deprecated
            && (!normalized || (entry.projectId || CURRENT_PROJECT_ID) === normalized)));
    }
    listTmpEntries(_limit = 500) {
        return [];
    }
    editProjectMeta(input) {
        if (!this.manageProjectMeta) {
            throw new Error("Project metadata is disabled for this store");
        }
        const normalizedProjectId = normalizeWhitespace(input.projectId);
        if (this.isGeneralMode()) {
            if (!normalizedProjectId) {
                throw new Error("projectId is required for General project metadata edits");
            }
            const existing = this.getProjectMeta(normalizedProjectId);
            if (!existing) {
                throw new Error(`Unknown projectId: ${input.projectId}`);
            }
            return this.upsertGeneralProjectMeta({
                projectId: normalizedProjectId,
                projectName: input.projectName,
                description: input.description,
                status: input.status,
                ...(existing.sourceKind ? { sourceKind: existing.sourceKind } : {}),
                ...(existing.sourceWorkspacePath ? { sourceWorkspacePath: existing.sourceWorkspacePath } : {}),
                ...(existing.sourceProjectId ? { sourceProjectId: existing.sourceProjectId } : {}),
                ...(existing.dreamUpdatedAt ? { dreamUpdatedAt: existing.dreamUpdatedAt } : {}),
            });
        }
        if (normalizedProjectId && normalizedProjectId !== CURRENT_PROJECT_ID) {
            throw new Error(`Unknown projectId: ${input.projectId}`);
        }
        return this.upsertProjectMeta({
            projectName: input.projectName,
            description: input.description,
            status: input.status,
        });
    }
    exportBundleRecords(_options = {}) {
        const projectMetas = this.listProjectMetas();
        return {
            memoryFiles: this.getMemoryRecordsByIds(this.collectAllEntries().map((entry) => entry.relativePath), 5000).map((record) => ({
                name: record.name,
                description: record.description,
                type: record.type,
                scope: record.scope,
                ...(record.scope === "project" && record.projectId ? { projectId: record.projectId } : {}),
                ...(record.sourceKind ? { sourceKind: record.sourceKind } : {}),
                ...(record.sourceWorkspacePath ? { sourceWorkspacePath: record.sourceWorkspacePath } : {}),
                ...(record.sourceProjectId ? { sourceProjectId: record.sourceProjectId } : {}),
                updatedAt: record.updatedAt,
                ...(record.dreamUpdatedAt ? { dreamUpdatedAt: record.dreamUpdatedAt } : {}),
                ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
                ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
                ...(typeof record.deprecated === "boolean" ? { deprecated: record.deprecated } : {}),
                ...(typeof record.dreamAttempts === "number" ? { dreamAttempts: record.dreamAttempts } : {}),
                file: record.file,
                relativePath: record.relativePath,
                content: record.content,
            })),
            projectMetas: projectMetas.map((projectMeta) => ({
                projectId: projectMeta.projectId,
                projectName: projectMeta.projectName,
                description: projectMeta.description,
                status: projectMeta.status,
                createdAt: projectMeta.createdAt,
                updatedAt: projectMeta.updatedAt,
                ...(projectMeta.dreamUpdatedAt ? { dreamUpdatedAt: projectMeta.dreamUpdatedAt } : {}),
                relativePath: projectMeta.relativePath,
            })),
        };
    }
    exportSnapshotFiles() {
        if (this.enableManifest) {
            this.repairManifests();
        }
        const files = [
            ...(this.enableManifest ? [MANIFEST_FILE] : []),
            ...(!this.isGeneralMode() && this.readProjectMetaFile() ? [PROJECT_META_FILE] : []),
            ...this.collectAllEntries().map((entry) => entry.relativePath),
        ];
        return files.map((relativePath) => ({
            relativePath,
            content: readFileSync(this.resolveRelativePath(relativePath), "utf8"),
        }));
    }
    clearAllData(options = {}) {
        rmSync(this.rootDir, { recursive: true, force: true });
        this.ensureLayout();
        if (options.rebuildManifest ?? true) {
            this.repairManifests();
        }
    }
    getOverview(lastDreamAt) {
        const entries = this.collectAllEntries();
        const activeEntries = entries.filter((entry) => !entry.deprecated);
        const generalProjectMetas = activeEntries.filter((entry) => entry.type === "general_project_meta");
        const changedFilesSinceLastDream = !lastDreamAt
            ? activeEntries.length
            : activeEntries.filter((entry) => entry.updatedAt > lastDreamAt).length;
        return {
            totalFiles: activeEntries.length,
            projectMemories: activeEntries.filter((entry) => entry.type === "project").length,
            feedbackMemories: activeEntries.filter((entry) => entry.type === "feedback").length,
            userProfiles: activeEntries.filter((entry) => entry.type === "user").length,
            changedFilesSinceLastDream,
            tmpTotalFiles: 0,
            tmpFeedbackMemories: 0,
            tmpProjectMemories: 0,
            projectMetaCount: this.isGeneralMode() ? generalProjectMetas.length : this.readProjectMetaFile() ? 1 : 0,
            ...(this.isGeneralMode() ? { generalProjectMetaCount: generalProjectMetas.length } : {}),
            ...(activeEntries[0]?.updatedAt ? { latestMemoryAt: activeEntries[0].updatedAt } : {}),
        };
    }
    getSnapshotVersion(lastDreamAt) {
        const payload = JSON.stringify({
            lastDreamAt: lastDreamAt ?? "",
            files: this.exportSnapshotFiles(),
        });
        return hashText(payload);
    }
    mergeDuplicateEntries(entries) {
        const groups = new Map();
        for (const entry of entries.filter((item) => !item.deprecated && item.type !== "user" && item.type !== "general_project_meta")) {
            const key = `${entry.type}:${slugify(entry.name)}`;
            const bucket = groups.get(key) ?? [];
            bucket.push(entry);
            groups.set(key, bucket);
        }
        let merged = 0;
        const changedFiles = [];
        const deletedFiles = [];
        for (const bucket of groups.values()) {
            if (bucket.length < 2)
                continue;
            const records = this.getMemoryRecordsByIds(bucket.map((entry) => entry.relativePath), 5000).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
            const primary = records[0];
            if (!primary)
                continue;
            let mergedCandidate = this.toCandidate(primary);
            for (const record of records.slice(1)) {
                mergedCandidate = mergeCandidates(mergedCandidate, this.toCandidate(record));
            }
            this.writeRecord({
                relativePath: primary.relativePath,
                frontmatter: {
                    ...primary,
                    ...(primary.scope === "project" && primary.projectId ? { projectId: primary.projectId } : {}),
                    updatedAt: nowIso(),
                    description: candidateDescription(mergedCandidate),
                    dreamAttempts: typeof primary.dreamAttempts === "number" ? primary.dreamAttempts + 1 : 1,
                },
                body: buildRecordBody(mergedCandidate),
            });
            changedFiles.push(primary.relativePath);
            for (const duplicate of records.slice(1)) {
                const absolutePath = this.resolveRelativePath(duplicate.relativePath);
                if (existsSync(absolutePath)) {
                    unlinkSync(absolutePath);
                    deletedFiles.push(duplicate.relativePath);
                }
            }
            merged += 1;
        }
        if (merged > 0 || deletedFiles.length > 0) {
            this.repairManifests();
        }
        return {
            merged,
            changedFiles,
            deletedFiles,
        };
    }
}
