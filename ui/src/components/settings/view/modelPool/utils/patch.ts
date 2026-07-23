type Path = readonly (string | number)[];

export function patch<T>(config: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === "number";
  const current: any = config ?? (isArrayKey ? [] : {});
  const next: any = isArrayKey
    ? [...(current as unknown[])]
    : { ...(current as object) };
  next[head as string | number] =
    rest.length === 0
      ? value
      : patch(
          current?.[head as string | number] ??
            (typeof rest[0] === "number" ? [] : {}),
          rest,
          value,
        );
  return next as T;
}
