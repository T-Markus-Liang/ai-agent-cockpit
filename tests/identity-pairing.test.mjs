import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPairingAuthority, PairingError, ROLES, PAIRING_CODE_TTL_MS, PRINCIPAL_TTL_MS } from '../control-plane/identity-pairing.mjs';
import { createRequestAuthority } from '../control-plane/request-authority.mjs';

// Fully synthetic, deterministic harness. No production secrets or files.
function deterministicRandom() {
  let counter = 0;
  return size => {
    const buffer = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buffer[i] = (counter * 31 + i * 7 + 13) & 0xff;
    counter += 1;
    return buffer;
  };
}

function makeClock(start = 1_700_000_000_000) {
  let value = start;
  return { now: () => value, advance: ms => { value += ms; } };
}

function makeAuthority() {
  const clock = makeClock();
  const authority = createPairingAuthority({ now: clock.now, random: deterministicRandom() });
  return { authority, clock };
}

const isPairingDenied = error => error instanceof PairingError && error.code === 'pairing-denied';

test('1: normal pairing completes, authenticates and reports the requested role', () => {
  const { authority, clock } = makeAuthority();
  const { pairingCode, expiresAt } = authority.beginPairing({ role: 'chief', clientLabel: 'cli' });
  assert.equal(typeof pairingCode, 'string');
  assert.ok(pairingCode.length > 0);
  assert.equal(expiresAt, clock.now() + PAIRING_CODE_TTL_MS);
  const { principalId, token } = authority.completePairing(pairingCode);
  assert.match(principalId, /^p_[0-9a-f]{16}$/);
  assert.ok(token.length >= 32);
  const principal = authority.authenticate(token);
  assert.deepEqual(principal, { id: principalId, role: 'chief', clientLabel: 'cli' });
  assert.ok(Object.isFrozen(principal));
});

test('2: a pairing code is single-use', () => {
  const { authority } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'operator' });
  authority.completePairing(pairingCode);
  assert.throws(() => authority.completePairing(pairingCode), error => isPairingDenied(error) && error.reason === 'consumed');
});

test('3: an expired pairing code is denied', () => {
  const { authority, clock } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'viewer' });
  clock.advance(PAIRING_CODE_TTL_MS);
  assert.throws(() => authority.completePairing(pairingCode),
    error => isPairingDenied(error) && error.message.includes('expired') && !error.message.includes(pairingCode));
});

test('4: an unknown pairing code is denied', () => {
  const { authority } = makeAuthority();
  assert.throws(() => authority.completePairing('never-issued-code'),
    error => isPairingDenied(error) && error.reason === 'unknown');
});

test('5: an unknown role cannot begin pairing', () => {
  const { authority } = makeAuthority();
  assert.throws(() => authority.beginPairing({ role: 'admin' }), error => error.code === 'invalid-role');
  assert.deepEqual([...ROLES], ['operator', 'coordinator', 'chief', 'viewer']);
});

test('6: rotation invalidates the old token and activates the new one', () => {
  const { authority } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'coordinator' });
  const { principalId, token: first } = authority.completePairing(pairingCode);
  const { token: second } = authority.rotate(principalId);
  assert.notEqual(first, second);
  assert.equal(authority.authenticate(first), undefined);
  assert.deepEqual(authority.authenticate(second), { id: principalId, role: 'coordinator' });
});

test('7: revocation disables a principal; unknown ids are rejected', () => {
  const { authority } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'operator' });
  const { principalId, token } = authority.completePairing(pairingCode);
  authority.revoke(principalId);
  assert.equal(authority.authenticate(token), undefined);
  assert.throws(() => authority.revoke(principalId), error => error.code === 'unknown-principal');
  assert.throws(() => authority.revoke('p_deadbeefdeadbeef'), error => error.code === 'unknown-principal');
  assert.throws(() => authority.rotate('p_deadbeefdeadbeef'), error => error.code === 'unknown-principal');
});

test('8: an expired principal stops authenticating', () => {
  const { authority, clock } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'viewer' });
  const { token } = authority.completePairing(pairingCode);
  assert.ok(authority.authenticate(token));
  clock.advance(PRINCIPAL_TTL_MS);
  assert.equal(authority.authenticate(token), undefined);
});

test('9: exportPrincipals emits only active principals in request-authority shape', () => {
  const { authority, clock } = makeAuthority();
  const active = authority.completePairing(authority.beginPairing({ role: 'chief' }).pairingCode);
  const revoked = authority.completePairing(authority.beginPairing({ role: 'viewer' }).pairingCode);
  const expired = authority.completePairing(authority.beginPairing({ role: 'operator' }).pairingCode);
  authority.revoke(revoked.principalId);
  clock.advance(PRINCIPAL_TTL_MS); // expires active + expired (revoked stays revoked)

  const document = authority.exportPrincipals();
  assert.equal(document.version, 1);
  assert.deepEqual(Object.keys(document).sort(), ['principals', 'version']);
  assert.equal(document.principals.length, 0);
  for (const entry of document.principals) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'role', 'tokenDigest']);
    assert.match(entry.tokenDigest, /^[a-f0-9]{64}$/);
  }

  // A fresh authority with one live principal must be accepted verbatim.
  const live = authority.completePairing(authority.beginPairing({ role: 'chief' }).pairingCode);
  const single = authority.exportPrincipals();
  assert.equal(single.principals.length, 1);
  assert.equal(single.principals[0].id, live.principalId);
  assert.equal(single.principals[0].role, 'chief');
  const requestAuthority = createRequestAuthority(single); // throws if the shape is wrong
  assert.deepEqual(requestAuthority.authenticate({ authorization: `Bearer ${live.token}` }),
    { id: live.principalId, role: 'chief', authenticated: true });
});

test('10: a serialized snapshot round-trips authentication, roles, revocation and expiry', () => {
  const { authority, clock } = makeAuthority();
  const kept = authority.completePairing(authority.beginPairing({ role: 'chief', clientLabel: 'phone' }).pairingCode);
  const gone = authority.completePairing(authority.beginPairing({ role: 'coordinator' }).pairingCode);
  const snapshot = JSON.parse(JSON.stringify(authority.toJSON()));

  const restored = createPairingAuthority({ now: clock.now, random: deterministicRandom() });
  assert.equal(restored.fromJSON(snapshot), restored);
  assert.deepEqual(restored.authenticate(kept.token), { id: kept.principalId, role: 'chief', clientLabel: 'phone' });
  assert.deepEqual(restored.authenticate(gone.token), { id: gone.principalId, role: 'coordinator' });
  assert.deepEqual(restored.exportPrincipals(), authority.exportPrincipals());

  const rotated = restored.rotate(kept.principalId);
  assert.equal(restored.authenticate(kept.token), undefined);
  assert.ok(restored.authenticate(rotated.token));

  restored.revoke(gone.principalId);
  assert.equal(restored.authenticate(gone.token), undefined);
  assert.throws(() => restored.completePairing(authority.beginPairing({ role: 'viewer' }).pairingCode), isPairingDenied);

  clock.advance(PRINCIPAL_TTL_MS);
  assert.equal(restored.authenticate(rotated.token), undefined);
});

test('11: persisted state never contains plaintext tokens or pairing codes', () => {
  const { authority } = makeAuthority();
  const first = authority.beginPairing({ role: 'chief' });
  const minted = authority.completePairing(first.pairingCode);
  const second = authority.beginPairing({ role: 'viewer' });
  authority.completePairing(second.pairingCode);
  const rotated = authority.rotate(minted.principalId);

  const serialized = JSON.stringify(authority.toJSON());
  for (const secret of [first.pairingCode, second.pairingCode, minted.token, rotated.token]) {
    assert.equal(serialized.includes(secret), false);
  }
  // digests are present, in hex, so the snapshot is still actionable
  assert.match(authority.toJSON().principals[0].tokenDigest, /^[a-f0-9]{64}$/);
});

test('12: error messages never leak secrets and authenticate never throws', () => {
  const { authority, clock } = makeAuthority();
  const { pairingCode } = authority.beginPairing({ role: 'operator' });
  const { token } = authority.completePairing(pairingCode);

  const secrets = [pairingCode, token, 'SYNTHETIC_SECRET_PROBE'];

  const capture = fn => { try { fn(); return undefined; } catch (error) { return error; } };
  const denied = capture(() => authority.completePairing('SYNTHETIC_SECRET_PROBE'));
  assert.ok(isPairingDenied(denied));
  assert.equal(denied.message.includes('SYNTHETIC_SECRET_PROBE'), false);

  clock.advance(PAIRING_CODE_TTL_MS);
  const expiredReuse = capture(() => authority.completePairing(pairingCode)); // already consumed
  assert.ok(isPairingDenied(expiredReuse));

  for (const error of [denied, expiredReuse]) {
    for (const secret of secrets) assert.equal(error.message.includes(secret), false);
  }
  assert.throws(() => authority.beginPairing({ role: 'root' }), error =>
    error.code === 'invalid-role' && secrets.every(secret => !error.message.includes(secret)));

  for (const bad of [undefined, null, 42, '', 'not-a-token', token + 'x']) {
    assert.equal(authority.authenticate(bad), undefined);
  }
});

test('13: malformed snapshots fail closed with invalid-state', () => {
  const { authority } = makeAuthority();
  const valid = authority.toJSON();
  const cases = [
    null, 42, 'x', {}, { ...valid, version: 2 }, { version: 1, principals: 'nope' },
    { version: 1, consumedCodes: {}, principals: [] },
    { ...valid, extra: true },
    { version: 1, consumedCodes: ['not-a-digest'], principals: [] },
    { version: 1, consumedCodes: [], principals: [{ id: 'p_ab', role: 'invented', tokenDigest: crypto.createHash('sha256').update('x').digest('hex'), createdAt: 0, expiresAt: 1, revoked: false }] },
    { version: 1, consumedCodes: [], principals: [{ id: 'p_ab', role: 'chief', tokenDigest: 'bad', createdAt: 0, expiresAt: 1, revoked: false }] },
    { version: 1, consumedCodes: [], principals: [{ id: 'p_ab', role: 'chief', tokenDigest: crypto.createHash('sha256').update('x').digest('hex'), createdAt: 0, expiresAt: 1, revoked: 'no' }] },
  ];
  for (const bad of cases) {
    assert.throws(() => createPairingAuthority().fromJSON(bad), error => error.code === 'invalid-state');
  }
  // a well-formed empty snapshot is accepted
  assert.doesNotThrow(() => createPairingAuthority().fromJSON({ version: 1, consumedCodes: [], principals: [] }));
});
