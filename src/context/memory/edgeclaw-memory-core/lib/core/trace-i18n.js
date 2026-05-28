export function traceI18n(key, fallback, ...args) {
    return {
        key,
        ...(args.length > 0 ? { args: args.map((value) => String(value)) } : {}),
        fallback,
    };
}
