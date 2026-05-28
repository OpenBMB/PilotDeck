export function matchHookCondition(
  condition: string | undefined,
  input: { toolName?: string; toolInput?: unknown },
): boolean {
  if (!condition) {
    return true;
  }

  const parsed = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/.exec(condition.trim());
  if (!parsed) {
    return false;
  }

  const [, expectedTool, pattern] = parsed;
  if (expectedTool && input.toolName && !sameToolName(expectedTool, input.toolName)) {
    return false;
  }

  if (!pattern || pattern === "*") {
    return true;
  }

  return JSON.stringify(input.toolInput ?? {}).includes(pattern.replace(/\*/g, ""));
}

function sameToolName(left: string, right: string): boolean {
  return normalizeToolName(left) === normalizeToolName(right);
}

function normalizeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}
