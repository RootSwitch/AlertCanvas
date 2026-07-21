'use strict';
// Tests for the notification formatter (server/templates.js). Plain node +
// assert, no framework - run via `npm test` or `node tools/test-templates.js`.
// The point of the {{detail}}/{{reading}} vars is that value-less alarms read
// as plain English instead of "value -- (threshold --)".

const assert = require('node:assert');
const T = require('../server/templates');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; }
    catch (err) { console.error(`FAIL: ${name}`); console.error(err.message); process.exit(1); }
}

const BODY_RAISE = '{{label}} is {{severity}}: {{detail}}.';
const BODY_CLEAR = '{{label}} returned to normal after {{duration}}.{{reading}}';

function raiseBody(alert) { return T.render(BODY_RAISE, T.varsFor(alert, 'raise')); }

// --- a normal metric breach still reads value/threshold ---
test('metric breach keeps value (threshold X)', () => {
    const body = raiseBody({ kind: 'temp', label: 'sw1 Temp', severity: 'crit',
        value: 58, threshold: 55, unit: 'C' });
    assert.strictEqual(body, 'sw1 Temp is crit: value 58C (threshold 55C).');
});

// --- the reported bug: a down device no longer says "value -- (threshold --)" ---
test('device-down reads as a plain statement, no -- placeholders', () => {
    const body = raiseBody({ kind: 'device-down', label: 'U7-Pro-XG (a.b.c.d) device',
        severity: 'crit', value: null, threshold: null, unit: '' });
    assert.ok(!body.includes('--'), `unexpected -- in: ${body}`);
    assert.strictEqual(body,
        'U7-Pro-XG (a.b.c.d) device is crit: not reporting in the status feed (unreachable or powered off).');
});

test('downed link reads "link is down"', () => {
    const body = raiseBody({ kind: 'if-down', label: 'sw1 Gi0/1 link', severity: 'crit',
        value: null, threshold: null, unit: '' });
    assert.strictEqual(body, 'sw1 Gi0/1 link is crit: link is down.');
});

test('reboot event reads "recently rebooted" despite a numeric uptime value', () => {
    const body = raiseBody({ kind: 'reboot', label: 'h1 rebooted (uptime 9d 1h -> 2m)',
        severity: 'warn', value: 120, threshold: null, unit: 's' });
    assert.ok(body.includes('recently rebooted'), body);
    assert.ok(!body.includes('--'), body);
});

test('feed watchdog explains the status feed', () => {
    const body = raiseBody({ kind: 'watchdog', label: 'status feed - ECONNREFUSED',
        severity: 'crit', value: null, threshold: null, unit: '' });
    assert.ok(body.includes('status feed'), body);
    assert.ok(!body.includes('--'), body);
});

// --- clear: reading suffix present for metrics, empty (not --) for value-less ---
test('metric clear shows recovered reading', () => {
    const body = T.render(BODY_CLEAR, T.varsFor(
        { kind: 'temp', label: 'sw1 Temp', value: 44, unit: 'C', raised_ts: 0, cleared_ts: 720 }, 'clear'));
    assert.ok(body.endsWith('(now 44C)'), body);
});

test('device-down clear has no (value --) tail', () => {
    const body = T.render(BODY_CLEAR, T.varsFor(
        { kind: 'device-down', label: 'U7-Pro-XG (a.b.c.d) device', value: null, unit: '',
            raised_ts: 0, cleared_ts: 720 }, 'clear'));
    assert.ok(!body.includes('--'), body);
    assert.ok(!body.includes('(now'), body);
});

// --- the time var is UTC/Zulu and space-separated ---
test('time renders as UTC with a trailing Z', () => {
    const { time } = T.varsFor({ kind: 'temp', value: 1, threshold: 1 }, 'raise');
    assert.match(time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/, time);
});

console.log(`ok - ${passed} tests passed`);
