import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const configSource = (await fs.readFile(new URL('../../ui/server/constants/config.js', import.meta.url), 'utf8'))
  .replace("import '../load-env.js';", '');
const authSource = (await fs.readFile(new URL('../../ui/server/middleware/auth.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '');

// Isolate environment parsing and middleware without opening the production DB.
function loadAuth(value) {
  const env = value === undefined ? {} : { PILOTDECK_DISABLE_LOCAL_AUTH: value };
  const flags = new Function('process', configSource.replaceAll('export const', 'const') + '\nreturn { IS_PLATFORM, DISABLE_LOCAL_AUTH };')({ env });
  const user = { id: 1, username: 'owner' };
  const jwt = {
    verify(token) {
      if (token !== 'valid-token') throw new Error('Invalid token');
      return { userId: 1 };
    },
  };
  return new Function('IS_PLATFORM', 'DISABLE_LOCAL_AUTH', 'jwt', 'userDb', 'appConfigDb', 'withAuthenticatedRequest',
    authSource.replace(/export \{[\s\S]*?\};/, '') + '\nreturn { authenticateToken, authenticateWebSocket };')(
    flags.IS_PLATFORM, flags.DISABLE_LOCAL_AUTH, jwt,
    { getFirstUser: () => user, getUserById: id => id === 1 ? user : null },
    { getOrCreateJwtSecret: () => 'test-secret' },
    (req, res, next) => next(),
  );
}

for (const value of [undefined, '', '0', 'false', 'typo']) {
  test(`REST and WebSocket require credentials when flag is ${String(value)}`, async () => {
    const auth = loadAuth(value);
    assert.equal(auth.authenticateWebSocket(null), null);
    assert.equal(auth.authenticateWebSocket('valid-token').userId, 1);
    let status;
    const res = { status(code) { status = code; return this; }, json() {} };
    await auth.authenticateToken({ headers: {}, query: {} }, res, () => assert.fail('Anonymous REST request accepted'));
    assert.equal(status, 401);
    let accepted = false;
    await auth.authenticateToken({ headers: { authorization: 'Bearer valid-token' }, query: {} }, res, () => { accepted = true; });
    assert.equal(accepted, true);
  });
}

for (const value of ['1', 'true']) {
  test(`Explicit bypass remains supported for ${value}`, () => {
    assert.equal(loadAuth(value).authenticateWebSocket(null).userId, 1);
  });
}
