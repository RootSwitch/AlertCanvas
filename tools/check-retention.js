'use strict';
// Verifies the retention inventory line: cleared alerts and notification rows
// counted, live alerts excluded (they are state, not history), oldest row
// found across both pruned tables, and honest zeros on an empty database.
//
//   node tools/check-retention.js

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ALERTCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'alertcanvas-retention-'));

const { db } = require('../server/db');
const { historyInventory } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const DAY = 86400;
const now = 1_800_000_000;

const empty = historyInventory();
check('empty database: zero counts, null oldest',
    empty.clearedAlerts === 0 && empty.notificationRows === 0 && empty.oldestTs === null);

const insAlert = db.prepare(`INSERT INTO alerts (alert_key, state, severity, kind, first_breach_ts, cleared_ts)
                             VALUES (?, ?, 'warn', 'cpu', ?, ?)`);
insAlert.run('k1', 'active', now - 2 * DAY, null);                 // live - not history
insAlert.run('k2', 'cleared', now - 61 * DAY, now - 60 * DAY);     // the oldest cleared
insAlert.run('k3', 'cleared', now - 5 * DAY, now - 4 * DAY);

let inv = historyInventory();
check('live alerts are state, not history', inv.clearedAlerts === 2, String(inv.clearedAlerts));
check('oldest is the oldest CLEARED timestamp', inv.oldestTs === now - 60 * DAY, String(inv.oldestTs));

const insNote = db.prepare(`INSERT INTO notifications (channel, event, ts, ok) VALUES ('email', 'raise', ?, 1)`);
insNote.run(now - 75 * DAY);   // older than any cleared alert
insNote.run(now - DAY);

inv = historyInventory();
check('notification rows counted', inv.notificationRows === 2);
check('oldest spans BOTH pruned tables', inv.oldestTs === now - 75 * DAY, String(inv.oldestTs));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall retention checks passed');
process.exit(failures ? 1 : 0);
