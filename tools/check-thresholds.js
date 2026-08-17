'use strict';
// Pins the temperature decision and the migration that carried it to existing
// installs. `temp` ships with NO default threshold (see the note on
// DEFAULT_THRESHOLDS in server/db.js) because the feed never says what the
// sensor is attached to, and the old 45/55 made every small-form-factor host
// permanently critical.
//
// The migration must do exactly two things: clear the old default verbatim,
// and leave anything a human chose alone. Both are checked, because a
// migration that only ever ran on the author's machine is a migration nobody
// has tested.
//
//   node tools/check-thresholds.js

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const DB = JSON.stringify(path.join(__dirname, '..', 'server', 'db.js'));

// Boot a REAL child process per step. require() caches, so a second require in
// THIS process would not re-run the migration IIFE - the test would pass while
// testing nothing.
function boot(dir, script) {
    return execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, ALERTCANVAS_DATA: dir },
        encoding: 'utf8'
    }).trim();
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alertcanvas-thresholds-'));

const READ = `const d = require(${DB});
process.stdout.write(JSON.stringify(JSON.parse(d.getSetting('thresholds')).temp ?? null));`;

const write = (json) => `const d = require(${DB});
const t = JSON.parse(d.getSetting('thresholds'));
t.temp = ${json};
d.setSetting('thresholds', JSON.stringify(t));`;

const readTemp = (dir) => JSON.parse(boot(dir, READ));

// 1. the decision itself
const defaults = boot(freshDir(), `const d = require(${DB});
process.stdout.write(JSON.stringify(d.DEFAULT_THRESHOLDS.temp ?? null));`);
check('temp has no default threshold', defaults === 'null', `got ${defaults}`);

// 2. a fresh install never gets one
check('an install that never saved Settings reads temp as null', readTemp(freshDir()) === null);

// 3. an install carrying the OLD DEFAULT is migrated
const aged = freshDir();
boot(aged, write('{"warn":45,"crit":55}'));
check('old default 45/55 is cleared on next boot', readTemp(aged) === null);

// 4. a chosen value survives
const chosen = freshDir();
boot(chosen, write('{"warn":70,"crit":85}'));
const kept = readTemp(chosen);
check('a chosen threshold is left alone',
    kept && kept.warn === 70 && kept.crit === 85, JSON.stringify(kept));

// 5. BOTH numbers must match - half the old default is a choice, not a leftover
const half = freshDir();
boot(half, write('{"warn":45,"crit":60}'));
const halfKept = readTemp(half);
check('45/60 is a choice, not the old default',
    halfKept && halfKept.warn === 45 && halfKept.crit === 60, JSON.stringify(halfKept));

// 6. an already-migrated install is not disturbed by a second boot
const twice = freshDir();
boot(twice, write('{"warn":45,"crit":55}'));
boot(twice, READ);
check('migration is idempotent', readTemp(twice) === null);

console.log(failures ? `\n${failures} FAILED` : '\nall threshold checks passed');
process.exit(failures ? 1 : 0);
