'use strict';
// Outbound syslog: RFC 5424 over UDP. Deliberately shaped so SyslogCanvas's
// parser stores it first-class (facility/severity/host/app all populate and
// the structured-data block is skipped cleanly), but any RFC 5424 receiver
// will do. UDP is fire-and-forget by design - a down syslog server must never
// block or fail alerting.

const dgram = require('node:dgram');
const os = require('node:os');
const { getSetting } = require('./db');

// SD-PARAM values escape backslash, quote, and closing bracket (RFC 5424 6.3.3).
function sdEscape(v) {
    return String(v).replace(/[\\"\]]/g, (c) => '\\' + c);
}

const SEV_BY_EVENT = () => ({
    crit: parseInt(getSetting('syslog_sev_crit'), 10),
    warn: parseInt(getSetting('syslog_sev_warn'), 10),
    clear: parseInt(getSetting('syslog_sev_clear'), 10)
});

// event: raise|escalate|renotify use the alert severity; clear|test have
// their own mapping (test reuses clear's, usually notice).
function severityCode(event, alertSeverity) {
    const sev = SEV_BY_EVENT();
    if (event === 'clear' || event === 'test') return clamp(sev.clear, 0, 7, 5);
    return clamp(alertSeverity === 'crit' ? sev.crit : sev.warn, 0, 7, alertSeverity === 'crit' ? 2 : 4);
}

function clamp(v, lo, hi, dflt) {
    return Number.isInteger(v) && v >= lo && v <= hi ? v : dflt;
}

// Send one message. Resolves {ok, detail} - never rejects. overrides lets the
// test route target what is on the settings form rather than what was saved.
function send(event, alert, message, overrides = {}) {
    const o = (key, oKey) => overrides[oKey] !== undefined ? String(overrides[oKey]) : getSetting(key);
    const host = o('syslog_host', 'host').trim();
    const port = clamp(parseInt(o('syslog_port', 'port'), 10), 1, 65535, 514);
    if (!host) return Promise.resolve({ ok: false, detail: 'no syslog host configured' });

    const facility = clamp(parseInt(o('syslog_facility', 'facility'), 10), 0, 23, 16);
    const pri = facility * 8 + severityCode(event, alert && alert.severity);
    const ts = new Date().toISOString();
    const sd = alert && alert.kind !== 'test'
        ? `[alertc@0 event="${sdEscape(event)}" severity="${sdEscape(alert.severity || '')}"` +
          ` kind="${sdEscape(alert.kind || '')}" host="${sdEscape(alert.host || '')}"` +
          (alert.code ? ` code="${sdEscape(alert.code)}"` : '') + ']'
        : `[alertc@0 event="${sdEscape(event)}"]`;
    // One datagram is one message: a template with embedded newlines would
    // produce a nonconforming multi-line RFC 5424 payload.
    const flat = String(message).replace(/[\r\n]+/g, ' ');
    const line = `<${pri}>1 ${ts} ${os.hostname()} alertcanvas ${process.pid} ` +
        `${event.toUpperCase()} ${sd} ${flat}`;

    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const buf = Buffer.from(line, 'utf8');
        const done = (ok, detail) => { try { sock.close(); } catch (_) { /* closed */ } resolve({ ok, detail }); };
        sock.once('error', (err) => done(false, err.message));
        sock.send(buf, 0, buf.length, port, host, (err) =>
            err ? done(false, err.message) : done(true, `${host}:${port}`));
    });
}

module.exports = { send };
