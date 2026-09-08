// @vitest-environment node
import { it, expect, vi, beforeEach } from 'vitest';
const { runUpdateProcess } = vi.hoisted(() => ({ runUpdateProcess: vi.fn() }));
vi.mock('../../../src/runtime/updateCommand.js', () => ({ runUpdateProcess }));
import { getRegisteredCommands } from '../../../src/adapters/channel/protocol/ChannelCommandRegistry.ts';
const update = getRegisteredCommands().find(command => command.name === 'update')!;
beforeEach(() => runUpdateProcess.mockReset());
it('IM check uses the shared Release command', async () => {
  runUpdateProcess.mockResolvedValue({ code: 0, output: 'Release available: v2026.09.07' });
  const reply=vi.fn();
  await update.handler!({reply} as never,'check');
  expect(runUpdateProcess).toHaveBeenCalledWith(['--check']);
  expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('v2026.09.07'));
});
it('IM update forwards the restart request without exiting the Gateway itself', async () => {
  runUpdateProcess.mockResolvedValue({code:0,output:'Web service accepted the restart request.'});
  const exit=vi.spyOn(process,'exit').mockImplementation((()=>{throw new Error('unexpected exit');}) as never);
  try {
    const reply=vi.fn();await update.handler!({reply} as never,'');
    expect(runUpdateProcess).toHaveBeenCalledWith(['--restart']);
    expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('accepted'));
    expect(exit).not.toHaveBeenCalled();
  } finally { exit.mockRestore(); }
});
it('IM reports an unsupported deployment without promising a restart', async () => {
  runUpdateProcess.mockResolvedValue({code:1,output:'development: Developer branches do not support self-update.'});
  const reply=vi.fn();await update.handler!({reply} as never,'check');
  expect(reply).toHaveBeenLastCalledWith('❌ development: Developer branches do not support self-update.');
});
it('IM sends only the update outcome rather than local configuration logs', async () => {
  runUpdateProcess.mockResolvedValue({code:1,output:'[proxy] local configuration\ndevelopment: Update this workspace manually.'});
  const reply=vi.fn();await update.handler!({reply} as never,'check');
  expect(reply).toHaveBeenLastCalledWith('❌ development: Update this workspace manually.');
});
