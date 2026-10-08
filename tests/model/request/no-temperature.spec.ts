import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelConfig } from '../../../src/model/config/parseModelConfig.js';
import { buildModelRequest } from '../../../src/model/request/buildModelRequest.js';
import { complete } from '../../../src/model/streaming/streamModel.js';
import type { ModelProtocol } from '../../../src/model/protocol/canonical.js';

function config(protocol: ModelProtocol) {
  return parseModelConfig({providers:{custom:{protocol,url:'https://example.test/v1',apiKey:'test',
    extraBody:{temperature:.8,metadata:{temperature:'ordinary application data'},generationConfig:{temperature:.5,topP:.9}},
    models:{test:{temperature:.7}},
  }}});
}
const legacyRequest = {provider:'custom',model:'test',temperature:.3,messages:[{role:'user' as const,content:[{type:'text' as const,text:'Hello'}]}]};
for (const protocol of ['openai','openai-responses','anthropic','google'] as const) {
  test(`${protocol}: ignores legacy request/config temperatures`, () => {
    const parsed = config(protocol);
    const body = JSON.parse(JSON.stringify(buildModelRequest(legacyRequest,parsed)));
    assert.equal(body.temperature,undefined);
    assert.equal(body.config?.temperature,undefined);
    assert.equal(parsed.providers.custom.extraBody?.temperature,undefined);
    assert.deepEqual(parsed.providers.custom.extraBody?.generationConfig,{topP:.9});
    assert.deepEqual(parsed.providers.custom.extraBody?.metadata,{temperature:'ordinary application data'});
  });
}
test('HTTP dispatch cannot reintroduce temperature from old extraBody settings', async () => {
  const parsed = config('openai');
  parsed.providers.custom.extraBody = {temperature:.8,reasoning_effort:'high'};
  await complete(legacyRequest,parsed,{fetch:async (_url,init) => {
    const payload=JSON.parse(String(init?.body));
    assert.equal(payload.temperature,undefined);
    assert.equal(payload.reasoning_effort,'high');
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
  }});
});
