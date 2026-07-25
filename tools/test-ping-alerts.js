'use strict';
// Ping alerting, driven through the real scanner and the real database.
//
//   node tools/test-ping-alerts.js
//
// Two deployments, because they fail in opposite directions:
//
//   paired    - SNMPCanvas and PingCanvas both feeding. A watched address going
//               down must raise, and recover; an UNWATCHED one must stay silent
//               however loudly it is down. Watching is opt-in, and a board full
//               of workstations that sleep at night would otherwise alarm all
//               night.
//   ping-only - STATUS_FILE=off, the Pi-class pairing with no SNMPCanvas at
//               all. The SNMP feed watchdog must never fire; "no SNMP
//               configured" is not "SNMP is broken", and an alerting tool that
//               cries wolf on a deployment it was told about is worse than one
//               that stays quiet.
//
// STATUS_FILE is read when the modules load, so each mode runs as a child
// process against its own temporary data directory.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const MODE = process.env.CHECK_MODE;

if (!MODE) {
    const { spawnSync } = require('node:child_process');
    let failed = 0;
    for (const mode of ['paired', 'ping-only']) {
        console.log(`\n--- ${mode} ---`);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alertcanvas-' + mode + '-'));
        const r = spawnSync(process.execPath, [__filename],
            { env: { ...process.env, CHECK_MODE: mode, ALERTCANVAS_DATA: dir }, stdio: 'inherit' });
        if (r.status !== 0) failed++;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* file locks */ }
    }
    console.log(failed ? `\n${failed} mode(s) FAILED` : '\nping alerting behaves in both deployments');
    process.exit(failed ? 1 : 0);
}

const DATA = process.env.ALERTCANVAS_DATA;
const SNMP_FEED = path.join(DATA, 'snmp-status.json');
const PING_FEED = path.join(DATA, 'status-all.json');

const WATCHED = '203.0.113.1';
const UNWATCHED = '10.20.0.16';

const writeSnmp = () => fs.writeFileSync(SNMP_FEED, JSON.stringify({
    schemaVersion: 4, generatedAt: new Date().toISOString(), pollIntervalSec: 30,
    devices: [{ name: 'core-sw', host: UNWATCHED, status: 'up' }],
    interfaces: [], metrics: []
}));
const writePing = (state) => fs.writeFileSync(PING_FEED, JSON.stringify({
    generated: new Date().toISOString(), pollIntervalSec: 15,
    devices: {
        [WATCHED]: { state, latencyMs: state === 'up' ? 14 : null, since: new Date().toISOString(), name: 'ISP A' },
        [UNWATCHED]: { state: 'down', latencyMs: null, since: new Date().toISOString() }
    }
}));

process.env.STATUS_FILE = MODE === 'ping-only' ? 'off' : SNMP_FEED;
const { db, setSetting } = require('../server/db.js');
const scanner = require('../server/scanner.js');
setSetting('ping_status_file', PING_FEED);
setSetting('ping_watch', JSON.stringify({ [WATCHED]: { label: 'Primary ISP' } }));
setSetting('email_enabled', '0');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
const rows = () => db.prepare('SELECT alert_key, state, severity, kind, label, value FROM alerts ORDER BY alert_key').all();
// An alert raises on the SECOND consecutive bad scan, so one blip never pages.
const twoTicks = async (state) => {
    for (let i = 0; i < 2; i++) {
        if (MODE === 'paired') writeSnmp();
        writePing(state);
        await scanner.tick();
    }
};

(async () => {
    await twoTicks('down');
    const raised = rows();
    const isp = raised.find((r) => r.alert_key === `ping:${WATCHED}`);
    check('a watched address that is down raises', !!isp && isp.state === 'active' && isp.severity === 'crit',
        isp && `${isp.state}/${isp.severity}`);
    check('it is a ping-down alert carrying the label', !!isp && isp.kind === 'ping-down' && isp.label.includes('Primary ISP'),
        isp && isp.label);
    check('an unwatched device never alarms', !raised.some((r) => r.alert_key.includes(UNWATCHED)));

    const pingWd = raised.find((r) => r.alert_key === 'watchdog:pingfeed');
    check('the ping watchdog stays quiet on a healthy feed',
        !pingWd || (pingWd.state !== 'active' && pingWd.state !== 'pending'), pingWd && pingWd.state);

    if (MODE === 'ping-only') {
        const snmpWd = raised.find((r) => r.alert_key === 'watchdog:feed' && r.state !== 'cleared');
        check('the SNMP watchdog never fires with STATUS_FILE=off', !snmpWd, snmpWd && snmpWd.state);
        const status = scanner.getStatus();
        check('the heartbeat counts ping devices', status.watching && status.watching.pingDevices === 1,
            JSON.stringify(status.watching));
        check('the scan reports itself healthy, not failed', status.lastScanOk === true, String(status.lastScanOk));
    }

    await twoTicks('up');
    const cleared = rows().find((r) => r.alert_key === `ping:${WATCHED}`);
    check('it clears on recovery, with the recovered latency', !!cleared && cleared.state === 'cleared' && cleared.value === 14,
        cleared && `${cleared.state}/${cleared.value}`);

    if (MODE === 'paired') {
        // Wording is kind-aware: a ping alert has no threshold to quote, so the
        // generic "is 0" phrasing would be nonsense.
        const templates = require('../server/templates.js');
        const vars = templates.varsFor({ ...cleared, kind: 'ping-down', severity: 'crit', value: null,
            host: 'Primary ISP', label: 'Primary ISP ping' }, 'raise');
        check('the raise wording suits a ping alert', vars.detail === 'not answering ping', vars.detail);
    }

    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
