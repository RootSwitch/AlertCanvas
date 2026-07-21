'use strict';
// The alert-formatting engine: {{variable}} substitution into user-editable subject,
// body, and syslog message templates. Unknown variables render as-is so a typo
// is visible in the mail rather than silently blank.

const VARS = ['label', 'host', 'metric', 'kind', 'code', 'value', 'unit',
    'threshold', 'severity', 'event', 'time', 'duration', 'detail', 'reading'];

// A natural-language clause describing WHY an alarm is active, chosen by kind.
// Metric breaches keep the classic "value X (threshold Y)"; alarms with no
// numeric reading (a device that fell out of the feed, a downed link, a
// reboot, a feed problem) get a plain statement instead of the bare
// "value -- (threshold --)" the generic template used to produce.
function detailFor(alert) {
    const unit = alert.unit || '';
    if (alert.value != null && alert.threshold != null) {
        return `value ${alert.value}${unit} (threshold ${alert.threshold}${unit})`;
    }
    switch (alert.kind) {
        case 'device-down': return 'not reporting in the status feed (unreachable or powered off)';
        case 'if-down':     return 'link is down';
        case 'reboot':      return 'recently rebooted';
        case 'watchdog':    return 'the SNMPCanvas status feed is unavailable or stale';
        default:            return alert.value != null ? `value ${alert.value}${unit}` : 'state changed';
    }
}

function fmtDuration(sec) {
    if (sec == null || sec < 0) return '-';
    sec = Math.round(sec);
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// alert: an alerts-table row. event: raise|clear|escalate|renotify|test.
function varsFor(alert, event) {
    const now = Math.floor(Date.now() / 1000);
    const since = alert.raised_ts || alert.first_breach_ts || now;
    const label = alert.label || `${alert.host || ''} ${alert.kind}`.trim();
    // label is "<host> <metric name>"; metric is the name part alone.
    const metric = alert.host && label.startsWith(alert.host + ' ')
        ? label.slice(alert.host.length + 1) : label;
    return {
        label,
        host: alert.host || '',
        metric,
        kind: alert.kind,
        code: alert.code || '',
        value: alert.value == null ? '--' : String(alert.value),
        unit: alert.unit || '',
        threshold: alert.threshold == null ? '--' : String(alert.threshold),
        severity: alert.severity,
        event,
        // Notification timestamps are UTC (the trailing Z = Zulu = UTC): the
        // server has no reliable local-timezone context and UTC stays
        // unambiguous across the mail, syslog, and ntfy channels. This is the
        // moment the notification is rendered, not necessarily the breach.
        time: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
        duration: fmtDuration((alert.cleared_ts || now) - since),
        detail: detailFor(alert),
        // Recovered reading for clear messages; empty (not "--") when the
        // alarm had no numeric value, so a device-down clear reads cleanly.
        reading: alert.value == null ? '' : ` (now ${alert.value}${alert.unit || ''})`
    };
}

function render(template, vars) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (whole, name) =>
        vars[name] !== undefined ? vars[name] : whole);
}

module.exports = { render, varsFor, fmtDuration, VARS };
