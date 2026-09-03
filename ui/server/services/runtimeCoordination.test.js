import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCoordination } from './runtimeCoordination.js';

function createProcessLike({ supervised = true } = {}) {
  const processLike = new EventEmitter();
  processLike.connected = supervised;
  if (supervised) processLike.send = vi.fn();
  return processLike;
}

describe('runtime coordination', () => {
  it('publishes model configuration state to a supervisor', () => {
    const processLike = createProcessLike();
    const configuration = { state: 'ready', modelRef: 'openai/gpt-5' };
    const coordination = createRuntimeCoordination({
      processLike,
      env: { PILOTDECK_RUNTIME_SUPERVISED: '1' },
      readConfigurationState: () => configuration,
    });

    expect(coordination.publishConfigurationState()).toBe(configuration);
    expect(coordination.getConfigurationState()).toBe(configuration);
    expect(processLike.send).toHaveBeenCalledWith({
      type: 'pilotdeck:configuration-state',
      configuration,
    });
  });

  it('tracks gateway state sent by the supervisor', () => {
    const processLike = createProcessLike();
    const coordination = createRuntimeCoordination({
      processLike,
      env: { PILOTDECK_RUNTIME_SUPERVISED: '1' },
    });

    processLike.emit('message', { type: 'pilotdeck:gateway-state', state: 'starting' });
    expect(coordination.getGatewayState()).toEqual({ state: 'starting' });

    processLike.emit('message', {
      type: 'pilotdeck:gateway-state',
      state: 'error',
      error: 'port unavailable',
    });
    expect(coordination.getGatewayState()).toEqual({
      state: 'error',
      error: 'port unavailable',
    });
  });

  it('reports unmanaged when the UI server has no runtime supervisor', () => {
    const processLike = createProcessLike({ supervised: false });
    const coordination = createRuntimeCoordination({ processLike });

    expect(coordination.getGatewayState()).toEqual({ state: 'unmanaged' });
    expect(coordination.requestGatewayRetry()).toBe(false);
  });
});
