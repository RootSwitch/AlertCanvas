'use strict';
// The alert-formatting engine: {{variable}} substitution into user-editable subject,
// body, and syslog message templates. Unknown variables render as-is so a typo
// is visible in the mail rather than silently blank.

const VARS = ['label', 'host', 'metric', 'kind', 'code', 'value', 'unit',
    'threshold', 'severity', 'event', 'time', 'duration'];

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
        time: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
        duration: fmtDuration((alert.cleared_ts || now) - since)
    };
}

function render(template, vars) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (whole, name) =>
        vars[name] !== undefined ? vars[name] : whole);
}

module.exports = { render, varsFor, fmtDuration, VARS };
