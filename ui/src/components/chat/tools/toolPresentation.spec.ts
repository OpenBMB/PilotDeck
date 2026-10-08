import { describe, expect, it } from 'vitest';
import { shellOutput, resultText } from './toolPresentation';
const legacy = 'BASH_RESULT[success][stdout_data]\nAssertions:\n- exit_code: 0\n- stdout_visible: true\n- stderr_visible: false\n- retrieved_data_available: true\n- stdout_bytes: 5\n- stderr_bytes: 0\nInterpretation: Command succeeded.\n\nstdout:\nhello';
describe('shell result presentation', () => {
  it('uses structured streams without modifying the source', () => {
    const result = { content: legacy, toolUseResult: { data: { stdout: 'actual output', stderr: 'warning', exitCode: 0, durationMs: 1300 } } };
    expect(shellOutput(result)).toMatchObject({ output: 'actual output\n\nstderr:\nwarning', exitCode: 0, durationMs: 1300 });
    expect(result.content).toBe(legacy);
  });
  it('unwraps complete historical envelopes', () => {
    expect(shellOutput({ content: legacy })).toMatchObject({ output: 'hello', raw: legacy, exitCode: 0 });
  });
  it('preserves unknown output and incomplete or similar-looking envelopes', () => {
    for (const content of ['hello\nstdout:\nworld', legacy.replace('Assertions:', 'Other:'), 'BASH_RESULT[success][stdout_data]']) {
      expect(shellOutput({ content }).output).toBe(content);
    }
  });
  it('handles successful empty output without inventing data', () => {
    expect(shellOutput({ content: legacy, toolUseResult: { stdout: '', stderr: '', exitCode: 0 } }).output).toBe('');
    expect(shellOutput({ content: legacy.split('\n\nstdout:')[0].replace('stdout_data', 'empty_stdout') }).output).toBe('');
  });
  it('preserves unrecognized structured results', () => {
    expect(resultText([{ type: 'text', text: 'hello' }])).toBe('hello');
    expect(resultText({ important: true })).toContain('"important": true');
  });
});
