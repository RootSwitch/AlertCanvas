'use strict';
// The scan loop: read snmp-status.json, evaluate rules, walk every alert
// through the pending -> active -> clearing -> cleared state machine, and
// hand raise/clear/escalate events to notify.js. All state lives in SQLite,
// so a container restart mid-alert never re-notifies.

const fs = require('node:fs');
const { db, getSetting, DEFAULT_THRESHOLDS, DEFAULT_IF_RULES } = require('./db');
const rules = require('./rules');
const notify = require('./notify');
const auth = require('./auth');
const { fmtDuration } = require('./templates');

function log(...args) { console.log(new Date().toISOString(), '[scanner]', ...args); }
const nowS = () => Math.floor(Date.now() / 1000);

let timer = null;
let scanning = false;

// Last-scan snapshot for /api/status and /api/sources.
let lastScan = { ts: null, ok: false, error: 'not scanned yet', feed: null };
let lastDoc = null;

function intSetting(key, dflt) {
    const v = parseInt(getSetting(key), 10);
    return Number.isFinite(v) ? v : dflt;
}

function jsonSetting(key, dflt) {
    try { return { ...dflt, ...JSON.parse(getSetting(key)) }; }
    catch (_) { return dflt; }
}

function readConfig() {
    return {
        thresholds: jsonSetting('thresholds', DEFAULT_THRESHOLDS),
        ifRules: jsonSetting('if_rules', DEFAULT_IF_RULES),
        deviceDown: jsonSetting('device_down', { enabled: true, severity: 'crit' }),
        overrides: db.prepare('SELECT * FROM overrides').all()
    };
}

// Read + judge the feed. Returns { ok, error, doc, generatedAt, ageSec, staleAfterS }.
function readFeed() {
    const file = getSetting('status_file');
    let raw, mtimeMs = null;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return { ok: false, error: `cannot read ${file}: ${err.code || err.message}`, doc: null };
    }
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (_) {
        return { ok: false, error: `${file} is not valid JSON`, doc: null };
    }
    // Valid JSON is not necessarily a feed: `null`, a string, or an array all
    // parse fine and would throw on property access further down - which must
    // surface as a watchdog alarm, never as a dead scan loop.
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { ok: false, error: `${file} is not a status document`, doc: null };
    }
    // Staleness: generatedAt is authoritative, but take the file mtime when it
    // is newer - a clock-skewed producer shouldn't flag a live feed stale.
    // Future-dated stamps are clamped to now, or a fast producer clock would
    // delay stale detection by exactly its skew after it stops writing.
    const genMs = Math.min(Date.parse(doc.generatedAt || doc.generated || ''), Date.now());
    const newestMs = Math.max(Number.isNaN(genMs) ? 0 : genMs, Math.min(mtimeMs || 0, Date.now()));
    const configured = intSetting('stale_after_s', 0);
    const feedInterval = Number(doc.pollIntervalSec) > 0 ? Number(doc.pollIntervalSec) : 30;
    const staleAfterS = configured > 0 ? configured : Math.max(3 * feedInterval, 120);
    const ageSec = newestMs > 0 ? Math.max(0, Math.round((Date.now() - newestMs) / 1000)) : null;
    if (ageSec == null) return { ok: false, error: 'feed has no parseable generatedAt', doc, staleAfterS };
    if (ageSec > staleAfterS) {
        return { ok: false, error: `feed is stale (${ageSec}s old, limit ${staleAfterS}s)`, doc, ageSec, staleAfterS, generatedAt: doc.generatedAt };
    }
    return { ok: true, doc, ageSec, staleAfterS, generatedAt: doc.generatedAt };
}

const stmts = {
    open: db.prepare("SELECT * FROM alerts WHERE state != 'cleared'"),
    insert: db.prepare(`INSERT INTO alerts (alert_key, state, severity, kind, host, code, label,
        value, peak_value, threshold, unit, breach_count, first_breach_ts, last_seen_ts)
        VALUES (@alert_key, 'pending', @severity, @kind, @host, @code, @label,
        @value, @value, @threshold, @unit, 1, @now, @now)`),
    delete: db.prepare('DELETE FROM alerts WHERE id = ?'),
    update: db.prepare(`UPDATE alerts SET state=@state, severity=@severity, label=@label,
        value=@value, peak_value=@peak_value, threshold=@threshold, unit=@unit,
        breach_count=@breach_count, clear_count=@clear_count, missing_count=@missing_count,
        raised_ts=@raised_ts, cleared_ts=@cleared_ts, last_seen_ts=@last_seen_ts,
        renotified_ts=@renotified_ts, clear_reason=@clear_reason,
        notified_raise=@notified_raise, notified_clear=@notified_clear,
        notify_attempts=@notify_attempts, last_attempt_ts=@last_attempt_ts
        WHERE id=@id`),
    get: db.prepare('SELECT * FROM alerts WHERE id = ?'),
    // Reboots are events, not states: the row is born already cleared (it
    // shows in History), and only the raise notification is sent.
    insertEvent: db.prepare(`INSERT INTO alerts (alert_key, state, severity, kind, host, code, label,
        value, peak_value, unit, breach_count, first_breach_ts, raised_ts, cleared_ts, last_seen_ts,
        clear_reason, notified_raise, notified_clear)
        VALUES (@alert_key, 'cleared', @severity, @kind, @host, @code, @label,
        @value, @peak_value, @unit, 1, @now, @now, @now, @now, 'event', 0, 1)`),
    uptimeAll: db.prepare('SELECT code, value FROM uptime_seen'),
    uptimeUpsert: db.prepare(`INSERT INTO uptime_seen (code, value, ts) VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET value = excluded.value, ts = excluded.ts`)
};

function saveRow(row) { stmts.update.run(row); }

// More-extreme-of for peak tracking; direction depends on the kind.
function peak(kind, a, b) {
    if (a == null) return b;
    if (b == null) return a;
    return rules.LOWER_IS_BAD.has(kind) ? Math.min(a, b) : Math.max(a, b);
}

// One scan. Runs the state machine in a transaction, then dispatches the
// collected events (network I/O stays outside the transaction).
async function tick() {
    if (scanning) return; // a slow SMTP retry outlived the interval - skip
    scanning = true;
    try {
        const now = nowS();
        const cfg = readConfig();
        const feed = readFeed();

        // Evaluation must never kill the scan loop: a feed entry with a shape
        // rules.js can't digest degrades to "feed bad" and rides the watchdog
        // machinery instead of aborting the tick before the watchdog exists.
        let conditions = [];
        if (feed.ok) {
            try {
                conditions = rules.evaluate(feed.doc, cfg);
            } catch (err) {
                feed.ok = false;
                feed.error = `feed shape not understood: ${err.message}`;
                conditions = [];
            }
        }

        if (feed.doc) lastDoc = feed.doc;
        lastScan = {
            ts: now, ok: feed.ok, error: feed.ok ? null : feed.error,
            feed: { generatedAt: feed.generatedAt || null, ageSec: feed.ageSec ?? null, staleAfterS: feed.staleAfterS ?? null }
        };

        const raiseScans = Math.max(1, intSetting('raise_scans', 2));
        const clearScans = Math.max(1, intSetting('clear_scans', 2));
        const missingScans = Math.max(1, intSetting('missing_scans_to_clear', 20));
        // Heartbeat for the UI: what the last successful scan actually saw,
        // so "all quiet" is distinguishable from "not looking".
        if (feed.ok) {
            const devices = new Set();
            for (const i of feed.doc.interfaces || []) devices.add((i.device && i.device.name) || String(i.id || '').split(':')[0]);
            for (const m of feed.doc.metrics || []) devices.add(m.host);
            lastScan.watching = {
                metrics: (feed.doc.metrics || []).length,
                interfaces: (feed.doc.interfaces || []).length,
                devices: devices.size,
                rules: conditions.length
            };
        } else {
            lastScan.watching = null;
        }
        conditions.push({
            key: 'watchdog:feed', severity: feed.ok ? null : 'crit', frozen: false,
            kind: 'watchdog', host: null, code: null,
            label: feed.ok ? 'status feed' : `status feed - ${feed.error}`,
            value: null, threshold: null, unit: ''
        });

        const events = []; // { type, id }

        // Reboot detection: compare exported uptime values against the last
        // scan's. Detected events become already-cleared history rows with a
        // single raise notification (they are moments, not ongoing states).
        if (feed.ok) {
            const prev = new Map(stmts.uptimeAll.all().map((r) => [r.code, r.value]));
            const reboots = rules.detectReboots(prev, feed.doc.metrics);
            db.transaction(() => {
                for (const m of feed.doc.metrics || []) {
                    // Only real numbers are remembered (Number(null) === 0):
                    // an unreadable uptime must neither store 0 nor look
                    // like a reboot.
                    if (m && m.kind === 'uptime' && m.code &&
                        typeof m.value === 'number' && Number.isFinite(m.value)) {
                        stmts.uptimeUpsert.run(m.code, m.value, now);
                    }
                }
                if (getSetting('reboot_detect') === '1') {
                    const severity = getSetting('reboot_severity') === 'crit' ? 'crit' : 'warn';
                    for (const ev of reboots) {
                        const info = stmts.insertEvent.run({
                            alert_key: `reboot:${ev.code}`, severity, kind: 'reboot',
                            host: ev.host, code: ev.code,
                            label: `${ev.host} rebooted (uptime ${fmtDuration(ev.from)} -> ${fmtDuration(ev.to)})`,
                            value: Math.round(ev.to), peak_value: Math.round(ev.from), unit: 's', now
                        });
                        events.push({ type: 'raise', id: info.lastInsertRowid });
                    }
                }
            })();
        }

        db.transaction(() => {
            const open = new Map();
            for (const row of stmts.open.all()) open.set(row.alert_key, row);

            for (const c of conditions) {
                const row = open.get(c.key);
                open.delete(c.key);

                if (c.frozen) {
                    // No usable reading: keep the alert exactly where it is,
                    // but count it as "seen" so it isn't treated as removed.
                    if (row) { row.missing_count = 0; row.last_seen_ts = now; saveRow(row); }
                    continue;
                }

                if (c.severity) {
                    if (!row) {
                        const info = stmts.insert.run({
                            alert_key: c.key, severity: c.severity, kind: c.kind, host: c.host,
                            code: c.code, label: c.label, value: c.value, threshold: c.threshold,
                            unit: c.unit, now
                        });
                        const fresh = stmts.get.get(info.lastInsertRowid);
                        if (fresh.breach_count >= raiseScans) {
                            fresh.state = 'active'; fresh.raised_ts = now;
                            saveRow(fresh);
                            events.push({ type: 'raise', id: fresh.id });
                        }
                        continue;
                    }
                    // Severity is STICKY at the worst level once an alert has
                    // been raised: a bouncy metric straddling the crit line
                    // must not downgrade-then-"escalate" on every wobble (one
                    // GPU inference run = one escalate, not one per scan).
                    // History then records the incident's true worst. Pending
                    // alerts still track the live severity - nothing has been
                    // sent yet, so raising at the current level is honest.
                    const wasSeverity = row.severity;
                    const sticky = row.state !== 'pending' && wasSeverity === 'crit' && c.severity !== 'crit';
                    row.severity = sticky ? 'crit' : c.severity;
                    row.label = c.label;
                    row.value = c.value;
                    row.peak_value = peak(c.kind, row.peak_value, c.value);
                    // The threshold sticks WITH the severity - a crit incident
                    // must show the crit limit it crossed, not the warn limit
                    // the value happens to sit above right now.
                    row.threshold = sticky ? row.threshold : c.threshold;
                    row.unit = c.unit;
                    row.missing_count = 0;
                    row.last_seen_ts = now;
                    if (row.state === 'pending') {
                        row.breach_count += 1;
                        if (row.breach_count >= raiseScans) {
                            row.state = 'active'; row.raised_ts = now;
                            saveRow(row);
                            events.push({ type: 'raise', id: row.id });
                            continue;
                        }
                    } else {
                        if (row.state === 'clearing') { row.state = 'active'; row.clear_count = 0; }
                        if (wasSeverity === 'warn' && c.severity === 'crit') {
                            saveRow(row);
                            events.push({ type: 'escalate', id: row.id });
                            continue;
                        }
                    }
                    saveRow(row);
                    continue;
                }

                // normal reading
                if (!row) continue;
                row.missing_count = 0;
                row.last_seen_ts = now;
                if (row.state === 'pending') { stmts.delete.run(row.id); continue; }
                if (row.state === 'active') { row.state = 'clearing'; row.clear_count = 1; }
                else if (row.state === 'clearing') { row.clear_count += 1; }
                if (c.value != null) { row.value = c.value; }
                if (row.state === 'clearing' && row.clear_count >= clearScans) {
                    row.state = 'cleared'; row.cleared_ts = now; row.clear_reason = 'normal';
                    saveRow(row);
                    events.push({ type: 'clear', id: row.id });
                    continue;
                }
                saveRow(row);
            }

            // Anything still open but absent from the feed: the source was
            // un-exported or renamed. Freeze while the feed itself is bad.
            if (feed.ok) {
                for (const row of open.values()) {
                    row.missing_count += 1;
                    if (row.missing_count >= missingScans) {
                        if (row.state === 'pending') { stmts.delete.run(row.id); continue; }
                        row.state = 'cleared'; row.cleared_ts = now; row.clear_reason = 'source-removed';
                        saveRow(row);
                        events.push({ type: 'clear', id: row.id });
                        continue;
                    }
                    saveRow(row);
                }
            }
        })();

        for (const ev of events) await dispatchEvent(ev.type, ev.id, now);
        await retryPass(now);
        await renotifyPass(now);
        prunePass(now);
    } catch (err) {
        log('scan failed:', err);
        lastScan = { ts: nowS(), ok: false, error: `scan error: ${err.message}`, feed: null };
    } finally {
        scanning = false;
    }
}

async function dispatchEvent(type, id, now) {
    const row = stmts.get.get(id);
    if (!row) return;
    const { emailOk } = await notify.dispatch(type, row);
    if (type === 'raise' || type === 'escalate' || type === 'renotify') {
        row.notified_raise = emailOk ? 1 : 0;
    } else if (type === 'clear') {
        row.notified_clear = emailOk ? 1 : 0;
    }
    row.notify_attempts = emailOk ? 0 : (row.notify_attempts || 0) + 1;
    row.last_attempt_ts = now;
    if (type === 'renotify') row.renotified_ts = now;
    saveRow(stmtsSafe(row));
}

// The dispatch path re-saves a row it read before await; re-read counters that
// the transaction owns so a concurrent tick can't be clobbered. (Scans are
// serialized by the `scanning` flag, so in practice this is belt-and-braces.)
function stmtsSafe(row) {
    const current = stmts.get.get(row.id);
    if (!current) return row;
    return {
        ...current,
        notified_raise: row.notified_raise, notified_clear: row.notified_clear,
        notify_attempts: row.notify_attempts, last_attempt_ts: row.last_attempt_ts,
        renotified_ts: row.renotified_ts ?? current.renotified_ts
    };
}

const backoffS = (attempts) => Math.min(60 * 2 ** Math.max(0, attempts - 1), 900);

// Email failed earlier: retry with capped backoff until it lands. Event rows
// (reboots, born cleared with only a raise owed) retry their raise the same
// way - a host's one reboot notification must not die on an SMTP hiccup.
async function retryPass(now) {
    if (getSetting('email_enabled') !== '1') return;
    const raiseRetries = db.prepare(
        "SELECT * FROM alerts WHERE state = 'active' AND notified_raise = 0").all();
    const clearRetries = db.prepare(
        "SELECT * FROM alerts WHERE state = 'cleared' AND notified_clear = 0 AND cleared_ts > ?")
        .all(now - 86400);
    const eventRetries = db.prepare(
        "SELECT * FROM alerts WHERE state = 'cleared' AND clear_reason = 'event' AND notified_raise = 0 AND cleared_ts > ?")
        .all(now - 86400);
    for (const row of [...raiseRetries, ...eventRetries]) {
        if (row.last_attempt_ts && now - row.last_attempt_ts < backoffS(row.notify_attempts)) continue;
        await dispatchEvent('raise', row.id, now);
    }
    for (const row of clearRetries) {
        if (row.last_attempt_ts && now - row.last_attempt_ts < backoffS(row.notify_attempts)) continue;
        await dispatchEvent('clear', row.id, now);
    }
}

// Optional reminder for long-running unacked alerts.
async function renotifyPass(now) {
    const interval = intSetting('renotify_interval_s', 0);
    if (interval <= 0) return;
    const due = db.prepare(
        `SELECT * FROM alerts WHERE state = 'active' AND notified_raise = 1 AND acked_ts IS NULL
         AND COALESCE(renotified_ts, raised_ts) <= ?`).all(now - interval);
    for (const row of due) await dispatchEvent('renotify', row.id, now);
}

// Housekeeping about once a day: cleared-alert + notification retention,
// expired sessions.
let lastPrune = 0;
function prunePass(now) {
    if (now - lastPrune < 86400) return;
    lastPrune = now;
    const days = Math.max(1, intSetting('retention_days', 90));
    const cutoff = now - days * 86400;
    const a = db.prepare("DELETE FROM alerts WHERE state = 'cleared' AND cleared_ts < ?").run(cutoff);
    const n = db.prepare('DELETE FROM notifications WHERE ts < ?').run(cutoff);
    auth.pruneSessions();
    if (a.changes || n.changes) log(`pruned ${a.changes} cleared alerts, ${n.changes} notification rows`);
}

function schedule() {
    clearInterval(timer);
    const interval = Math.max(30, intSetting('scan_interval_s', 30));
    timer = setInterval(() => { tick(); }, interval * 1000);
}

function start() {
    schedule();
    tick();
    log(`watching ${getSetting('status_file')} every ${Math.max(30, intSetting('scan_interval_s', 30))}s`);
}

function stop() { clearInterval(timer); timer = null; }

// Settings changed (interval or file path): re-arm and scan now.
function restart() { schedule(); tick(); }

function getStatus() {
    const counts = { pending: 0, active: 0, clearing: 0 };
    for (const r of db.prepare("SELECT state, COUNT(*) AS n FROM alerts WHERE state != 'cleared' GROUP BY state").all()) {
        counts[r.state] = r.n;
    }
    const raised = counts.active + counts.clearing;
    const crits = raised === 0 ? 0 : db.prepare(
        "SELECT COUNT(*) AS n FROM alerts WHERE state IN ('active','clearing') AND severity = 'crit'").get().n;
    const silenceUntil = parseInt(getSetting('silence_until'), 10) || 0;
    return {
        worstActive: crits > 0 ? 'crit' : raised > 0 ? 'warn' : null,
        silenceUntil: silenceUntil > nowS() ? silenceUntil : 0,
        lastScanTs: lastScan.ts,
        lastScanOk: lastScan.ok,
        lastScanError: lastScan.error,
        feed: lastScan.feed,
        watching: lastScan.watching || null,
        counts,
        emailError: notify.getLastEmailError(),
        scanIntervalS: Math.max(30, intSetting('scan_interval_s', 30))
    };
}

function getSnapshot() { return lastDoc; }

module.exports = { start, stop, restart, tick, getStatus, getSnapshot, getConfig: readConfig };
