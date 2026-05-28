export declare function hashText(input: string): string;
export declare function nowIso(): string;
export declare function buildL0IndexId(sessionKey: string, timestamp: string, payload: string): string;
export declare function buildL1IndexId(timestamp: string, sourceIds: string[]): string;
export declare function buildL2TimeIndexId(dateKey: string): string;
export declare function buildL2ProjectIndexId(projectKey: string): string;
export declare function buildFactId(factKey: string): string;
export declare function buildLinkId(fromLevel: string, fromId: string, toLevel: string, toId: string): string;
