'use strict';
// The Watching list's Device column must sort like addresses when it holds
// addresses.
//
//   node tools/check-sort.js
//
// The column shows the feed's `host`, which is SNMPCanvas's device NAME - and
// SNMPCanvas names a device after its address whenever the device reports no
// sysName. Bulk-adding a list of addresses is the documented way to onboard a
// fleet, so this column fills with addresses on exactly the recommended path,
// and a plain string compare then puts 192.168.1.10 above 192.168.1.9.
//
// hostSortKey and byHostThen live in public/app.js, browser code with no module
// boundary. Their real source is EXTRACTED and evaluated rather than
// re-implemented here - a copy would drift and prove nothing. Same trick as
// SNMPCanvas's check-sort.js and PingCanvas's kiosk schema test.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'public', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');

// Brace-match a `function name(...) {...}` or a `const name = ...{...};`.
function extract(decl) {
    const start = src.indexOf(decl);
    if (start < 0) throw new Error(`${decl} not found in public/app.js`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return src.slice(start, i + 1) + (decl.startsWith('const') ? ';' : '');
        }
    }
    throw new Error(`unbalanced braces reading ${decl}`);
}

const api = new Function(
    extract('function expandIPv6(') + '\n' +
    extract('function hostSortKey(') + '\n' +
    extract('const byHostThen =') + '\n' +
    'return { hostSortKey: hostSortKey, byHostThen: byHostThen };')();
const { hostSortKey, byHostThen } = api;

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

// --- the key ----------------------------------------------------------------
const byKey = (list) => list.slice().sort((a, b) => {
    const x = hostSortKey(a), y = hostSortKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
});
const order = (name, input, expected) => {
    const got = byKey(input);
    check(name, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
};

order('addresses sort numerically',
    ['192.168.1.100', '192.168.1.9', '192.168.1.10'],
    ['192.168.1.9', '192.168.1.10', '192.168.1.100']);
order('leading octet too',
    ['10.0.0.1', '9.9.9.9', '172.16.0.1'],
    ['9.9.9.9', '10.0.0.1', '172.16.0.1']);
order('IPv6 numerically',
    ['2001:db8::10', '2001:db8::2'],
    ['2001:db8::2', '2001:db8::10']);
order('addresses band before names - the list is MIXED here',
    ['core-sw1', '10.0.0.5', 'branch-rtr'],
    ['10.0.0.5', 'branch-rtr', 'core-sw1']);
check('a malformed address falls to the name band', hostSortKey('999.1.1.1').startsWith('3'));
check('null does not throw', hostSortKey(null) === '3');

// --- the row comparator, where the secondary sort could hide a bug ----------
const rows = (list) => list.map((r) => r.host + '/' + r.kind);
const metricCmp = byHostThen((m) => String(m.kind || ''));

check('same host: falls through to the secondary field',
    JSON.stringify(rows([{ host: '10.0.0.2', kind: 'temp' }, { host: '10.0.0.2', kind: 'cpu' }].sort(metricCmp)))
        === JSON.stringify(['10.0.0.2/cpu', '10.0.0.2/temp']));

check('different hosts: address order wins over the secondary field',
    JSON.stringify(rows([{ host: '10.0.0.10', kind: 'cpu' }, { host: '10.0.0.2', kind: 'temp' }].sort(metricCmp)))
        === JSON.stringify(['10.0.0.2/temp', '10.0.0.10/cpu']));

check('mixed name and address rows do not interleave',
    JSON.stringify([{ host: 'sw-a', kind: 'cpu' }, { host: '10.0.0.9', kind: 'cpu' }, { host: '10.0.0.10', kind: 'cpu' }]
        .sort(metricCmp).map((r) => r.host))
        === JSON.stringify(['10.0.0.9', '10.0.0.10', 'sw-a']));

check('a missing secondary field does not throw',
    (() => { try { [{ host: 'a' }, { host: 'a' }].sort(metricCmp); return true; } catch (_) { return false; } })());

console.log(failures ? `\n${failures} check(s) FAILED` : '\nwatching-list sort intact');
process.exit(failures ? 1 : 0);
