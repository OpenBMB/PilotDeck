import { writeFile, chmod } from 'node:fs/promises';
import { loadPilotConfig } from '../dist/src/pilot/config/loadPilotConfig.js';
import { createModelRuntime } from '../dist/src/model/ModelRuntime.js';
const target = process.argv[2];
if (!target) throw Error('Temporary output path required');
const { config } = loadPilotConfig({ configPath: process.env.PD_MODEL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml' });
const runtime = createModelRuntime(config.model);
const candidates = Object.entries(config.model.providers).flatMap(([provider, row]) => Object.keys(row.models).map(model => ({ id: provider + '/' + model, provider, model })))
  .filter(candidate => !process.env.PD_MODEL_ID || candidate.id === process.env.PD_MODEL_ID)
  .sort((a, b) => Number(b.id === config.agent.model.id) - Number(a.id === config.agent.model.id) || a.id.localeCompare(b.id));
for (const candidate of candidates) {
  if (!['openai', 'openai-compatible', 'openai-chat-completions'].includes(runtime.getProviderProtocol(candidate.provider))) continue;
  try {
    const result = await runtime.complete({ provider: candidate.provider, model: candidate.model,
      systemPrompt: 'Return exactly a JSON object with km_acceptance set to true.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Temporary knowledge acceptance' }] }], maxOutputTokens: 128 },
      { signal: AbortSignal.timeout(30000) });
    const text = result.content.filter(row => row.type === 'text').map(row => row.text).join('');
    if (!JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')).km_acceptance) continue;
    const provider = config.model.providers[candidate.provider];
    await writeFile(target, JSON.stringify({ base_url: runtime.getProviderBaseUrl(candidate.provider), model: candidate.model, api_key: provider.apiKey }), { mode: 0o600 });
    await chmod(target, 0o600);
    console.log(JSON.stringify({ status: 'passed', ...candidate, valid_result: true }));
    process.exit(0);
  } catch (error) { console.error(JSON.stringify({ ...candidate, status: 'failed', error_type: error.name })); }
}
console.log(JSON.stringify({ status: 'not_accepted', reason: 'No available OpenAI-compatible model configuration' }));
process.exit(1);
