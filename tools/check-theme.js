'use strict';
// Validate a custom theme before restarting anything.
//
//   node tools/check-theme.js                  # checks ./data/theme.json
//   node tools/check-theme.js /srv/noc-data    # or a data directory
//   node tools/check-theme.js /srv/noc-data/theme.json
//
// It calls the SAME loader the server calls, so this can never accept a file
// the app would reject, or reject one the app would accept. Exit 1 on errors,
// 0 on warnings - warnings are advice, not a veto, and an operator may have
// reasons.

const fs = require('node:fs');
const path = require('node:path');
const { loadTheme, THEME_VARS } = require('../server/theme');

let target = process.argv[2] || path.join(__dirname, '..', 'data');
// Accept a file as well as a directory: pointing at theme.json is the obvious
// thing to try, and refusing it would be pedantry.
try {
    if (fs.statSync(target).isFile()) target = path.dirname(target);
} catch (_) { /* loadTheme reports a missing path better than a stat error does */ }

const r = loadTheme(target);

if (!r.exists) {
    console.log(`no custom theme at ${r.path}`);
    console.log('That is fine - the app uses the 29 shipped themes. To add one:');
    console.log('  node tools/export-theme.js nocturne > ' + r.path);
    process.exit(0);
}

console.log(`checking ${r.path}`);

for (const e of r.errors) console.error(`  ERROR  ${e}`);
for (const w of r.warnings) console.warn(`  warn   ${w}`);

if (r.errors.length) {
    console.error(`\n${r.errors.length} error(s) - the app will ignore this file and stay on the shipped themes.`);
    process.exit(1);
}

const set = Object.keys(r.theme.vars).length;
console.log(`\n  ok     "${r.theme.label}" sets ${set} of ${THEME_VARS.length} variables`);
if (r.warnings.length) {
    console.log(`  ${r.warnings.length} warning(s) above. Nothing is blocked - but the up/down ones`);
    console.log('  matter more than they look: this is a wall display, and a palette where');
    console.log('  healthy and failed do not separate at a glance is a safety problem.');
} else {
    console.log('  no warnings - contrast and state colours look readable.');
}
console.log('\nRestart the app to pick it up (a browser refresh is enough for the file itself).');
