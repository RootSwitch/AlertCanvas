'use strict';
// All /api/* handlers. Routes are (method, regex) pairs dispatched by
// server.js; bodies are JSON in and JSON out. Mutating routes require
// Content-Type: application/json (cross-site forms can't send it - CSRF belt
// on top of the SameSite=Lax cookie).

const { db, DATA_DIR, getSetting, setSetting, setSmtpPassword } = require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const notify = require('./notify');
const smtp = require('./smtp');
const syslogOut = require('./syslog-out');
const rules = require('./rules');

// --- tiny helpers ---
function json(res, status, body) {
    const buf = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
}
const ok = (res, body = { ok: true }) => json(res, 200, body);
const bad = (res, msg) => json(res, 400, { error: msg });
const notFound = (res) => json(res, 404, { error: 'not found' });

function clientIp(req) {
    // Honor X-Forwarded-For ONLY when the operator asserts a trusted proxy via
    // TRUST_PROXY=1; otherwise a client could spoof it to evade the login
    // limiter or lock out an arbitrary IP.
    if (process.env.TRUST_PROXY === '1') {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) { return first; }
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

// Threshold objects arrive as {kind: null | {warn, crit}}. Normalize and
// reject anything that isn't a number-or-null pair.
function cleanLevels(v, name) {
    if (v === null) return null;
    if (typeof v !== 'object') throw new Error(`${name}: expected null or {warn, crit}`);
    const out = {};
    for (const level of ['warn', 'crit']) {
        const x = v[level];
        if (x === null || x === undefined || x === '') { out[level] = null; continue; }
        const n = num(x);
        if (Number.isNaN(n)) throw new Error(`${name}.${level}: not a number`);
        out[level] = n;
    }
    if (out.warn == null && out.crit == null) return null;
    return out;
}

function cleanBoolRule(v, name) {
    if (typeof v !== 'object' || v === null) throw new Error(`${name}: expected {enabled, severity}`);
    const severity = v.severity === 'warn' ? 'warn' : 'crit';
    return { enabled: !!v.enabled, severity };
}

const OVERRIDE_KINDS = [...rules.METRIC_KINDS, 'if-down', 'if-errors', 'if-discards', 'if-util', 'device-down'];
const BOOL_KINDS = ['if-down', 'device-down'];

function overrideFromBody(body) {
    const scope = body.scope === 'host-kind' ? 'host-kind' : 'code';
    const kind = String(body.kind || '');
    if (!OVERRIDE_KINDS.includes(kind)) throw new Error(`unknown kind "${kind}"`);
    const code = scope === 'code' ? String(body.code || '').trim() : null;
    const host = scope === 'host-kind' ? String(body.host || '').trim() : null;
    if (scope === 'code' && !code) throw new Error('code is required');
    if (scope === 'host-kind' && !host) throw new Error('host is required');
    if (kind === 'device-down' && scope !== 'host-kind') throw new Error('device-down overrides are per host');
    const levels = BOOL_KINDS.includes(kind) ? null : cleanLevels(
        { warn: body.warn, crit: body.crit }, 'levels');
    return {
        scope, code, host, kind,
        warn: levels ? levels.warn : null,
        crit: levels ? levels.crit : null,
        severity: BOOL_KINDS.includes(kind) ? (body.severity === 'warn' ? 'warn' : 'crit') : null,
        enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
        note: body.note ? String(body.note).slice(0, 200) : null
    };
}

function alertSummary(a) {
    return {
        id: a.id, key: a.alert_key, state: a.state, severity: a.severity,
        kind: a.kind, host: a.host, code: a.code, label: a.label,
        value: a.value, peakValue: a.peak_value, threshold: a.threshold, unit: a.unit,
        breachCount: a.breach_count, clearCount: a.clear_count,
        firstBreachTs: a.first_breach_ts, raisedTs: a.raised_ts, clearedTs: a.cleared_ts,
        ackedTs: a.acked_ts, clearReason: a.clear_reason,
        notifiedRaise: !!a.notified_raise, notifiedClear: !!a.notified_clear
    };
}

const SETTING_KEYS = {
    statusFile: 'status_file',
    scanIntervalS: 'scan_interval_s', raiseScans: 'raise_scans', clearScans: 'clear_scans',
    staleAfterS: 'stale_after_s', missingScansToClear: 'missing_scans_to_clear',
    renotifyIntervalS: 'renotify_interval_s', retentionDays: 'retention_days',
    emailEnabled: 'email_enabled', smtpHost: 'smtp_host', smtpPort: 'smtp_port',
    smtpMode: 'smtp_mode', smtpUser: 'smtp_user', smtpAllowSelfSigned: 'smtp_allow_self_signed',
    smtpFrom: 'smtp_from', smtpTo: 'smtp_to',
    syslogEnabled: 'syslog_enabled', syslogHost: 'syslog_host', syslogPort: 'syslog_port',
    syslogFacility: 'syslog_facility',
    syslogSevCrit: 'syslog_sev_crit', syslogSevWarn: 'syslog_sev_warn', syslogSevClear: 'syslog_sev_clear',
    tmplSubjectRaise: 'tmpl_subject_raise', tmplBodyRaise: 'tmpl_body_raise',
    tmplSubjectClear: 'tmpl_subject_clear', tmplBodyClear: 'tmpl_body_clear',
    tmplSyslogRaise: 'tmpl_syslog_raise', tmplSyslogClear: 'tmpl_syslog_clear'
};

// key -> [min, max] for integer settings; strings pass through.
const INT_RANGE = {
    // Feed data only changes at SNMPCanvas's poll cadence (its own minimum is
    // 30 s), so scanning faster than 30 s just re-reads an unchanged file.
    scan_interval_s: [30, 86400], raise_scans: [1, 50], clear_scans: [1, 50],
    stale_after_s: [0, 7 * 86400], missing_scans_to_clear: [1, 1000],
    renotify_interval_s: [0, 30 * 86400], retention_days: [1, 3650],
    smtp_port: [1, 65535], syslog_port: [1, 65535], syslog_facility: [0, 23],
    syslog_sev_crit: [0, 7], syslog_sev_warn: [0, 7], syslog_sev_clear: [0, 7]
};
const BOOL_KEYS = new Set(['email_enabled', 'syslog_enabled', 'smtp_allow_self_signed']);
const SCAN_KEYS = new Set(['status_file', 'scan_interval_s']);

// --- route table ---
// handler(req, res, params, body, query). `authRequired: false` routes are public.
const routes = [
    { method: 'GET', path: /^\/api\/health$/, authRequired: false, handler: (req, res) => ok(res, { ok: true, version: require('../package.json').version }) },

    { method: 'GET', path: /^\/api\/session$/, authRequired: false, handler: (req, res) => {
        const authed = auth.validateSession(auth.tokenFromRequest(req));
        ok(res, { authenticated: authed, needsSetup: !auth.passwordIsSet() });
    } },

    { method: 'POST', path: /^\/api\/setup$/, authRequired: false, handler: (req, res, p, body) => {
        if (auth.passwordIsSet()) return json(res, 409, { error: 'already configured' });
        if (!body.password || String(body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
        auth.setPassword(String(body.password));
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/login$/, authRequired: false, handler: (req, res, p, body) => {
        const ip = clientIp(req);
        if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'Too many attempts - wait a minute.' });
        if (!auth.checkPassword(String(body.password || ''))) {
            auth.recordLoginFailure(ip);
            return json(res, 401, { error: 'Wrong password.' });
        }
        auth.recordLoginSuccess(ip);
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/logout$/, authRequired: false, handler: (req, res) => {
        auth.destroySession(auth.tokenFromRequest(req));
        res.setHeader('Set-Cookie', auth.clearCookie());
        ok(res);
    } },

    // --- alerting state ---
    { method: 'GET', path: /^\/api\/status$/, handler: (req, res) => {
        ok(res, scanner.getStatus());
    } },

    { method: 'GET', path: /^\/api\/alerts$/, handler: (req, res) => {
        const open = db.prepare(
            `SELECT * FROM alerts WHERE state != 'cleared'
             ORDER BY CASE severity WHEN 'crit' THEN 0 ELSE 1 END,
                      COALESCE(raised_ts, first_breach_ts) DESC`).all();
        ok(res, { alerts: open.map(alertSummary) });
    } },

    { method: 'GET', path: /^\/api\/alerts\/history$/, handler: (req, res, p, body, query) => {
        const limit = Math.min(500, Math.max(1, parseInt(query.get('limit') || '100', 10) || 100));
        const before = parseInt(query.get('before') || '0', 10);
        const rows = before > 0
            ? db.prepare("SELECT * FROM alerts WHERE state = 'cleared' AND cleared_ts < ? ORDER BY cleared_ts DESC LIMIT ?").all(before, limit)
            : db.prepare("SELECT * FROM alerts WHERE state = 'cleared' ORDER BY cleared_ts DESC LIMIT ?").all(limit);
        ok(res, { alerts: rows.map(alertSummary) });
    } },

    { method: 'POST', path: /^\/api\/alerts\/(\d+)\/ack$/, handler: (req, res, params) => {
        const r = db.prepare("UPDATE alerts SET acked_ts = ? WHERE id = ? AND state != 'cleared'")
            .run(Math.floor(Date.now() / 1000), parseInt(params[0], 10));
        if (r.changes === 0) return notFound(res);
        ok(res);
    } },

    // What the feed currently carries - powers the overrides picker and the
    // "what am I watching" view.
    { method: 'GET', path: /^\/api\/sources$/, handler: (req, res) => {
        const doc = scanner.getSnapshot();
        if (!doc) return ok(res, { available: false, interfaces: [], metrics: [] });
        ok(res, {
            available: true,
            generatedAt: doc.generatedAt || null,
            interfaces: (doc.interfaces || []).map((i) => ({
                code: i.code, id: i.id, host: (i.device && i.device.name) || null,
                name: i.name, alias: i.alias || '', operStatus: i.operStatus,
                deviceStatus: (i.device && i.device.status) || null, speedBps: i.speedBps
            })),
            metrics: (doc.metrics || []).map((m) => ({
                code: m.code, kind: m.kind, host: m.host, display: m.display,
                value: m.value, unit: m.unit || ''
            }))
        });
    } },

    // --- overrides ---
    { method: 'GET', path: /^\/api\/overrides$/, handler: (req, res) => {
        ok(res, { overrides: db.prepare('SELECT * FROM overrides ORDER BY host, code, kind').all()
            .map((o) => ({ ...o, enabled: !!o.enabled })) });
    } },

    { method: 'POST', path: /^\/api\/overrides$/, handler: (req, res, p, body) => {
        let o;
        try { o = overrideFromBody(body); } catch (err) { return bad(res, err.message); }
        try {
            const info = db.prepare(
                `INSERT INTO overrides (scope, code, host, kind, warn, crit, severity, enabled, note)
                 VALUES (@scope, @code, @host, @kind, @warn, @crit, @severity, @enabled, @note)`).run(o);
            ok(res, { id: info.lastInsertRowid });
        } catch (err) {
            if (String(err.message).includes('UNIQUE')) return json(res, 409, { error: 'An override for that target already exists.' });
            throw err;
        }
    } },

    { method: 'PATCH', path: /^\/api\/overrides\/(\d+)$/, handler: (req, res, params, body) => {
        const id = parseInt(params[0], 10);
        const row = db.prepare('SELECT * FROM overrides WHERE id = ?').get(id);
        if (!row) return notFound(res);
        let o;
        try { o = overrideFromBody({ ...row, ...body, scope: row.scope, kind: row.kind, code: row.code, host: row.host }); }
        catch (err) { return bad(res, err.message); }
        db.prepare('UPDATE overrides SET warn=@warn, crit=@crit, severity=@severity, enabled=@enabled, note=@note WHERE id=@id')
            .run({ ...o, id });
        ok(res);
    } },

    { method: 'DELETE', path: /^\/api\/overrides\/(\d+)$/, handler: (req, res, params) => {
        const r = db.prepare('DELETE FROM overrides WHERE id = ?').run(parseInt(params[0], 10));
        if (r.changes === 0) return notFound(res);
        ok(res);
    } },

    // --- settings ---
    { method: 'GET', path: /^\/api\/settings$/, handler: (req, res) => {
        const out = {};
        for (const [name, key] of Object.entries(SETTING_KEYS)) {
            const v = getSetting(key);
            out[name] = INT_RANGE[key] ? parseInt(v, 10) : BOOL_KEYS.has(key) ? v === '1' : v;
        }
        let thresholds, ifRules, deviceDown;
        try { thresholds = JSON.parse(getSetting('thresholds')); } catch (_) { thresholds = {}; }
        try { ifRules = JSON.parse(getSetting('if_rules')); } catch (_) { ifRules = {}; }
        try { deviceDown = JSON.parse(getSetting('device_down')); } catch (_) { deviceDown = {}; }
        ok(res, {
            ...out, thresholds, ifRules, deviceDown,
            smtpPassSet: !!getSetting('smtp_pass'),
            dataDir: DATA_DIR,
            credentialEncryption: !!process.env.ALERTCANVAS_SECRET
        });
    } },

    { method: 'PATCH', path: /^\/api\/settings$/, handler: (req, res, p, body) => {
        const changes = [];
        for (const [name, key] of Object.entries(SETTING_KEYS)) {
            if (body[name] === undefined) continue;
            let v = body[name];
            if (BOOL_KEYS.has(key)) v = v ? '1' : '0';
            else if (INT_RANGE[key]) {
                const n = parseInt(v, 10);
                const [lo, hi] = INT_RANGE[key];
                if (!Number.isFinite(n) || n < lo || n > hi) return bad(res, `${name} must be between ${lo} and ${hi}.`);
                v = String(n);
            } else {
                v = String(v);
                if (name.startsWith('tmpl') && v.length > 2000) return bad(res, `${name} is too long (2000 chars max).`);
                if (name === 'smtpMode' && !['none', 'starttls', 'tls'].includes(v)) return bad(res, 'smtpMode must be none, starttls, or tls.');
                if (name === 'statusFile' && !/\.json$/i.test(v.trim())) return bad(res, 'Status file path must end in .json');
                if (name === 'statusFile') v = v.trim();
            }
            changes.push([key, v]);
        }
        try {
            if (body.thresholds !== undefined) {
                const t = {};
                for (const kind of rules.METRIC_KINDS) {
                    t[kind] = body.thresholds[kind] === undefined ? null : cleanLevels(body.thresholds[kind], kind);
                }
                changes.push(['thresholds', JSON.stringify(t)]);
            }
            if (body.ifRules !== undefined) {
                const r = {
                    down: cleanBoolRule(body.ifRules.down || {}, 'ifRules.down'),
                    errors: cleanLevels(body.ifRules.errors ?? null, 'ifRules.errors'),
                    discards: cleanLevels(body.ifRules.discards ?? null, 'ifRules.discards'),
                    util: cleanLevels(body.ifRules.util ?? null, 'ifRules.util')
                };
                changes.push(['if_rules', JSON.stringify(r)]);
            }
            if (body.deviceDown !== undefined) {
                changes.push(['device_down', JSON.stringify(cleanBoolRule(body.deviceDown, 'deviceDown'))]);
            }
        } catch (err) { return bad(res, err.message); }

        for (const [key, v] of changes) setSetting(key, v);
        if (body.smtpPass !== undefined) setSmtpPassword(String(body.smtpPass));
        if (changes.some(([key]) => SCAN_KEYS.has(key))) scanner.restart();
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/settings\/password$/, handler: (req, res, p, body) => {
        if (!auth.checkPassword(String(body.current || ''))) return json(res, 401, { error: 'Current password is wrong.' });
        if (!body.next || String(body.next).length < 8) return bad(res, 'New password must be at least 8 characters.');
        auth.setPassword(String(body.next));
        ok(res);
    } },

    // --- notification tests + log ---
    { method: 'POST', path: /^\/api\/test\/email$/, handler: async (req, res, p, body) => {
        const r = await smtp.sendMail(
            '[AlertCanvas] test message',
            'This is a test from AlertCanvas. If you can read this, SMTP settings work.\n\n-- AlertCanvas',
            {
                host: body.host, port: body.port, mode: body.mode, user: body.user,
                pass: body.pass, from: body.from, to: body.to, allowSelfSigned: body.allowSelfSigned ? '1' : '0'
            });
        notify.record(null, 'email', 'test', r.ok, r.detail);
        ok(res, r);
    } },

    { method: 'POST', path: /^\/api\/test\/syslog$/, handler: async (req, res, p, body) => {
        const r = await syslogOut.send('test', { severity: 'warn', kind: 'test', host: null, code: null },
            'AlertCanvas syslog test message',
            { host: body.host, port: body.port, facility: body.facility });
        notify.record(null, 'syslog', 'test', r.ok, r.detail);
        ok(res, r);
    } },

    { method: 'GET', path: /^\/api\/notifications$/, handler: (req, res, p, body, query) => {
        const limit = Math.min(500, Math.max(1, parseInt(query.get('limit') || '50', 10) || 50));
        const rows = db.prepare(
            `SELECT n.*, a.label AS alert_label FROM notifications n
             LEFT JOIN alerts a ON a.id = n.alert_id
             ORDER BY n.id DESC LIMIT ?`).all(limit);
        ok(res, { notifications: rows.map((n) => ({
            id: n.id, alertId: n.alert_id, alertLabel: n.alert_label,
            channel: n.channel, event: n.event, ts: n.ts, ok: !!n.ok, detail: n.detail
        })) });
    } }
];

// Dispatch. Returns false when no /api route matches (server.js then tries static).
async function handle(req, res, pathname, query) {
    for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.path.exec(pathname);
        if (!m) continue;

        if (route.authRequired !== false && !auth.validateSession(auth.tokenFromRequest(req))) {
            return json(res, 401, { error: 'authentication required' });
        }

        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
            const ct = String(req.headers['content-type'] || '');
            const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
            if (hasBody && !ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            if (hasBody) {
                try {
                    body = await readJson(req);
                } catch (err) {
                    return bad(res, err.message);
                }
            } else if (req.method !== 'DELETE') {
                if (!ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            }
        }
        try {
            await route.handler(req, res, m.slice(1), body, query);
        } catch (err) {
            console.error(new Date().toISOString(), '[api]', req.method, pathname, err);
            if (!res.headersSent) json(res, 500, { error: 'internal error' });
        }
        return true;
    }
    return false;
}

function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch (_) { reject(new Error('invalid JSON')); }
        });
        req.on('error', reject);
    });
}

module.exports = { handle };
