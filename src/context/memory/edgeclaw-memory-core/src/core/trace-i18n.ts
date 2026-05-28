import type { TraceI18nText } from "./types.js";

export function traceI18n(
  key: string,
  fallback: string,
  ...args: Array<string | number>
): TraceI18nText {
  return {
    key,
    ...(args.length > 0 ? { args: args.map((value) => String(value)) } : {}),
    fallback,
  };
}
