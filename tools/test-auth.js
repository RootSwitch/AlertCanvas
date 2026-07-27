'use strict';
// Auth regression: the password path went async (synchronous scrypt serialised
// concurrent logins into one event-loop stall), and the stored hash format must
// not have changed with it - a hash minted by the old synchronous code still
// has to verify. Plain node + assert, throwaway data dir.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ALERTCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'alertc-auth-'));
const auth = require('../server/auth');
const { setSetting } = require('../server/db');

(async () => {
    assert.strictEqual(auth.passwordIsSet(), false, 'fresh db has no password');
    assert.strictEqual(await auth.checkPassword('anything'), false, 'no password set: nothing verifies');

    await auth.setPassword('correct-horse-battery');
    assert.strictEqual(auth.passwordIsSet(), true);
    assert.strictEqual(await auth.checkPassword('correct-horse-battery'), true, 'round trip');
    assert.strictEqual(await auth.checkPassword('wrong-password-00'), false, 'wrong password rejected');

    // A hash minted by the pre-async code (scryptSync, same format string).
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync('legacy-pass-123', salt, 32, { N: 16384, r: 8, p: 1 });
    setSetting('password', `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${hash.toString('base64')}`);
    assert.strictEqual(await auth.checkPassword('legacy-pass-123'), true, 'legacy sync-minted hash verifies');
    assert.strictEqual(await auth.checkPassword('not-it'), false);

    // Garbage in the settings row must fail closed, not throw.
    setSetting('password', 'not-a-hash-at-all');
    assert.strictEqual(await auth.checkPassword('legacy-pass-123'), false, 'malformed stored hash fails closed');

    console.log('ok - auth async round trip, legacy hash compat, fail-closed');
    process.exit(0);
})().catch((err) => { console.error('FAIL:', err); process.exit(1); });
