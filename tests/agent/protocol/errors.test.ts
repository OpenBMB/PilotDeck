import { describe, it, expect } from 'vitest';
import {
  agentError,
  AgentRuntimeError,
  normalizeAgentError,
} from '../../../src/agent/protocol/errors.js';

describe('Agent Protocol Errors', () => {
  describe('agentError', () => {
    it('creates an AgentError with code and message', () => {
      const err = agentError('agent_max_turns_reached', 'Reached max turns');
      expect(err.code).toBe('agent_max_turns_reached');
      expect(err.message).toBe('Reached max turns');
    });

    it('includes optional details', () => {
      const details = { turns: 10 };
      const err = agentError('agent_invalid_state', 'Invalid state', details);
      expect(err.details).toBe(details);
    });

    it('handles all known error codes', () => {
      const codes = [
        'agent_aborted',
        'agent_max_turns_reached',
        'agent_model_error',
        'agent_model_capability_error',
        'agent_prompt_too_long',
        'agent_context_recovery_failed',
        'agent_tool_result_pairing_failed',
        'agent_transcript_error',
        'agent_invalid_state',
        'agent_unsupported_feature',
        'agent_tool_error_loop',
      ] as const;

      for (const code of codes) {
        const err = agentError(code, `Test ${code}`);
        expect(err.code).toBe(code);
        expect(typeof err.message).toBe('string');
      }
    });
  });

  describe('AgentRuntimeError', () => {
    it('extends Error with code and details', () => {
      const err = new AgentRuntimeError(
        'agent_aborted',
        'Session was aborted',
        { reason: 'user_cancelled' },
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AgentRuntimeError);
      expect(err.name).toBe('AgentRuntimeError');
      expect(err.code).toBe('agent_aborted');
      expect(err.message).toBe('Session was aborted');
      expect(err.details).toEqual({ reason: 'user_cancelled' });
    });
  });

  describe('normalizeAgentError', () => {
    it('preserves AgentRuntimeError codes', () => {
      const original = new AgentRuntimeError('agent_max_turns_reached', 'Too many turns');
      const normalized = normalizeAgentError(original);
      expect(normalized.code).toBe('agent_max_turns_reached');
      expect(normalized.message).toBe('Too many turns');
    });

    it('wraps generic Error as agent_invalid_state', () => {
      const normalized = normalizeAgentError(new Error('Something broke'));
      expect(normalized.code).toBe('agent_invalid_state');
      expect(normalized.message).toBe('Something broke');
    });

    it('converts non-Error values to agent_invalid_state string', () => {
      const normalized = normalizeAgentError('just a string');
      expect(normalized.code).toBe('agent_invalid_state');
      expect(normalized.message).toBe('just a string');
    });

    it('converts null to agent_invalid_state', () => {
      const normalized = normalizeAgentError(null);
      expect(normalized.code).toBe('agent_invalid_state');
      expect(normalized.message).toBe('null');
    });
  });
});
