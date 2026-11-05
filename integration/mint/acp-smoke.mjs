import { MintAcpGateway } from '../../ui/server/services/mintAcpGateway.js';
const project = process.env.PILOTDECK_MINT_PROJECT || '/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime';
const gateway = new MintAcpGateway({
  command: project + '/runtime-bundle/bin/cpmrt-kernel',
  args: ['--state-dir', project + '/acp-smoke-state', '--model-base-url', 'http://127.0.0.1:11434/v1',
    '--model', 'mint-minicpm5:2.6b-q4_k_m', '--', 'acp', '--cwd', project],
  cwd: project, stateDir: project + '/acp-bridge-state',
});
try {
  for (const message of ['Remember this word: apricot. Reply briefly.', 'What word did I ask you to remember?']) {
    for await (const event of gateway.submitTurn({sessionKey:'mint:merged-acp-smoke',message,runId:crypto.randomUUID()})) {
      console.log(JSON.stringify(event));
    }
  }
  const history = await gateway.readSessionMessages({sessionKey:'mint:merged-acp-smoke'});
  console.log(JSON.stringify({event:'history_check', messages:history.messages}));
  if (history.messages.filter(m => m.role === 'assistant').length < 2) throw new Error('Assistant history missing');
} finally { gateway.close(); }
