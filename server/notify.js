'use strict';
// Notification dispatch: one alert event in, email + syslog out, every attempt
// recorded in the notifications table. The scanner owns retry policy; this
// module just sends and reports.

const { db, getSetting } = require('./db');
const templates = require('./templates');
const smtp = require('./smtp');
const syslogOut = require('./syslog-out');
const ntfy = require('./ntfy');

function log(...args) { console.log(new Date().toISOString(), '[notify]', ...args); }

const insertLog = db.prepare(
    'INSERT INTO notifications (alert_id, channel, event, ts, ok, detail) VALUES (?, ?, ?, ?, ?, ?)');

function record(alertId, channel, event, ok, detail) {
    insertLog.run(alertId, channel, event, Math.floor(Date.now() / 1000), ok ? 1 : 0,
        String(detail || '').slice(0, 500));
}

let lastEmailError = null;
function getLastEmailError() { return lastEmailError; }

// event: raise | clear | escalate | renotify. Returns { emailOk } - true when
// the email was delivered OR email is disabled (nothing owed). Syslog is UDP
// fire-and-forget and never gates alert bookkeeping.
async function dispatch(event, alert) {
    // Maintenance silence: alarms still track and display; nothing is sent.
    // Logged as suppressed (not failed) so history explains the quiet inbox,
    // and emailOk=true so nothing queues up to fire when the window ends.
    const silenceUntil = parseInt(getSetting('silence_until'), 10) || 0;
    if (silenceUntil > Math.floor(Date.now() / 1000)) {
        const detail = `suppressed - silenced until ${new Date(silenceUntil * 1000).toISOString()}`;
        if (getSetting('email_enabled') === '1') record(alert.id, 'email', event, true, detail);
        if (getSetting('syslog_enabled') === '1') record(alert.id, 'syslog', event, true, detail);
        if (getSetting('ntfy_enabled') === '1') record(alert.id, 'ntfy', event, true, detail);
        log(`${event} ${alert.severity} ${alert.alert_key} - ${alert.label} (silenced)`);
        return { emailOk: true };
    }

    const isClear = event === 'clear';
    const vars = templates.varsFor(alert, event);

    const results = { emailOk: true };
    if (getSetting('email_enabled') === '1') {
        const subject = templates.render(
            getSetting(isClear ? 'tmpl_subject_clear' : 'tmpl_subject_raise'), vars);
        const body = templates.render(
            getSetting(isClear ? 'tmpl_body_clear' : 'tmpl_body_raise'), vars);
        const r = await smtp.sendMail(subject, body);
        record(alert.id, 'email', event, r.ok, r.detail);
        results.emailOk = r.ok;
        if (r.ok) { lastEmailError = null; }
        else {
            lastEmailError = { ts: Math.floor(Date.now() / 1000), detail: r.detail };
            log(`email ${event} failed for ${alert.alert_key}: ${r.detail}`);
        }
    }

    if (getSetting('syslog_enabled') === '1') {
        const msg = templates.render(
            getSetting(isClear ? 'tmpl_syslog_clear' : 'tmpl_syslog_raise'), vars);
        const r = await syslogOut.send(event, alert, msg);
        record(alert.id, 'syslog', event, r.ok, r.detail);
        if (!r.ok) log(`syslog ${event} failed for ${alert.alert_key}: ${r.detail}`);
    }

    // ntfy reuses the email subject as its title and the (short) syslog
    // template as its body - push notifications want one glanceable line.
    if (getSetting('ntfy_enabled') === '1') {
        const title = templates.render(
            getSetting(isClear ? 'tmpl_subject_clear' : 'tmpl_subject_raise'), vars);
        const msg = templates.render(
            getSetting(isClear ? 'tmpl_syslog_clear' : 'tmpl_syslog_raise'), vars);
        const r = await ntfy.send(event, alert, title, msg);
        record(alert.id, 'ntfy', event, r.ok, r.detail);
        if (!r.ok) log(`ntfy ${event} failed for ${alert.alert_key}: ${r.detail}`);
    }

    log(`${event} ${alert.severity} ${alert.alert_key} - ${alert.label}` +
        (alert.value != null ? ` (${alert.value}${alert.unit || ''})` : ''));
    return results;
}

module.exports = { dispatch, record, getLastEmailError };
