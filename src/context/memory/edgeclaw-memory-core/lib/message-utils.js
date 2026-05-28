import { decodeEscapedUnicodeText } from "./core/utils/text.js";
const MEMORY_CONTEXT_HEADER = "You are using retrieved ClawXMemory file memories for this turn.";
const LEGACY_MEMORY_CONTEXT_HEADER = "You are using multi-level memory indexes for this turn.";
const MEMORY_CONTEXT_FOOTER = "Treat the above as authoritative prior memory when it is relevant. Prioritize the user's latest request, and do not claim memory is missing or that this is a fresh conversation if the answer is already shown above.";
const RECALL_CONTEXT_HEADER = "## ClawXMemory Recall";
const RECALL_CONTEXT_INSTRUCTION = "Use the following retrieved ClawXMemory evidence for this turn.";
const RECALL_CONTEXT_FOOTER = "Treat the selected evidence above as authoritative historical memory for this turn when it is relevant.";
const RECALL_CONTEXT_FOOTER_FINAL = "If the needed answer is already shown above, do not claim that memory is missing or that this is a fresh conversation.";
export const SESSION_START_PREFIX = "A new session was started via /new or /reset.";
const SLUG_PROMPT_PREFIX = "Based on this conversation, generate a short 1-2 word filename slug";
const MAX_CONTENT_EXTRACTION_DEPTH = 5;
const SESSION_START_SEQUENCE_PATTERN = /\b(?:Run|Execute) your Session Startup sequence\b/i;
const KNOWN_SLASH_COMMANDS = new Set([
    "help",
    "commands",
    "skill",
    "status",
    "allowlist",
    "approve",
    "context",
    "whoami",
    "id",
    "subagents",
    "config",
    "debug",
    "usage",
    "tts",
    "voice",
    "stop",
    "restart",
    "dock-telegram",
    "dock_telegram",
    "dock-discord",
    "dock_discord",
    "dock-slack",
    "dock_slack",
    "activation",
    "send",
    "reset",
    "new",
    "think",
    "thinking",
    "t",
    "verbose",
    "v",
    "reasoning",
    "reason",
    "elevated",
    "elev",
    "exec",
    "model",
    "models",
    "queue",
    "bash",
    "compact",
]);
const KNOWN_BANG_COMMANDS = new Set(["poll", "stop"]);
const PLUGIN_STATE_LINE_PATTERNS = [
    /^project state maintained by\b/i,
    /^session status\b/i,
    /^current git branch\s*:/i,
    /^git status(?: summary)?\s*:/i,
];
const PLUGIN_STATE_METADATA_PATTERNS = [
    /\bproject state maintained by\b/i,
    /\bsession status\b/i,
    /\bagent\s*:/i,
    /\bhost\s*:/i,
    /\bworkspace\s*:/i,
    /\bos\s*:/i,
    /\bnode\s*:/i,
    /\bmodel\s*:/i,
    /\bcurrent git branch\s*:/i,
    /\bgit status(?: summary)?\s*:/i,
];
function truncate(text, maxLength) {
    if (maxLength <= 0 || text.length <= maxLength)
        return text;
    return `${text.slice(0, maxLength)}...`;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function pushUniqueText(target, value) {
    const normalized = value.trim();
    if (!normalized || target.includes(normalized))
        return;
    target.push(normalized);
}
function extractTextFromObject(content, depth) {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (["toolcall", "toolresult", "image", "input_image", "file", "media"].includes(type)) {
        return "";
    }
    if (["text", "input_text", "output_text", "paragraph"].includes(type) && typeof content.text === "string") {
        return decodeEscapedUnicodeText(content.text);
    }
    if (typeof content.text === "string" && type === "message_text") {
        return decodeEscapedUnicodeText(content.text);
    }
    const parts = [];
    if (typeof content.text === "string") {
        pushUniqueText(parts, decodeEscapedUnicodeText(content.text));
    }
    const prioritizedKeys = ["content", "body", "message", "caption"];
    const listKeys = ["parts", "items", "blocks", "segments", "chunks"];
    for (const key of prioritizedKeys) {
        const extracted = extractTextFromContent(content[key], depth + 1);
        pushUniqueText(parts, extracted);
    }
    for (const key of listKeys) {
        const extracted = extractTextFromContent(content[key], depth + 1);
        pushUniqueText(parts, extracted);
    }
    return parts.join("\n").trim();
}
function extractTextFromContent(content, depth = 0) {
    if (depth > MAX_CONTENT_EXTRACTION_DEPTH)
        return "";
    if (typeof content === "string")
        return decodeEscapedUnicodeText(content);
    if (Array.isArray(content)) {
        const blocks = [];
        for (const block of content) {
            const extracted = extractTextFromContent(block, depth + 1);
            pushUniqueText(blocks, extracted);
        }
        return blocks.join("\n");
    }
    const object = asRecord(content);
    if (object) {
        return extractTextFromObject(object, depth);
    }
    return "";
}
function stripInjectedMemoryContext(text) {
    let cleaned = text.trim();
    for (const header of [MEMORY_CONTEXT_HEADER, LEGACY_MEMORY_CONTEXT_HEADER]) {
        if (!cleaned.includes(header))
            continue;
        const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedFooter = MEMORY_CONTEXT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`${escapedHeader}[\\s\\S]*?${escapedFooter}\\s*`, "g");
        cleaned = cleaned.replace(pattern, "").trim();
    }
    if (cleaned.includes(RECALL_CONTEXT_HEADER) && cleaned.includes(RECALL_CONTEXT_INSTRUCTION)) {
        const escapedHeader = RECALL_CONTEXT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedInstruction = RECALL_CONTEXT_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedFooter = RECALL_CONTEXT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedFooterFinal = RECALL_CONTEXT_FOOTER_FINAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`${escapedHeader}\\s*${escapedInstruction}[\\s\\S]*?${escapedFooter}\\s*${escapedFooterFinal}\\s*`, "g");
        cleaned = cleaned.replace(pattern, "").trim();
        const remainingLines = cleaned.replace(/\r/g, "").split("\n");
        while (remainingLines.length > 0) {
            const value = remainingLines[0]?.trim() ?? "";
            if (!value || /^System:\s*/i.test(value)) {
                remainingLines.shift();
                continue;
            }
            break;
        }
        cleaned = remainingLines.join("\n").trim();
    }
    return cleaned;
}
function compactWhitespace(text) {
    const lines = text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trimEnd());
    const compact = [];
    let previousEmpty = false;
    for (const line of lines) {
        const empty = line.trim().length === 0;
        if (empty && previousEmpty)
            continue;
        compact.push(empty ? "" : line);
        previousEmpty = empty;
    }
    return compact.join("\n").trim();
}
function normalizePluginNoiseProbe(text) {
    return text
        .replace(/\r/g, "")
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/^[>\-*\s]+/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}
function countPluginStateMarkers(text) {
    const normalized = normalizePluginNoiseProbe(text);
    let count = 0;
    for (const pattern of PLUGIN_STATE_METADATA_PATTERNS) {
        if (pattern.test(normalized))
            count += 1;
    }
    return count;
}
function startsWithPluginStateLine(text) {
    const normalized = normalizePluginNoiseProbe(text);
    return PLUGIN_STATE_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}
function lineLooksLikePluginNoise(text) {
    const normalized = normalizePluginNoiseProbe(text);
    if (!normalized)
        return false;
    return startsWithPluginStateLine(normalized) || countPluginStateMarkers(normalized) >= 4;
}
function paragraphLooksLikePluginNoise(text) {
    const normalized = normalizePluginNoiseProbe(text);
    if (!normalized)
        return false;
    if (startsWithPluginStateLine(normalized))
        return true;
    const lines = text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => normalizePluginNoiseProbe(line))
        .filter(Boolean);
    const noisyLines = lines.filter((line) => startsWithPluginStateLine(line) || countPluginStateMarkers(line) >= 3).length;
    const markerCount = countPluginStateMarkers(normalized);
    if (/session status/i.test(normalized) && markerCount >= 2)
        return true;
    return markerCount >= 4 && noisyLines >= Math.max(1, Math.ceil(lines.length / 2));
}
function stripPluginStateScaffolding(text) {
    const normalized = compactWhitespace(text);
    if (!normalized)
        return "";
    const paragraphs = normalized
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
    while (paragraphs.length > 0 && paragraphLooksLikePluginNoise(paragraphs[0])) {
        paragraphs.shift();
    }
    let cleaned = paragraphs.join("\n\n").trim();
    if (!cleaned)
        return "";
    const lines = cleaned.split("\n");
    while (lines.length > 0 && lineLooksLikePluginNoise(lines[0])) {
        lines.shift();
    }
    cleaned = compactWhitespace(lines.join("\n"));
    if (!cleaned)
        return "";
    return paragraphLooksLikePluginNoise(cleaned) ? "" : cleaned;
}
function normalizeSenderHint(value) {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}
function collectSenderHints(text) {
    const hints = new Set();
    const blockPattern = /(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*```(?:json)?\s*([\s\S]*?)\s*```/gi;
    const inlinePattern = /(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*(\{[\s\S]*?\})/gi;
    const add = (value) => {
        if (typeof value !== "string")
            return;
        const normalized = normalizeSenderHint(value);
        if (!normalized)
            return;
        hints.add(normalized);
    };
    const parseBlock = (raw) => {
        try {
            const parsed = JSON.parse(raw);
            const object = asRecord(parsed);
            if (!object)
                return;
            add(object.sender);
            add(object.sender_id);
            add(object.sender_label);
        }
        catch {
            // Ignore malformed metadata blocks.
        }
    };
    for (const match of text.matchAll(blockPattern)) {
        parseBlock(match[1] ?? "");
    }
    for (const match of text.matchAll(inlinePattern)) {
        parseBlock(match[1] ?? "");
    }
    return Array.from(hints);
}
function stripUntrustedSenderMetadata(text) {
    const codeFencePattern = /(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*```(?:json)?[\s\S]*?```\s*/gi;
    const inlineJsonPattern = /(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*\{[\s\S]*?\}\s*/gi;
    return text
        .replace(codeFencePattern, "")
        .replace(inlineJsonPattern, "");
}
function stripQuotedContextBlocks(text) {
    return text
        .replace(/(?:Chat history since last reply|Replied message)\s*\(untrusted[^)]*\)\s*:\s*```(?:json)?[\s\S]*?```\s*/gi, "")
        .replace(/\[Chat messages since your last reply - for context\][\s\S]*?(?=\[Current message - respond to this\]|$)/gi, "");
}
function extractCurrentMessageSegment(text) {
    const marker = "[Current message - respond to this]";
    const index = text.lastIndexOf(marker);
    if (index < 0)
        return text;
    return text.slice(index + marker.length).trim();
}
function stripLeadingTimestampPrefix(text) {
    return text.replace(/^\s*\[[^\]\n]*(?:\d{4}-\d{1,2}-\d{1,2}|GMT|UTC)[^\]\n]*\]\s*/i, "");
}
function stripAttachmentScaffolding(text) {
    let cleaned = text
        .replace(/^\[media attached:[^\n]*\]\s*/gim, "")
        .replace(/^To send an image back,[^\n]*$/gim, "");
    const fileTagIndex = cleaned.search(/\n<file\b/i);
    if (fileTagIndex >= 0) {
        cleaned = cleaned.slice(0, fileTagIndex);
    }
    return cleaned.replace(/<file\b[^>]*>/gi, "");
}
function stripLeadingCurrentMessageEnvelope(text) {
    const match = text.match(/^(?:\[[^\]\n]{1,320}\]\s*)+([^:\n]{1,120}):\s*([\s\S]*)$/);
    if (!match)
        return text;
    return (match[2] ?? "").trim();
}
function looksLikeOpaqueSenderLabel(label) {
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > 120)
        return false;
    if (/^[A-Za-z0-9_.@()\- ]+$/.test(trimmed) && (/[0-9_]/.test(trimmed) || /^[A-Za-z][A-Za-z0-9_.@()\- ]{4,}$/.test(trimmed))) {
        return true;
    }
    return false;
}
function stripLeadingSenderPrefix(text, senderHints) {
    const lines = text.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    const match = firstLine.match(/^([^:\n]{1,120}):\s*([\s\S]*)$/);
    if (!match)
        return text;
    const label = normalizeSenderHint(match[1] ?? "");
    const shouldStrip = senderHints.includes(label) || looksLikeOpaqueSenderLabel(match[1] ?? "");
    if (!shouldStrip)
        return text;
    lines[0] = match[2] ?? "";
    return lines.join("\n").trim();
}
function stripLeadingMentions(text) {
    let cleaned = text.trimStart();
    while (true) {
        const next = cleaned.replace(/^@[\w.-]+\s*/i, "");
        if (next === cleaned)
            break;
        cleaned = next.trimStart();
    }
    return cleaned;
}
function stripLeadingMessageEnvelopeLines(text) {
    const lines = text.split("\n");
    const isNoiseLine = (line) => {
        const value = line.trim();
        if (!value)
            return true;
        if (value === "```" || value.toLowerCase() === "```json")
            return true;
        if (value === "{" || value === "}")
            return true;
        if (/^(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:?/i.test(value))
            return true;
        if (/^(?:Chat history since last reply|Replied message)\s*\(untrusted[^)]*\)\s*:?/i.test(value))
            return true;
        if (/^System:\s*\[[^\]\n]*(?:\d{4}-\d{1,2}-\d{1,2}|GMT|UTC)[^\]\n]*\]\s*/i.test(value))
            return true;
        if (/^\[message_id:[^\]]+\]$/i.test(value))
            return true;
        if (/^\[[^\]\n]*(?:for context|Current message - respond to this)[^\]\n]*\]$/i.test(value))
            return true;
        if (/^\[[^\]\n]*(?:\d{4}-\d{1,2}-\d{1,2}|GMT|UTC|channel:\d+)[^\]\n]*\]\s*[^:\n]{1,120}:\s*/i.test(value))
            return true;
        return false;
    };
    while (lines.length > 0 && isNoiseLine(lines[0])) {
        lines.shift();
    }
    return lines.join("\n").trim();
}
function stripUserNoise(text) {
    if (!text)
        return "";
    const senderHints = collectSenderHints(text);
    let cleaned = stripInjectedMemoryContext(text);
    cleaned = extractCurrentMessageSegment(cleaned);
    cleaned = stripQuotedContextBlocks(cleaned);
    cleaned = stripAttachmentScaffolding(cleaned);
    cleaned = stripUntrustedSenderMetadata(cleaned);
    cleaned = stripLeadingCurrentMessageEnvelope(cleaned);
    cleaned = stripLeadingTimestampPrefix(cleaned);
    cleaned = stripLeadingMessageEnvelopeLines(cleaned);
    cleaned = stripLeadingSenderPrefix(cleaned, senderHints);
    cleaned = stripLeadingMentions(cleaned);
    cleaned = stripPluginStateScaffolding(cleaned);
    cleaned = stripLeadingMessageEnvelopeLines(cleaned);
    cleaned = stripLeadingTimestampPrefix(cleaned);
    return compactWhitespace(cleaned);
}
function stripAssistantThinking(text) {
    const withoutLeadingThink = text
        .replace(/^[\s\S]*?<\/think>/i, "")
        .replace(/^[\s\S]*?<\/thinking>/i, "");
    const withoutThink = withoutLeadingThink
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .replace(/<\/?think[^>]*>/gi, "")
        .replace(/<\/?thinking[^>]*>/gi, "");
    const lines = withoutThink
        .split("\n")
        .map((line) => line.trimEnd());
    const compact = [];
    let previousEmpty = false;
    for (const line of lines) {
        const empty = line.trim().length === 0;
        if (empty && previousEmpty)
            continue;
        compact.push(line);
        previousEmpty = empty;
    }
    const normalized = compact.join("\n").trim();
    const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    if (paragraphs.length >= 2) {
        const first = paragraphs[0] ?? "";
        const looksLikeMetaReasoning = ((/^用户/.test(first) && /(需要|应该|这是|表达|分享|说明|记录)/.test(first))
            || (/^搜索结果/.test(first) && /(需要|无法|不太理想)/.test(first))
            || (/^这搜索/.test(first) && /不太全|看不到|找不到/.test(first)));
        if (looksLikeMetaReasoning) {
            return stripPluginStateScaffolding(paragraphs.slice(1).join("\n\n").trim());
        }
    }
    return stripPluginStateScaffolding(normalized);
}
function hasToolCallContent(content) {
    return Array.isArray(content) && content.some((block) => {
        if (!block || typeof block !== "object")
            return false;
        const type = block.type;
        return type === "toolCall"
            || type === "toolResult"
            || type === "tool_use"
            || type === "tool_result";
    });
}
function shouldSkipUserMessage(content) {
    if (!content)
        return true;
    return isSessionStartupMarkerText(content)
        || isCommandOnlyUserText(content)
        || content.startsWith(SLUG_PROMPT_PREFIX);
}
function parseLeadingSlashCommand(text) {
    const trimmed = compactWhitespace(text);
    if (!trimmed.startsWith("/"))
        return undefined;
    const match = trimmed.match(/^\/([A-Za-z][\w-]*)(?::)?(?:\s|$)/);
    if (!match)
        return undefined;
    const command = (match[1] ?? "").toLowerCase();
    return KNOWN_SLASH_COMMANDS.has(command) ? command : undefined;
}
function parseBangCommand(text) {
    const trimmed = compactWhitespace(text);
    if (!trimmed.startsWith("!"))
        return undefined;
    if (/^!\s+\S/.test(trimmed))
        return "bash";
    const match = trimmed.match(/^!([A-Za-z][\w-]*)(?:\s|$)/);
    if (!match)
        return undefined;
    const command = (match[1] ?? "").toLowerCase();
    return KNOWN_BANG_COMMANDS.has(command) ? command : undefined;
}
export function isSessionStartupMarkerText(text) {
    const normalized = compactWhitespace(stripUserNoise(text));
    if (!normalized)
        return false;
    return normalized.includes(SESSION_START_PREFIX)
        || (normalized.includes("A new session was started via /new or /reset.")
            && SESSION_START_SEQUENCE_PATTERN.test(normalized));
}
export function isCommandOnlyUserText(text) {
    const normalized = compactWhitespace(stripUserNoise(text));
    if (!normalized || isSessionStartupMarkerText(normalized))
        return false;
    return Boolean(parseLeadingSlashCommand(normalized) || parseBangCommand(normalized));
}
export function inspectTranscriptMessage(raw) {
    if (!raw || typeof raw !== "object") {
        return { role: undefined, content: "", hasToolCalls: false };
    }
    const msg = raw;
    const nestedMessage = asRecord(msg.message);
    const role = typeof msg.role === "string"
        ? msg.role
        : typeof nestedMessage?.role === "string"
            ? nestedMessage.role
            : "";
    const normalizedRole = role === "user" || role === "assistant" ? role : undefined;
    const rawContent = msg.content ?? nestedMessage?.content;
    const rawText = extractTextFromContent(rawContent).trim();
    const content = normalizedRole === "user"
        ? stripUserNoise(rawText)
        : normalizedRole === "assistant"
            ? stripAssistantThinking(rawText)
            : "";
    return {
        role: normalizedRole,
        content,
        hasToolCalls: hasToolCallContent(rawContent),
    };
}
export function isSessionBoundaryMarkerMessage(rawMessage) {
    const info = inspectTranscriptMessage(rawMessage);
    return info.role === "user" && isSessionStartupMarkerText(info.content);
}
function shouldSkipAssistantMessage(rawContent, content) {
    if (!content)
        return true;
    if (hasToolCallContent(rawContent))
        return true;
    if (!content.includes("\n")) {
        const compact = content.trim();
        if ((/^用户/.test(compact) && /(需要|应该|这是|表达|分享|记录)/.test(compact))
            || (/^搜索结果/.test(compact) && /(需要|无法|不太理想)/.test(compact))) {
            return true;
        }
    }
    return false;
}
function normalizeSingleMessage(raw, options) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const msg = raw;
    const nestedMessage = asRecord(msg.message);
    if (msg.type === "user"
        && (msg.toolUseResult !== undefined && msg.toolUseResult !== null
            || Boolean(msg.isMeta)
            || Boolean(msg.isVisibleInTranscriptOnly)
            || Boolean(msg.isCompactSummary)
            || Boolean(msg.isVirtual))) {
        return undefined;
    }
    const info = inspectTranscriptMessage(raw);
    const role = info.role ?? "";
    if (role !== "user" && role !== "assistant")
        return undefined;
    if (role === "assistant" && !options.includeAssistant)
        return undefined;
    const rawContent = msg.content ?? nestedMessage?.content;
    const content = info.content;
    if (role === "user" && shouldSkipUserMessage(content))
        return undefined;
    if (role === "assistant" && shouldSkipAssistantMessage(rawContent, content))
        return undefined;
    if (!content)
        return undefined;
    const normalized = {
        role,
        content: truncate(content, options.maxMessageChars),
    };
    const rawId = typeof msg.id === "string"
        ? msg.id
        : typeof nestedMessage?.id === "string"
            ? nestedMessage.id
            : undefined;
    if (rawId) {
        normalized.msgId = rawId;
    }
    return normalized;
}
export function normalizeTranscriptMessage(rawMessage, options) {
    return normalizeSingleMessage(rawMessage, options);
}
export function normalizeMessages(rawMessages, options) {
    const all = [];
    for (const raw of rawMessages) {
        const normalized = normalizeSingleMessage(raw, options);
        if (!normalized)
            continue;
        all.push(normalized);
    }
    if (options.captureStrategy === "full_session")
        return all;
    let lastUser = -1;
    for (let i = all.length - 1; i >= 0; i -= 1) {
        if (all[i]?.role === "user") {
            lastUser = i;
            break;
        }
    }
    if (lastUser >= 0)
        return all.slice(lastUser);
    return all.some((message) => message.role === "user") ? [] : all.slice(-2);
}
