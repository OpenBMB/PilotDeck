export declare function truncate(text: string, maxLength: number): string;
export declare function decodeEscapedUnicodeText(text: string, decodeCommonEscapes?: boolean): string;
export declare function decodeEscapedUnicodeValue<T>(value: T, decodeCommonEscapes?: boolean): T;
export declare function normalizeText(text: string): string;
export declare function scoreMatch(query: string, text: string): number;
export declare function safeJsonParse<T>(raw: string, fallback: T): T;
