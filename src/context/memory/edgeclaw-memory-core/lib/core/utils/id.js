import { createHash } from "node:crypto";
export function hashText(input) {
    return createHash("sha1").update(input).digest("hex").slice(0, 10);
}
export function nowIso() {
    return new Date().toISOString();
}
export function buildL0IndexId(sessionKey, timestamp, payload) {
    const key = sessionKey || "session";
    return `${key}_${hashText(`${timestamp}:${payload}`)}_raw`;
}
export function buildL1IndexId(timestamp, sourceIds) {
    return `l1_${hashText(`${timestamp}:${sourceIds.sort().join(",")}`)}`;
}
export function buildL2TimeIndexId(dateKey) {
    return `time_${hashText(dateKey)}`;
}
export function buildL2ProjectIndexId(projectKey) {
    return `project_${hashText(projectKey.toLowerCase())}`;
}
export function buildFactId(factKey) {
    return `fact_${hashText(factKey.toLowerCase())}`;
}
export function buildLinkId(fromLevel, fromId, toLevel, toId) {
    return `link_${hashText(`${fromLevel}:${fromId}->${toLevel}:${toId}`)}`;
}
