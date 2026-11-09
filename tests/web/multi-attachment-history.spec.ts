import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenCanonicalMessage } from '../../src/web/server/readSessionMessages.js';
import type { CanonicalContentBlock } from '../../src/model/index.js';

test('one mixed user submission remains one text bubble with every image in order', () => {
  const content = [
    { type: 'text', text: 'Compare these', blockId: 'prompt' },
    { type: 'image', mimeType: 'image/png', data: 'YQ==' },
    { type: 'text', text: '\nSecond image:', blockId: 'label-2' },
    { type: 'image', mimeType: 'image/png', data: 'Yg==' },
    { type: 'pdf', mimeType: 'application/pdf', data: 'cGRm', bytes: 3 },
    { type: 'text', text: '\nThird image:', blockId: 'label-3' },
    { type: 'image', mimeType: 'image/png', data: 'Yw==' },
  ];
  const rows = flattenCanonicalMessage({ role: 'user', content: content as CanonicalContentBlock[] }, { index: 0, sessionKey: 's' });
  const users = rows.filter(row => row.kind === 'text' && row.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0]?.text, 'Compare these\nSecond image:\nThird image:');
  assert.deepEqual(users[0]?.images?.map(image => image.data), ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==', 'data:image/png;base64,Yw==']);
});
