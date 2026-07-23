'use strict';
// Pure threshold evaluation: (parsed snmp-status.json, config) -> conditions.
// No I/O, no DB, no clock - everything comes in as arguments so the whole
// alerting brain is testable with a JSON fixture.
//
// A "condition" is one watched thing on one scan:
//   { key, severity, frozen, kind, host, code, label, value, threshold, unit }
// severity: 'crit' | 'warn' | null (null = currently normal - the scanner
// needs normal readings too, to advance clear counters).
// frozen: true when the value is null/unreadable - no evidence either way,
// so the scanner advances neither breach nor clear counters.

// Kinds where a LOW value is the problem (battery %, runtime seconds,
// uptime seconds - a reboot shows as uptime collapsing).
const LOWER_IS_BAD = new Set(['battery', 'runtime', 'uptime']);

const METRIC_KINDS = ['cpu', 'mem', 'disk', 'temp', 'fan', 'power', 'util',
    'battery', 'runtime', 'outlet', 'uptime', 'meter', 'state'];

// config = {
//   thresholds:  { cpu: {warn,crit}|null, ... }          per-kind defaults
//   ifRules:     { down:{enabled,severity}, errors:{warn,crit}, discards:{...}, util:{...} }
//   deviceDown:  { enabled, severity }
//   overrides:   [ {scope, code, host, kind, warn, crit, severity, enabled} ]
// }

function buildOverrideIndex(overrides) {
    const byCode = new Map();     // `${code}|${kind}` -> override
    const byHostKind = new Map(); // `${host}|${kind}` -> override
    for (const o of overrides || []) {
        if (o.scope === 'code' && o.code) byCode.set(`${o.code}|${o.kind}`, o);
        else if (o.scope === 'host-kind' && o.host) byHostKind.set(`${o.host}|${o.kind}`, o);
    }
    return { byCode, byHostKind };
}

// Resolve the {warn, crit} pair for one leveled target, remembering WHERE the
// rule came from so the Watching page can show it. levels null = nothing to
// evaluate (muted, disabled, or no rule).
function resolveLevelsInfo(idx, defaults, code, host, kind) {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`);
    if (o) {
        const source = o.scope === 'code' ? 'override' : 'host override';
        if (!o.enabled) return { levels: null, source, muted: true };
        if (o.warn == null && o.crit == null) return { levels: null, source, muted: false };
        return { levels: { warn: o.warn, crit: o.crit }, source, muted: false };
    }
    if (!defaults || (defaults.warn == null && defaults.crit == null)) {
        return { levels: null, source: 'none', muted: false };
    }
    return { levels: { warn: defaults.warn ?? null, crit: defaults.crit ?? null }, source: 'default', muted: false };
}
function resolveLevels(idx, defaults, code, host, kind) {
    return resolveLevelsInfo(idx, defaults, code, host, kind).levels;
}

// Resolve a boolean rule (if-down, device-down) the same way.
function resolveBoolInfo(idx, defaults, code, host, kind) {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`);
    if (o) {
        const source = o.scope === 'code' ? 'override' : 'host override';
        if (!o.enabled) return { rule: null, source, muted: true };
        return { rule: { severity: o.severity || (defaults && defaults.severity) || 'crit' }, source, muted: false };
    }
    if (!defaults || !defaults.enabled) return { rule: null, source: 'none', muted: false };
    return { rule: { severity: defaults.severity || 'crit' }, source: 'default', muted: false };
}
function resolveBool(idx, defaults, code, host, kind) {
    return resolveBoolInfo(idx, defaults, code, host, kind).rule;
}

function levelSeverity(kind, value, levels) {
    if (LOWER_IS_BAD.has(kind)) {
        if (levels.crit != null && value <= levels.crit) return ['crit', levels.crit];
        if (levels.warn != null && value <= levels.warn) return ['warn', levels.warn];
        return [null, levels.warn ?? levels.crit];
    }
    if (levels.crit != null && value >= levels.crit) return ['crit', levels.crit];
    if (levels.warn != null && value >= levels.warn) return ['warn', levels.warn];
    return [null, levels.warn ?? levels.crit];
}

// The metric name for labels: the leading word(s) of the display string
// ("UPS1-Load 5%" -> "UPS1-Load"), falling back to the kind.
function metricName(m) {
    if (m.display) {
        const cut = String(m.display).replace(/\s+[-\d.].*$/, '').trim();
        if (cut) return cut;
    }
    return m.kind;
}

// Full label: "<host> <name>", plus the rule kind when the name doesn't
// already say it - "compute-01 GPU (util)" tells you WHICH threshold bucket
// fired, where a bare "compute-01 GPU" reads as noise. Skipped when redundant
// ("CPU"/cpu, "Batt"/battery, "Temp"/temp).
function metricLabel(m) {
    const name = metricName(m);
    const n = name.toLowerCase(), k = String(m.kind).toLowerCase();
    const redundant = n.startsWith(k) || k.startsWith(n);
    return `${m.host} ${name}${redundant ? '' : ` (${m.kind})`}`;
}

function ifLabel(i) {
    const dev = (i.device && i.device.name) || String(i.id || '').split(':')[0];
    return `${dev} ${i.name}${i.alias ? ` (${i.alias})` : ''}`;
}

function evaluate(doc, config) {
    const idx = buildOverrideIndex(config.overrides);
    const out = [];

    // --- device down (deduped per host; suppresses that device's other rules) ---
    // Preferred source: the feed's devices[] roster (schema v3) - every
    // device with ANY exported value, so a sensor-only VM or UPS gets
    // up/down alarms too. Feeds from older SNMPCanvas builds have no
    // roster; the interface entries' embedded device blocks fill in, which
    // only cover devices that export an interface.
    const downDevices = new Set();
    const seenDevices = new Set();
    const deviceRule = (name, host, status) => {
        if (!name || seenDevices.has(name)) return;
        seenDevices.add(name);
        const rule = resolveBool(idx, config.deviceDown, null, name, 'device-down');
        if (!rule) return;   // muted: no alarm, and its metrics evaluate normally
        const isDown = status === 'down';
        if (isDown) downDevices.add(name);
        out.push({
            key: `device:${name}`, severity: isDown ? rule.severity : null, frozen: false,
            kind: 'device-down', host: name, code: null,
            label: `${name} (${host || '?'}) device`,
            value: null, threshold: null, unit: ''
        });
    };
    if (Array.isArray(doc.devices)) {
        for (const d of doc.devices || []) deviceRule(d && d.name, d && d.host, d && d.status);
    }
    for (const i of doc.interfaces || []) {
        const d = i.device || {};
        deviceRule(d.name || String(i.id || '').split(':')[0], d.host, d.status);
    }

    // --- interfaces ---
    for (const i of doc.interfaces || []) {
        if (!i || !i.code) continue; // no stable key - nothing to alert on
        const dev = (i.device && i.device.name) || String(i.id || '').split(':')[0];
        const label = ifLabel(i);
        // A down device already alerted above - don't pile on per-interface
        // alerts whose real cause is the device. Freeze instead of reporting
        // "normal" so an interface alert that predates the device outage
        // doesn't clear while the device is unreachable.
        if (downDevices.has(dev)) {
            for (const aspect of ['down', 'errors', 'discards', 'util']) {
                out.push({
                    key: `if:${i.code}:${aspect}`, severity: null, frozen: true,
                    kind: `if-${aspect}`, host: dev, code: i.code, label: `${label} ${aspect}`,
                    value: null, threshold: null, unit: ''
                });
            }
            continue;
        }

        const downRule = resolveBool(idx, config.ifRules.down, i.code, dev, 'if-down');
        if (downRule) {
            const known = i.operStatus !== 'unknown' && i.adminStatus !== 'unknown';
            const isDown = i.adminStatus === 'up' && i.operStatus !== 'up';
            out.push({
                key: `if:${i.code}:down`, severity: known && isDown ? downRule.severity : null,
                frozen: !known,
                kind: 'if-down', host: dev, code: i.code, label: `${label} link`,
                value: null, threshold: null, unit: ''
            });
        }

        const rates = [
            ['errors', 'if-errors', Math.max(i.inErrorsPerSec ?? -1, i.outErrorsPerSec ?? -1), 'pps'],
            ['discards', 'if-discards', Math.max(i.inDiscardsPerSec ?? -1, i.outDiscardsPerSec ?? -1), 'pps']
        ];
        for (const [aspect, kind, worst, unit] of rates) {
            const levels = resolveLevels(idx, config.ifRules[aspect], i.code, dev, kind);
            if (!levels) continue;
            // null rates (counters settling) AND garbage non-numbers both
            // freeze - neither is evidence of normal.
            const frozen = !Number.isFinite(worst) || worst < 0;
            const [sev, thr] = frozen ? [null, null] : levelSeverity(kind, worst, levels);
            out.push({
                key: `if:${i.code}:${aspect}`, severity: sev, frozen,
                kind, host: dev, code: i.code, label: `${label} ${aspect}`,
                value: frozen ? null : round2(worst), threshold: thr, unit
            });
        }

        const utilLevels = resolveLevels(idx, config.ifRules.util, i.code, dev, 'if-util');
        if (utilLevels && i.speedBps > 0) {
            const worstBps = Math.max(i.inBps ?? -1, i.outBps ?? -1);
            const frozen = !Number.isFinite(worstBps) || worstBps < 0;
            const pct = frozen ? null : (worstBps * 100) / i.speedBps;
            const [sev, thr] = frozen ? [null, null] : levelSeverity('if-util', pct, utilLevels);
            out.push({
                key: `if:${i.code}:util`, severity: sev, frozen,
                kind: 'if-util', host: dev, code: i.code, label: `${label} utilization`,
                value: frozen ? null : round2(pct), threshold: thr, unit: '%'
            });
        }
    }

    // --- host metrics ---
    for (const m of doc.metrics || []) {
        if (!m || !m.code) continue; // no stable key - nothing to alert on
        if (!METRIC_KINDS.includes(m.kind)) continue; // future kinds: ignore until configured
        const levels = resolveLevels(idx, config.thresholds[m.kind], m.code, m.host, m.kind);
        if (!levels) continue;
        if (downDevices.has(m.host)) {
            out.push({
                key: `metric:${m.code}`, severity: null, frozen: true,
                kind: m.kind, host: m.host, code: m.code,
                label: metricLabel(m),
                value: null, threshold: null, unit: m.unit || ''
            });
            continue;
        }
        const frozen = typeof m.value !== 'number' || !Number.isFinite(m.value);
        const [sev, thr] = frozen ? [null, null] : levelSeverity(m.kind, m.value, levels);
        out.push({
            key: `metric:${m.code}`, severity: sev, frozen,
            kind: m.kind, host: m.host, code: m.code,
            label: metricLabel(m),
            value: frozen ? null : round2(m.value), threshold: thr, unit: m.unit || ''
        });
    }

    return out;
}

function round2(v) { return Math.round(v * 100) / 100; }

// Reboot detection: an uptime metric whose value went BACKWARDS since the
// previous scan means the host restarted. Pure - the scanner owns persisting
// the previous values. The 30 s guard absorbs sampling jitter (the reading
// and its sampledAt are not taken at the same instant). Note sysUpTime wraps
// at ~497 days, which is indistinguishable from a reboot.
function detectReboots(prev, metrics) {
    const out = [];
    for (const m of metrics || []) {
        if (!m || m.kind !== 'uptime' || !m.code) continue;
        // Only a real number counts: Number(null) is 0, Number('') is 0 -
        // an unreadable uptime must not look like a reboot.
        if (typeof m.value !== 'number' || !Number.isFinite(m.value)) continue;
        const v = m.value;
        const p = prev.get(m.code);
        if (p != null && v < p - 30) out.push({ code: m.code, host: m.host, from: p, to: v });
    }
    return out;
}

// The Watching view: for every value in the feed, what rule (if any) applies,
// where it came from, and how the current reading scores against it. Pure,
// like evaluate() - same inputs, but explanation instead of conditions.
function explain(doc, config) {
    const idx = buildOverrideIndex(config.overrides);

    const metrics = (doc.metrics || []).map((m) => {
        const known = METRIC_KINDS.includes(m.kind);
        const info = known
            ? resolveLevelsInfo(idx, config.thresholds[m.kind], m.code, m.host, m.kind)
            : { levels: null, source: 'none', muted: false };
        const numeric = typeof m.value === 'number' && Number.isFinite(m.value);
        let current = null;
        if (info.levels) {
            current = numeric ? (levelSeverity(m.kind, Number(m.value), info.levels)[0] || 'ok') : 'no-data';
        }
        return {
            code: m.code, kind: m.kind, host: m.host, display: m.display,
            value: numeric ? round2(m.value) : null, unit: m.unit || '',
            lowerIsBad: LOWER_IS_BAD.has(m.kind),
            rule: info.levels, source: info.source, muted: info.muted, current
        };
    });

    // Device roster mirrors evaluate(): the feed's devices[] when present,
    // interface-embedded device blocks as the legacy fallback.
    const deviceSeen = new Set();
    const devices = [];
    const addDevice = (name, ip, status) => {
        if (!name || deviceSeen.has(name)) return;
        deviceSeen.add(name);
        const info = resolveBoolInfo(idx, config.deviceDown, null, name, 'device-down');
        devices.push({
            host: name, ip: ip || null, status: status || 'unknown',
            rule: info.rule, source: info.source, muted: info.muted
        });
    };
    if (Array.isArray(doc.devices)) {
        for (const d of doc.devices || []) addDevice(d && d.name, d && d.host, d && d.status);
    }
    const interfaces = [];
    for (const i of doc.interfaces || []) {
        const dev = (i.device && i.device.name) || String(i.id || '').split(':')[0];
        addDevice(dev, i.device && i.device.host, i.device && i.device.status);

        const down = resolveBoolInfo(idx, config.ifRules.down, i.code, dev, 'if-down');
        const level = (aspect, kind, worst, pct) => {
            const info = resolveLevelsInfo(idx, config.ifRules[aspect], i.code, dev, kind);
            const value = pct !== undefined ? pct : worst;
            let current = null;
            if (info.levels) {
                current = value == null ? 'no-data' : (levelSeverity(kind, value, info.levels)[0] || 'ok');
            }
            return {
                rule: info.levels, source: info.source, muted: info.muted,
                value: value == null ? null : round2(value), current
            };
        };
        const worstOrNull = (a, b) => (a == null && b == null) ? null : Math.max(a ?? -1, b ?? -1);
        const worstBps = worstOrNull(i.inBps, i.outBps);
        interfaces.push({
            code: i.code, id: i.id, host: dev, name: i.name, alias: i.alias || '',
            operStatus: i.operStatus, adminStatus: i.adminStatus,
            deviceStatus: (i.device && i.device.status) || 'unknown',
            down: {
                rule: down.rule, source: down.source, muted: down.muted,
                current: down.rule
                    ? ((i.operStatus === 'unknown' || i.adminStatus === 'unknown') ? 'no-data'
                        : (i.adminStatus === 'up' && i.operStatus !== 'up') ? 'alarm' : 'ok')
                    : null
            },
            errors: level('errors', 'if-errors', worstOrNull(i.inErrorsPerSec, i.outErrorsPerSec)),
            discards: level('discards', 'if-discards', worstOrNull(i.inDiscardsPerSec, i.outDiscardsPerSec)),
            util: i.speedBps > 0
                ? level('util', 'if-util', null, worstBps == null ? undefined : (worstBps * 100) / i.speedBps)
                : { rule: null, source: 'none', muted: false, value: null, current: null }
        });
    }

    return { metrics, interfaces, devices };
}

// --- the ping feed (PingCanvas status-all.json) ------------------------------
// Alerting on reachability for devices PingCanvas pings but SNMPCanvas does
// not poll - ISP gateways, an internet canary, anything on a board. STRICTLY
// OPT-IN per device (the `watch` map): a device monitored by both feeds would
// otherwise raise device-down AND ping-down for one outage, so the operator
// checks only ping-only devices. Feed shape (the poller's Write-StatusFile):
//   { generated, pollIntervalSec, devices: { key: { state, latencyMs, since, name? } } }
// where key is the board device's Monitor ID or IP.
function evaluatePing(doc, watch, opts) {
    const out = [];
    const devices = (doc && doc.devices) || {};
    const degradedWarn = !!(opts && opts.degradedWarn);
    for (const [key, w] of Object.entries(watch || {})) {
        const e = devices[key];
        if (!e || typeof e !== 'object') continue;   // gone from the feed: the missing-scans machinery ages the alert out
        const label = `${(w && w.label) || e.name || key} ping`;
        const severity = e.state === 'down' ? 'crit'
            : (e.state === 'degraded' && degradedWarn) ? 'warn'
            : null;
        // 'unknown' (the poller could not probe) is no evidence either way:
        // freeze, like the metric rules do - it must not clear a live outage.
        const known = e.state === 'up' || e.state === 'down' || e.state === 'degraded';
        out.push({
            key: `ping:${key}`, severity, frozen: !known,
            kind: 'ping-down', host: (w && w.label) || e.name || key, code: null,
            label,
            value: typeof e.latencyMs === 'number' ? e.latencyMs : null,
            threshold: null, unit: 'ms'
        });
    }
    return out;
}

module.exports = { evaluate, evaluatePing, explain, detectReboots, LOWER_IS_BAD, METRIC_KINDS };
