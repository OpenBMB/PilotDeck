import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenCanonicalMessage } from '../../src/web/server/readSessionMessages.js';
import { toCanonicalToolResultBlock } from '../../src/tool/protocol/result.js';

test('generated image attachment identity survives transcript projection without inline binary data', () => {
  const imageGeneration = { imageId: 'image-id', sessionId: 'session-id', width: 24, height: 16, mimeType: 'image/png', path: '/managed/image.png' };
  const block = toCanonicalToolResultBlock({ type: 'success', toolCallId: 'draw', toolName: 'generate_image', content: [{ type: 'text', text: 'Attached' }],
    data: { imageGeneration }, startedAt: '', completedAt: '' });
  const [row] = flattenCanonicalMessage({ role: 'user', content: [block] }, { index: 0, sessionKey: 'session-id' });
  assert.equal(row?.kind, 'tool_result');
  assert.equal(row?.toolName, 'generate_image');
  assert.deepEqual(row?.payload, { imageGeneration });
  assert.equal(row?.images, undefined);
});
