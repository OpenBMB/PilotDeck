import type { MemoryMessage } from "./core/types.js";
export declare const SESSION_START_PREFIX = "A new session was started via /new or /reset.";
export interface TranscriptMessageInfo {
    role: "user" | "assistant" | undefined;
    content: string;
    hasToolCalls: boolean;
}
export declare function isSessionStartupMarkerText(text: string): boolean;
export declare function isCommandOnlyUserText(text: string): boolean;
export declare function inspectTranscriptMessage(raw: unknown): TranscriptMessageInfo;
export declare function isSessionBoundaryMarkerMessage(rawMessage: unknown): boolean;
export declare function normalizeTranscriptMessage(rawMessage: unknown, options: {
    includeAssistant: boolean;
    maxMessageChars: number;
}): MemoryMessage | undefined;
export declare function normalizeMessages(rawMessages: unknown[], options: {
    includeAssistant: boolean;
    maxMessageChars: number;
    captureStrategy: "last_turn" | "full_session";
}): MemoryMessage[];
