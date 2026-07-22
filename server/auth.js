'use strict';
// Single shared password (scrypt) + opaque session tokens. The DB stores only
// sha256(token); the cookie holds the raw token. No framework: cookie parsing
// and serialization are the ~10 lines they actually are. (Byte-sibling of the
// SNMPCanvas/SyslogCanvas auth module.)

const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_TTL_S = 30 * 24 * 3600;       // 30 days, sliding
const SESSION_REFRESH_S = 15 * 24 * 3600;   // refresh when less than this remains
// Namespaced per app: cookies ignore ports, so the Canvas apps on the same
// host (the obvious suite deployment) would clobber each other's sessions if
// they all used a generic name.
const COOKIE_NAME = 'alertc_session';

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
    return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    try {
        const [scheme, params, saltB64, hashB64] = stored.split('$');
        if (scheme !== 'scrypt') return false;
        const opts = {};
        for (const kv of params.split(',')) {
            const [k, v] = kv.split('=');
            opts[k === 'N' ? 'N' : k] = parseInt(v, 10);
        }
        const expected = Buffer.from(hashB64, 'base64');
        const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, opts);
        return crypto.timingSafeEqual(actual, expected);
    } catch (_) {
        return false;
    }
}

function passwordIsSet() { return getSetting('password') !== null; }
function setPassword(password) { setSetting('password', hashPassword(password)); }
function checkPassword(password) {
    const stored = getSetting('password');
    return stored !== null && verifyPassword(password, stored);
}

// Seed from env on first boot so a compose file can pre-set the password.
function seedFromEnv() {
    if (!passwordIsSet() && process.env.ADMIN_PASSWORD) setPassword(process.env.ADMIN_PASSWORD);
}

// --- sessions ---
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO sessions (token_hash, created_ts, expires_ts) VALUES (?, ?, ?)')
        .run(sha256(token), now, now + SESSION_TTL_S);
    return token;
}

function validateSession(token) {
    if (!token) return false;
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare('SELECT token_hash, expires_ts FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!row || row.expires_ts <= now) return false;
    if (row.expires_ts - now < SESSION_REFRESH_S) {
        db.prepare('UPDATE sessions SET expires_ts = ? WHERE token_hash = ?').run(now + SESSION_TTL_S, row.token_hash);
    }
    return true;
}

function destroySession(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// After a password change: every session except the one making the change.
function destroyOtherSessions(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(sha256(token));
    else db.prepare('DELETE FROM sessions').run();
}

function pruneSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_ts <= ?').run(Math.floor(Date.now() / 1000));
}

// --- cookies ---
function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            // A malformed value (Cookie: x=%) makes decodeURIComponent throw;
            // skip the pair rather than let it take down the request.
            try { out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim()); }
            catch (_) { /* ignore undecodable cookie */ }
        }
    }
    return out;
}

function sessionCookie(token) {
    const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secure}`;
}
function clearCookie() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
function tokenFromRequest(req) {
    return parseCookies(req)[COOKIE_NAME] || null;
}

// --- login rate limiting (in-memory, per source IP) ---
const failures = new Map(); // ip -> { count, lockedUntil }
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;

function loginAllowed(ip) {
    const f = failures.get(ip);
    if (!f) return true;
    if (f.lockedUntil && f.lockedUntil <= Date.now()) { failures.delete(ip); return true; }
    return !f.lockedUntil;
}
function recordLoginFailure(ip) {
    // Keyed by client IP (or the XFF value under TRUST_PROXY), so the map is
    // attacker-growable - sweep expired entries before it matters.
    if (failures.size > 10000) {
        const now = Date.now();
        for (const [k, v] of failures) {
            if (!v.lockedUntil || v.lockedUntil <= now) failures.delete(k);
        }
    }
    const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
    f.count++;
    if (f.count >= MAX_FAILURES) { f.count = 0; f.lockedUntil = Date.now() + LOCKOUT_MS; }
    failures.set(ip, f);
}
function recordLoginSuccess(ip) { failures.delete(ip); }


// --- suite single sign-on (LaunchCanvas) ---
// Opt-in via SUITE_SECRET (the same value set on the LaunchCanvas portal):
// a valid portal token arriving on any request upgrades to a normal local
// session transparently. No secret configured = this path is inert.
// Token: base64url(JSON {u,iat,exp}) "." base64url(hmac_sha256(payload)).
// Logout here stays local on purpose: with a live portal token the next
// request signs back in - that is the SSO contract; suite-wide logout (and
// revocation, by rotating SUITE_SECRET) lives at the portal.
const SUITE_COOKIE = 'canvas_suite';

function verifySuiteToken(req) {
    const secret = process.env.SUITE_SECRET;
    if (!secret) return null;
    const token = parseCookies(req)[SUITE_COOKIE];
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    try {
        const payload = Buffer.from(token.slice(0, dot), 'base64url');
        const sig = Buffer.from(token.slice(dot + 1), 'base64url');
        const expect = crypto.createHmac('sha256', secret).update(payload).digest();
        if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
        const claims = JSON.parse(payload.toString('utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (!claims || typeof claims.u !== 'string' || !(Number(claims.exp) > now)) return null;
        return claims;
    } catch (_) {
        return null;
    }
}

// Session check with the transparent SSO upgrade, for any request path that
// can still set a cookie on the response.
function authenticate(req, res) {
    if (validateSession(tokenFromRequest(req))) return true;
    if (!verifySuiteToken(req)) return false;
    const token = createSession();
    res.setHeader('Set-Cookie', sessionCookie(token));
    return true;
}

module.exports = {
    passwordIsSet, setPassword, checkPassword, seedFromEnv,
    createSession, validateSession, destroySession, destroyOtherSessions, pruneSessions,
    sessionCookie, clearCookie, tokenFromRequest,
    loginAllowed, recordLoginFailure, recordLoginSuccess,
    authenticate
};
