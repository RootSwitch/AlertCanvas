'use strict';
// ntfy push notifications (https://ntfy.sh or self-hosted): one HTTP POST per
// event, using Node's global fetch. Best-effort like syslog - a down ntfy
// server logs a failure but never gates alert bookkeeping; email remains the
// retried channel.

const { getSetting, getSecretSetting } = require('./db');

// Priority and tag follow ntfy conventions: crit pages (urgent), warn is
// high, clears and tests are default.
function priorityFor(event, severity) {
    if (event === 'clear' || event === 'test') return '3';
    return severity === 'crit' ? '5' : '4';
}
function tagFor(event, severity) {
    if (event === 'clear') return 'white_check_mark';
    if (event === 'test') return 'mag';
    return severity === 'crit' ? 'rotating_light' : 'warning';
}

// HTTP headers must stay latin1; ntfy titles with anything fancier get the
// character replaced rather than the whole send thrown away.
const headerSafe = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').slice(0, 250);

// Send one message. Resolves {ok, detail}; never rejects. overrides lets the
// test route target what is on the settings form rather than what was saved.
async function send(event, alert, title, message, overrides = {}) {
    const o = (key, oKey) => overrides[oKey] !== undefined ? String(overrides[oKey]) : getSetting(key);
    const server = o('ntfy_server', 'server').trim().replace(/\/+$/, '');
    const topic = o('ntfy_topic', 'topic').trim();
    if (!server || !topic) return { ok: false, detail: 'ntfy server/topic not configured' };
    if (!/^https?:\/\//i.test(server)) return { ok: false, detail: 'ntfy server must start with http:// or https://' };
    const token = overrides.token !== undefined ? String(overrides.token) : getSecretSetting('ntfy_token');

    try {
        const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
            method: 'POST',
            body: message,
            headers: {
                Title: headerSafe(title),
                Priority: priorityFor(event, alert && alert.severity),
                Tags: tagFor(event, alert && alert.severity),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) return { ok: false, detail: `${server}: HTTP ${res.status}` };
        return { ok: true, detail: `${server}/${topic}` };
    } catch (err) {
        return { ok: false, detail: (err && err.message) || String(err) };
    }
}

module.exports = { send };
