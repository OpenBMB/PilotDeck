import type { ToolResult } from '../types/types';

export function displayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return objectValue(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function resultText(value: unknown): string {
  if (Array.isArray(value) && value.every(item => item?.type === 'text' && typeof item.text === 'string')) {
    return value.map(item => item.text).join('\n\n');
  }
  return displayText(value);
}

/** Presentation only: never changes the tool result sent to the model. */
export function shellOutput(result: ToolResult | null | undefined) {
  const raw = resultText(result?.content);
  const metadata = objectValue(result?.toolUseResult);
  const data = [objectValue(metadata.data), metadata].find(item =>
    typeof item.stdout === 'string' || typeof item.stderr === 'string');
  if (data) return {
    output: [data.stdout, data.stderr ? `stderr:\n${data.stderr}` : ''].filter(Boolean).join('\n\n'),
    exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    raw,
  };
  // Recognize only our complete legacy envelope; never strip arbitrary output.
  const match = /^BASH_RESULT\[success\]\[(stdout_data|stderr_only|empty_stdout)\]\r?\nAssertions:\r?\n- exit_code: (0)\r?\n- stdout_visible: (true|false)\r?\n- stderr_visible: (true|false)\r?\n- retrieved_data_available: (true|false)\r?\n- stdout_bytes: \d+\r?\n- stderr_bytes: \d+\r?\nInterpretation: [^\r\n]+(?:\r?\n\r?\n([\s\S]*))?$/.exec(raw);
  return {
    output: match ? (match[6] || '').replace(/^stdout:\r?\n/, '') : raw,
    exitCode: match ? 0 : undefined,
    durationMs: undefined,
    raw,
  };
}
