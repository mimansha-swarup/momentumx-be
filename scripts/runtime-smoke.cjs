// Use real dependencies: mocked Firebase tests cannot catch runtime import failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { generateKeyPairSync } = require('node:crypto');

test('Firebase dependencies load and JWT signatures are verified', () => {
  const admin = require('firebase-admin');
  require('firebase-functions');
  assert.equal(typeof admin.initializeApp, 'function');
  const requireFromAdmin = createRequire(require.resolve('firebase-admin'));
  const jwt = requireFromAdmin('jsonwebtoken');
  assert.equal(typeof requireFromAdmin('google-auth-library').GoogleAuth, 'function');
  const secret = 'runtime-test-key-not-a-credential';
  const token = jwt.sign({ sub: 'runtime-test' }, secret, { algorithm: 'HS256' });
  assert.equal(jwt.verify(token, secret, { algorithms: ['HS256'] }).sub, 'runtime-test');
  assert.throws(() => jwt.verify(token, 'wrong-key', { algorithms: ['HS256'] }), /invalid signature/);
  assert.throws(() => jwt.verify(token, secret, { algorithms: ['RS256'] }), /invalid algorithm/);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signed = jwt.sign({ sub: 'runtime-test' }, privateKey, { algorithm: 'RS256' });
  assert.equal(jwt.verify(signed, publicKey, { algorithms: ['RS256'] }).sub, 'runtime-test');
  const parts = signed.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'tampered' })).toString('base64url');
  assert.throws(() => jwt.verify(parts.join('.'), publicKey, { algorithms: ['RS256'] }), /invalid signature/);
  const expired = jwt.sign({ sub: 'runtime-test', exp: 1 }, privateKey, { algorithm: 'RS256' });
  assert.throws(() => jwt.verify(expired, publicKey, { algorithms: ['RS256'] }), /jwt expired/);
});
