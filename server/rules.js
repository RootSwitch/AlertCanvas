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
    'battery', 'runtime', 'outlet', 'uptime'];

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

// Resolve the {warn, crit} pair for one leveled target. Returns null when the
// target is muted or has no applicable rule.
function resolveLevels(idx, defaults, code, host, kind) {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`);
    if (o) {
        if (!o.enabled) return null;
        if (o.warn == null && o.crit == null) return null;
        return { warn: o.warn, crit: o.crit };
    }
    if (!defaults || (defaults.warn == null && defaults.crit == null)) return null;
    return { warn: defaults.warn ?? null, crit: defaults.crit ?? null };
}

// Resolve a boolean rule (if-down, device-down): {severity} or null when muted.
function resolveBool(idx, defaults, code, host, kind) {
    const o = idx.byCode.get(`${code}|${kind}`) || idx.byHostKind.get(`${host}|${kind}`);
    if (o) {
        if (!o.enabled) return null;
        return { severity: o.severity || (defaults && defaults.severity) || 'crit' };
    }
    if (!defaults || !defaults.enabled) return null;
    return { severity: defaults.severity || 'crit' };
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

function ifLabel(i) {
    const dev = (i.device && i.device.name) || i.id.split(':')[0];
    return `${dev} ${i.name}${i.alias ? ` (${i.alias})` : ''}`;
}

function evaluate(doc, config) {
    const idx = buildOverrideIndex(config.overrides);
    const out = [];

    // --- device down (deduped per host; suppresses that device's other rules) ---
    const downDevices = new Set();
    const seenDevices = new Set();
    for (const i of doc.interfaces || []) {
        const d = i.device || {};
        const name = d.name || i.id.split(':')[0];
        if (seenDevices.has(name)) continue;
        seenDevices.add(name);
        const rule = resolveBool(idx, config.deviceDown, null, name, 'device-down');
        if (!rule) continue;
        const isDown = d.status === 'down';
        if (isDown) downDevices.add(name);
        out.push({
            key: `device:${name}`, severity: isDown ? rule.severity : null, frozen: false,
            kind: 'device-down', host: name, code: null,
            label: `${name} (${d.host || '?'}) device`,
            value: null, threshold: null, unit: ''
        });
    }

    // --- interfaces ---
    for (const i of doc.interfaces || []) {
        const dev = (i.device && i.device.name) || i.id.split(':')[0];
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
            const frozen = worst < 0; // null rates (device just came up, counters settling)
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
            const frozen = worstBps < 0;
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
        if (!METRIC_KINDS.includes(m.kind)) continue; // future kinds: ignore until configured
        const levels = resolveLevels(idx, config.thresholds[m.kind], m.code, m.host, m.kind);
        if (!levels) continue;
        if (downDevices.has(m.host)) {
            out.push({
                key: `metric:${m.code}`, severity: null, frozen: true,
                kind: m.kind, host: m.host, code: m.code,
                label: `${m.host} ${metricName(m)}`,
                value: null, threshold: null, unit: m.unit || ''
            });
            continue;
        }
        const frozen = m.value == null || !Number.isFinite(Number(m.value));
        const [sev, thr] = frozen ? [null, null] : levelSeverity(m.kind, Number(m.value), levels);
        out.push({
            key: `metric:${m.code}`, severity: sev, frozen,
            kind: m.kind, host: m.host, code: m.code,
            label: `${m.host} ${metricName(m)}`,
            value: frozen ? null : round2(Number(m.value)), threshold: thr, unit: m.unit || ''
        });
    }

    return out;
}

function round2(v) { return Math.round(v * 100) / 100; }

module.exports = { evaluate, LOWER_IS_BAD, METRIC_KINDS };
