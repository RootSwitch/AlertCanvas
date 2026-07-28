'use strict';
// Print a shipped theme as a theme.json you can edit.
//
//   node tools/export-theme.js                 # list the shipped themes
//   node tools/export-theme.js nocturne        # print it
//   node tools/export-theme.js nocturne > data/theme.json
//
// The point is that nobody should have to learn the format from documentation:
// start from whichever of the 29 is closest, change the colours you care
// about, and delete the lines you do not. Unset variables inherit Classic.
//
// It EVALUATES public/themes.js rather than keeping its own copy of the
// palettes - a second copy would drift, and the drift would be invisible until
// someone exported a theme that no longer matched the app.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'public', 'themes.js');

// themes.js is browser code: an IIFE that touches window, localStorage,
// document and fetch, then hands back window.Themes. Stub exactly those four
// and it runs unmodified under Node.
function loadShippedThemes() {
    const src = fs.readFileSync(SRC, 'utf8');
    const win = {};
    const sandbox = {
        window: win,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { documentElement: { style: { removeProperty() {}, setProperty() {} } } },
        // Resolving to null takes the "no custom theme" path without a network
        // call; the fetch chain handles it and settles.
        fetch: () => Promise.resolve(null),
        console: { warn() {}, error() {} }
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));
    if (!win.Themes || !win.Themes.THEMES) {
        console.error(`could not read THEMES out of ${SRC} - has its shape changed?`);
        process.exit(1);
    }
    return win.Themes.THEMES;
}

const THEMES = loadShippedThemes();
const want = (process.argv[2] || '').trim();

if (!want) {
    console.error('Usage: node tools/export-theme.js <name> [> data/theme.json]\n');
    console.error('Shipped themes:');
    let group = null;
    for (const [key, t] of Object.entries(THEMES)) {
        if (t.group !== group) { group = t.group; console.error(`\n  ${group || 'Default'}`); }
        console.error(`    ${key.padEnd(14)} ${t.label}`);
    }
    console.error('\nClassic sets no variables (it IS the stylesheet default), so exporting');
    console.error('it gives you the fifteen names with the built-in values filled in.');
    process.exit(2);
}

const t = THEMES[want];
if (!t) {
    console.error(`no shipped theme called "${want}" - run without arguments to list them.`);
    process.exit(1);
}

// Classic carries no vars (it is the stylesheet's :root), so seed the full set
// from style.css rather than emitting an empty object that teaches nothing.
const CLASSIC = {
    '--se-panel': '#262a33', '--se-panel-2': '#2d323d', '--se-input': '#1b1e25',
    '--se-border': '#3a4150', '--se-txt': '#e6e9ef', '--se-txt-dim': '#9aa3b2',
    '--se-accent': '#4c8bf5', '--se-active': '#0066cc', '--se-up': '#2e9b57',
    '--se-down': '#d64545', '--se-warn': '#d9a92f', '--se-unknown': '#8a8f98',
    '--se-series-out': '#2e9b57', '--se-logo-a': '#4c8bf5', '--se-logo-b': '#2e9b57'
};

const vars = { ...CLASSIC, ...t.vars };
console.log(JSON.stringify({ label: `${t.label} (edited)`, vars }, null, 2));
