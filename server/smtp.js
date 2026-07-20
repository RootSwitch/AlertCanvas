'use strict';
// Email via nodemailer - the one place AlertCanvas takes a dependency beyond
// better-sqlite3. Alert mail has to land on whatever relay the operator
// already has (Gmail app password, O365, Mailcow, a dumb LAN relay), and
// nodemailer's STARTTLS/AUTH handling is the pragmatic way to make that true.
// Plain text only: an alert is a sentence, not a newsletter.

const nodemailer = require('nodemailer');
const { getSetting, getSmtpPassword } = require('./db');

// Build a transport from settings each send. At homelab alert volume (a few
// mails a day at worst) connection reuse buys nothing, and rebuilding means a
// settings change or test-send always uses what is on screen/in the DB now.
// overrides: the test route passes unsaved form values so "Test" tests what
// the user typed, not what was last saved.
function buildConfig(overrides = {}) {
    const s = (key, oKey) => overrides[oKey] !== undefined ? String(overrides[oKey]) : getSetting(key);
    const mode = s('smtp_mode', 'mode');
    const cfg = {
        host: s('smtp_host', 'host').trim(),
        port: parseInt(s('smtp_port', 'port'), 10) || 587,
        secure: mode === 'tls',              // implicit TLS from byte one
        requireTLS: mode === 'starttls',     // upgrade or fail - never silently plaintext
        ignoreTLS: mode === 'none',
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        tls: { rejectUnauthorized: s('smtp_allow_self_signed', 'allowSelfSigned') !== '1' }
    };
    const user = s('smtp_user', 'user').trim();
    const pass = overrides.pass !== undefined ? String(overrides.pass) : getSmtpPassword();
    if (user) cfg.auth = { user, pass: pass || '' };
    return cfg;
}

// Resolves {ok, detail}; never rejects.
async function sendMail(subject, body, overrides = {}) {
    const cfg = buildConfig(overrides);
    if (!cfg.host) return { ok: false, detail: 'no SMTP host configured' };
    const from = (overrides.from !== undefined ? String(overrides.from) : getSetting('smtp_from')).trim();
    const toRaw = overrides.to !== undefined ? String(overrides.to) : getSetting('smtp_to');
    const to = toRaw.split(',').map((a) => a.trim()).filter(Boolean);
    if (!from) return { ok: false, detail: 'no From address configured' };
    if (to.length === 0) return { ok: false, detail: 'no recipients configured' };
    try {
        const transport = nodemailer.createTransport(cfg);
        const info = await transport.sendMail({ from, to, subject, text: body });
        transport.close();
        return { ok: true, detail: info.response || 'accepted' };
    } catch (err) {
        return { ok: false, detail: err.message || String(err) };
    }
}

module.exports = { sendMail };
