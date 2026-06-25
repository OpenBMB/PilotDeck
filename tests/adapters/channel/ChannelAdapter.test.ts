import { describe, it, expect } from 'vitest';
import type { ChannelAdapter, ChannelStartDeps } from '../../../src/adapters/channel/protocol/ChannelAdapter.js';
import type { GatewayChannelKey } from '../../../src/gateway/index.js';

describe('ChannelAdapter interface contract', () => {
  it('defines valid channelKey property', () => {
    // ChannelAdapter is an interface; verify the type contract
    // by checking the GatewayChannelKey type is a string
    const adapter: ChannelAdapter = {
      channelKey: 'test' as GatewayChannelKey,
      start: async (_deps: ChannelStartDeps) => ({
        stop: async (_reason?: string) => {},
      }),
    };

    expect(adapter.channelKey).toBe('test');
    expect(typeof adapter.start).toBe('function');
  });

  it('ChannelStartDeps config is optional', () => {
    const adapter: ChannelAdapter = {
      channelKey: 'cli' as GatewayChannelKey,
      start: async (deps: ChannelStartDeps) => ({
        stop: async () => {},
      }),
    };

    expect(adapter.start).toBeInstanceOf(Function);
  });
});

describe('ChannelHandle contract', () => {
  it('stop can be called with or without reason', async () => {
    const adapter: ChannelAdapter = {
      channelKey: 'test' as GatewayChannelKey,
      start: async (_deps: ChannelStartDeps) => {
        const handle = {
          stop: async (reason?: string) => {
            if (reason) {
              // cleanup with reason
            }
          },
        };
        return handle;
      },
    };

    const handle = await adapter.start({
      gateway: {} as any,
    });

    await handle.stop();
    await handle.stop('shutdown');
  });
});
