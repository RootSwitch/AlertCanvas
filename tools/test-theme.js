'use strict';
// Custom theme slot: validation, and the contrast audit that guards it.
//
//   node tools/test-theme.js
//
// Two things here are not ordinary assertions and are the reason the rest can
// be trusted:
//
//   1. The contrast maths is CALIBRATED first, against values with a known
//      answer (black on white is 21:1, a colour on itself is 1:1). A ratio
//      function that is quietly wrong would let every later "warns correctly"
//      assertion pass while measuring nothing.
//   2. A deliberately GOOD theme must produce NO warnings. Without that, an
//      audit that flagged everything would satisfy every other check in this
//      file and be worse than useless - operators learn to ignore a warning
//      that always fires.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTheme, contrast, hueGap, auditContrast } = require('../server/theme');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alertcanvas-theme-'));
function write(obj) {
    fs.writeFileSync(path.join(TMP, 'theme.json'),
        typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function clear() {
    try { fs.unlinkSync(path.join(TMP, 'theme.json')); } catch (_) { /* already gone */ }
}

// --- 1. calibrate the instrument -------------------------------------------
console.log('contrast maths');
check('black on white is 21:1', Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01,
    contrast('#000000', '#ffffff').toFixed(2));
check('a colour against itself is 1:1', Math.abs(contrast('#4c8bf5', '#4c8bf5') - 1) < 0.01);
check('shorthand hex expands', Math.abs(contrast('#000', '#fff') - 21) < 0.01);
check('pure red and pure green are 120 degrees apart', Math.abs(hueGap('#ff0000', '#00ff00') - 120) < 0.5,
    String(hueGap('#ff0000', '#00ff00')));
check('hue gap wraps the short way', Math.abs(hueGap('#ff0000', '#ff00ff') - 60) < 0.5,
    String(hueGap('#ff0000', '#ff00ff')));
check('grey has no hue, so the gap is unknowable', hueGap('#808080', '#ff0000') === null);

// --- 2. the negative control ------------------------------------------------
// The shipped Classic palette must pass silently. If this ever warns, the audit
// has started flagging themes we ship, and every warning below means nothing.
console.log('\nnegative control (must stay silent)');
const CLASSIC = {
    '--se-panel': '#262a33', '--se-panel-2': '#2d323d', '--se-input': '#1b1e25',
    '--se-border': '#3a4150', '--se-txt': '#e6e9ef', '--se-txt-dim': '#9aa3b2',
    '--se-accent': '#4c8bf5', '--se-active': '#0066cc', '--se-up': '#2e9b57',
    '--se-down': '#d64545', '--se-warn': '#d9a92f', '--se-unknown': '#8a8f98',
    '--se-series-out': '#2e9b57', '--se-logo-a': '#4c8bf5', '--se-logo-b': '#2e9b57'
};
const classicWarnings = auditContrast(CLASSIC);
check('the shipped Classic palette raises no contrast warnings',
    classicWarnings.length === 0, classicWarnings.join(' | '));

// --- 3. the audit catches what it is for ------------------------------------
console.log('\ncontrast audit');
const dim = auditContrast({ ...CLASSIC, '--se-txt': '#30343d' });
check('unreadable body text is caught', dim.some((w) => w.startsWith('body text')), dim[0] || '');

const sameish = auditContrast({ ...CLASSIC, '--se-down': '#2e9b57', '--se-up': '#3aa862' });
check('up and down too close in hue is caught',
    sameish.some((w) => w.startsWith('up/down')), sameish.find((w) => w.startsWith('up/down')) || '');

// A true grey defeats the hue test entirely, so hueGap returns null and the
// up/down branch fires on that.
const trueGrey = auditContrast({ ...CLASSIC, '--se-down': '#808080' });
check('a true grey state colour is caught by the hue check',
    trueGrey.some((w) => w.startsWith('up/down')), trueGrey.find((w) => w.startsWith('up/down')) || '');

// This is the case that found the gap. #8a8f98 is the shipped "grey" but it is
// really a blue-grey: 74 degrees off green, so the hue check passes it happily
// while it still reads as no-state on the wall. Saturation is what catches it.
const washedOut = auditContrast({ ...CLASSIC, '--se-down': '#8a8f98' });
check('a desaturated state colour is caught even with a valid hue',
    washedOut.some((w) => w.includes('nearly colourless')), washedOut.find((w) => w.includes('colourless')) || '');
check('...and the hue check alone would NOT have caught it',
    hueGap('#2e9b57', '#8a8f98') > 40, `${Math.round(hueGap('#2e9b57', '#8a8f98'))} degrees apart`);

// --- 4. loading and validation ----------------------------------------------
console.log('\nloading');
clear();
let r = loadTheme(TMP);
check('a missing file is not an error', !r.exists && !r.theme && r.errors.length === 0);

write({ label: 'Acme', vars: { '--se-panel': '#101820', '--se-accent': '#e8734a' } });
r = loadTheme(TMP);
check('a partial theme loads', r.theme !== null && r.theme.label === 'Acme');
check('only the set variables come back', r.theme && Object.keys(r.theme.vars).length === 2);
check('the rest are reported as inherited', r.warnings.some((w) => w.includes('inheriting Classic')));

write({ vars: { '--se-panel': '#101820' } });
r = loadTheme(TMP);
check('a missing label defaults to Custom', r.theme && r.theme.label === 'Custom');

write({ label: 'Bad', vars: { '--se-panel': 'rebeccapurple' } });
r = loadTheme(TMP);
check('a non-hex value is rejected', r.theme === null && r.errors.some((e) => e.includes('not a hex colour')));

write({ label: 'Sneaky', vars: { '--se-panel': 'url(http://example.invalid/x.png)' } });
r = loadTheme(TMP);
check('a url() value is rejected, not passed through', r.theme === null && r.errors.length > 0);

write({ label: 'Extra', vars: { '--se-panel': '#101820', '--evil': '#000000', 'colour': 'blue' } });
r = loadTheme(TMP);
check('unknown keys are dropped, not returned',
    r.theme !== null && !('--evil' in r.theme.vars) && !('colour' in r.theme.vars));
check('and they are reported rather than silently ignored',
    r.warnings.some((w) => w.includes('unrecognised')));

write('{ not json');
r = loadTheme(TMP);
check('malformed JSON is an error, not a crash', r.theme === null && r.errors.some((e) => e.includes('not valid JSON')));

write({ label: 'Empty', vars: {} });
r = loadTheme(TMP);
check('a theme setting nothing is refused', r.theme === null && r.errors.length > 0);

write(['not', 'an', 'object']);
r = loadTheme(TMP);
check('an array is refused', r.theme === null && r.errors.length > 0);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
