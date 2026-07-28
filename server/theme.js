'use strict';
// Custom theme slot: one operator-supplied palette, read from the data
// directory rather than shipped in the image.
//
// The 29 built-in themes live in public/themes.js and are PRODUCT - they are
// duplicated across six repos, the style guide and the demo, so every addition
// is drift. A user's own palette must not join that set. It lives here instead,
// in the bind mount, where editing it needs no rebuild and no repo change.
//
// This module is the ONLY definition of what a valid theme.json is. The API
// route and tools/check-theme.js both call it, so the checker can never accept
// something the server rejects, or the reverse.

const fs = require('node:fs');
const path = require('node:path');

// The fifteen chrome variables, same list and order as public/themes.js.
const THEME_VARS = [
    '--se-panel', '--se-panel-2', '--se-input', '--se-border',
    '--se-txt', '--se-txt-dim', '--se-accent', '--se-active',
    '--se-up', '--se-down', '--se-warn', '--se-unknown', '--se-series-out',
    '--se-logo-a', '--se-logo-b'
];

// Hex only, deliberately. Every shipped theme is hex, it keeps the format one
// obvious thing to copy, and it forecloses the question of what else a CSS
// custom property could carry - a url() in a value reachable from var() would
// be a request this app never intended to make.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// --- colour maths (WCAG 2.1 relative luminance and contrast ratio) ----------
function toRgb(hex) {
    let h = hex.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance(hex) {
    const [r, g, b] = toRgb(hex).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function hue(hex) {
    const [r, g, b] = toRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null;                       // grey has no hue
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
}
function hueGap(a, b) {
    const ha = hue(a), hb = hue(b);
    if (ha === null || hb === null) return null;    // one is grey: hue cannot separate them
    const d = Math.abs(ha - hb);
    return d > 180 ? 360 - d : d;
}
// HSL saturation. Hue alone is not enough for a state colour: #8a8f98 is a
// blue-grey with a perfectly good hue 74 degrees off green, and still reads as
// "no data" rather than "failed" because there is no colour in it. Caught by a
// test that expected the hue check to cover this and found it did not.
function saturation(hex) {
    const [r, g, b] = toRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    const l = (max + min) / 2;
    return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

// --- the checks that matter on a wall display -------------------------------
// Readability is the obvious one. The one people do not think of is that
// --se-up and --se-down encode STATE on a monitoring board: a palette where
// they do not separate at a glance is a safety problem, not a taste problem.
// Nothing here refuses a theme - an operator may have reasons - but it says so.
function auditContrast(vars) {
    const w = [];
    const at = (k) => vars[k];
    const pair = (fg, bg, min, what) => {
        if (!at(fg) || !at(bg)) return;
        const r = contrast(at(fg), at(bg));
        if (r < min) {
            w.push(`${what}: ${at(fg)} on ${at(bg)} is ${r.toFixed(1)}:1, below the ${min}:1 needed to read comfortably`);
        }
    };
    pair('--se-txt', '--se-panel', 4.5, 'body text');
    pair('--se-txt-dim', '--se-panel', 3.0, 'secondary text');
    pair('--se-accent', '--se-panel', 3.0, 'links and focus rings');

    if (at('--se-up') && at('--se-down')) {
        const gap = hueGap(at('--se-up'), at('--se-down'));
        if (gap === null) {
            w.push('up/down: one of them is a grey, so nothing but brightness separates healthy from failed');
        } else if (gap < 40) {
            w.push(`up/down: only ${Math.round(gap)} degrees of hue apart - healthy and failed will look alike at a glance`);
        }
    }
    // --se-unknown is deliberately colourless - "no data" should look inert.
    // up, down and warn are the opposite: they must read as a state from across
    // a room, and a washed-out one reads as no state at all.
    for (const k of ['--se-up', '--se-down', '--se-warn']) {
        if (!at(k)) continue;
        const s = saturation(at(k));
        if (s < 0.15) {
            w.push(`${k}: ${at(k)} is nearly colourless (saturation ${(s * 100).toFixed(0)}%) - it will read as "no data" rather than a state`);
        }
    }
    return w;
}

// --- load + validate --------------------------------------------------------
// Returns { theme, warnings, errors, path, exists }. A missing file is not an
// error: the custom slot is optional and absence is the normal case.
function loadTheme(dataDir) {
    const file = path.join(dataDir, 'theme.json');
    const out = { theme: null, warnings: [], errors: [], path: file, exists: false };

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') out.errors.push(`cannot read ${file}: ${err.message}`);
        return out;
    }
    out.exists = true;

    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (err) {
        out.errors.push(`${file} is not valid JSON: ${err.message}`);
        return out;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        out.errors.push('theme.json must be a JSON object');
        return out;
    }
    if (!doc.vars || typeof doc.vars !== 'object' || Array.isArray(doc.vars)) {
        out.errors.push('theme.json needs a "vars" object mapping --se-* names to hex colours');
        return out;
    }

    // Rebuild rather than pass through: only names we know, only values we have
    // validated. Whatever else the file contains never reaches a browser.
    const vars = {};
    const unknown = [];
    for (const [k, v] of Object.entries(doc.vars)) {
        if (!THEME_VARS.includes(k)) { unknown.push(k); continue; }
        if (typeof v !== 'string' || !HEX.test(v)) {
            out.errors.push(`${k}: "${v}" is not a hex colour (use #rgb, #rrggbb or #rrggbbaa)`);
            continue;
        }
        vars[k] = v;
    }
    if (unknown.length) {
        out.warnings.push(`ignored ${unknown.length} unrecognised key(s): ${unknown.join(', ')}`);
    }
    if (!Object.keys(vars).length) {
        out.errors.push('no recognised --se-* variables found - nothing to apply');
        return out;
    }
    if (out.errors.length) return out;

    // Unset variables fall through to the stylesheet's Classic defaults, which
    // is a feature: a theme.json can change three colours and leave the rest.
    const missing = THEME_VARS.filter((k) => !(k in vars));
    if (missing.length) {
        out.warnings.push(`${missing.length} variable(s) not set, inheriting Classic: ${missing.join(', ')}`);
    }
    out.warnings.push(...auditContrast(vars));

    const label = typeof doc.label === 'string' && doc.label.trim()
        ? doc.label.trim().slice(0, 40) : 'Custom';
    out.theme = { label, vars };
    return out;
}

module.exports = { loadTheme, THEME_VARS, contrast, hueGap, auditContrast };
