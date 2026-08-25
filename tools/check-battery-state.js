'use strict';
// A `state` sensor reading 1 is an emergency on a UPS and a normal Tuesday on
// a laptop, and the threshold cannot tell them apart on its own. This pins the
// discriminator: what ELSE the host reports.
//
//   node tools/check-battery-state.js
//
// The case that prompted it, from a real fleet: an ROG Ally X reporting
// "Power: On battery" with 7h 9m of runtime left and nothing wrong with it.
// The shipped default (state crit at 1) held a crit for as long as it stayed
// undocked. The fixtures below are the four device shapes that matter, taken
// from that fleet rather than imagined.

const assert = require('node:assert');
const rules = require('../server/rules');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; }
    catch (err) { console.error(`FAIL: ${name}`); console.error(err.message); process.exit(1); }
}

const M = (host, kind, value, code) => ({ host, kind, code: code || `${host}-${kind}`, value, display: `${host} ${kind}`, unit: '' });

// A handheld: battery, a filesystem, and a state sensor that says "unplugged".
const handheld = [
    M('AllyX', 'battery', 70), M('AllyX', 'runtime', 25740), M('AllyX', 'state', 1),
    M('AllyX', 'cpu', 2), M('AllyX', 'mem', 40), M('AllyX', 'disk', 77)
];
// A UPS: battery and runtime, no operating system anywhere.
const ups = [
    M('SRT2200', 'battery', 100), M('SRT2200', 'runtime', 1800), M('SRT2200', 'state', 1),
    M('SRT2200', 'util', 22)
];
// A switch: cpu and memory, a state sensor for a PSU or fan alarm, no battery.
const sw = [
    M('CRS317', 'cpu', 9), M('CRS317', 'mem', 40), M('CRS317', 'state', 1)
];

const config = (extra = {}) => ({
    thresholds: { state: { warn: null, crit: 1 }, cpu: { warn: 85, crit: 95 }, ...extra.thresholds },
    ifRules: { down: { enabled: true, severity: 'crit' }, errors: { warn: 1, crit: 10 }, discards: { warn: 5, crit: 50 }, util: { warn: 80, crit: 95 } },
    deviceDown: { enabled: false },
    overrides: extra.overrides || []
});
const sev = (metrics, host, cfg) => {
    const c = rules.evaluate({ metrics }, cfg || config())
        .find((x) => x.key === `metric:${host}-state`);
    return c ? c.severity : 'no-condition';
};

// --- the classifier itself ------------------------------------------------
test('a host with battery AND disk is battery-powered', () => {
    assert.ok(rules.batteryPoweredHosts(handheld).has('AllyX'));
});
test('a UPS is not - no filesystem, and no appliance has one', () => {
    assert.ok(!rules.batteryPoweredHosts(ups).has('SRT2200'));
});
test('a switch is not - no battery at all', () => {
    assert.ok(!rules.batteryPoweredHosts(sw).has('CRS317'));
});
test('a host reporting only one of the two does not qualify', () => {
    assert.ok(!rules.batteryPoweredHosts([M('x', 'battery', 50)]).has('x'));
    assert.ok(!rules.batteryPoweredHosts([M('x', 'disk', 50)]).has('x'));
});
test('classification is per host, not per feed', () => {
    const both = rules.batteryPoweredHosts(handheld.concat(ups));
    assert.ok(both.has('AllyX') && !both.has('SRT2200'));
});

// --- what that does to the alert ------------------------------------------
test('an unplugged laptop raises nothing', () => {
    assert.strictEqual(sev(handheld, 'AllyX'), 'no-condition');
});
test('a UPS on battery still crits - the case the default exists for', () => {
    assert.strictEqual(sev(ups, 'SRT2200'), 'crit');
});
test("a switch's fault state still crits", () => {
    assert.strictEqual(sev(sw, 'CRS317'), 'crit');
});
test('the two coexist in one feed without affecting each other', () => {
    const mixed = handheld.concat(ups);
    assert.strictEqual(sev(mixed, 'AllyX'), 'no-condition');
    assert.strictEqual(sev(mixed, 'SRT2200'), 'crit');
});

// --- it is a DEFAULT, not a mute ------------------------------------------
// The operator has to be able to say "actually, do alert me when this one
// unplugs" - a cafe watching charging docks would want exactly that.
test('a host override re-enables it on a battery-powered host', () => {
    const cfg = config({ overrides: [{ scope: 'host-kind', code: null, host: 'AllyX', kind: 'state', warn: null, crit: 1, severity: null, enabled: 1 }] });
    assert.strictEqual(sev(handheld, 'AllyX', cfg), 'crit');
});
test('a code override does too', () => {
    const cfg = config({ overrides: [{ scope: 'code', code: 'AllyX-state', host: null, kind: 'state', warn: null, crit: 1, severity: null, enabled: 1 }] });
    assert.strictEqual(sev(handheld, 'AllyX', cfg), 'crit');
});

// --- the suppression is visible, not silent -------------------------------
test('the Watching page names the reason instead of showing a blank', () => {
    const info = rules.explain({ metrics: handheld }, config());
    const row = (info.metrics || []).find((r) => r.code === 'AllyX-state');
    assert.ok(row, 'the state row is still listed');
    assert.strictEqual(row.source, 'battery-powered host', `source was ${row.source}`);
});

// --- nothing else moved ---------------------------------------------------
test('other kinds on a battery-powered host are untouched', () => {
    const cfg = config({ thresholds: { cpu: { warn: 1, crit: 2 } } });
    const c = rules.evaluate({ metrics: handheld }, cfg).find((x) => x.key === 'metric:AllyX-cpu');
    assert.ok(c && c.severity === 'crit', 'cpu still evaluates normally');
});
test('an empty feed does not throw', () => {
    assert.strictEqual(rules.batteryPoweredHosts(undefined).size, 0);
    assert.strictEqual(rules.batteryPoweredHosts([]).size, 0);
    assert.strictEqual(rules.batteryPoweredHosts([null, {}]).size, 0);
});

console.log(`ok - ${passed} tests passed`);
