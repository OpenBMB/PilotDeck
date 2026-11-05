import { MintAcpGateway } from '../../ui/server/services/mintAcpGateway.js';
const project = process.env.PILOTDECK_MINT_PROJECT || '/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime';
const command = process.env.PILOTDECK_MINT_COMMAND || project + '/runtime-bundle/bin/cpmrt-kernel';
const stateDir = process.env.PILOTDECK_MINT_STATE_DIR || project + '/acp-smoke-state';
const bridgeStateDir = process.env.PILOTDECK_MINT_BRIDGE_STATE_DIR || project + '/acp-bridge-state';
const modelBaseUrl = process.env.PILOTDECK_MINT_MODEL_BASE_URL || 'http://127.0.0.1:11434/v1';
const model = process.env.PILOTDECK_MINT_MODEL || 'mint-minicpm5:2.6b-q4_k_m';
const gateway = new MintAcpGateway({
  command,
  args: command.endsWith('launch.py') ? [] : ['--state-dir', stateDir, '--model-base-url', modelBaseUrl,
    '--model', model, '--', 'acp', '--cwd', project],
  cwd: project, stateDir: bridgeStateDir,
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
