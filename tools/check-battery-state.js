'use strict';
// A `state` sensor reading 1 is an emergency on a UPS and a normal Tuesday on
// a laptop. This pins how AlertCanvas handles that ambiguity - which is by
// REFUSING TO GUESS, after an earlier version of this file guessed wrong.
//
//   node tools/check-battery-state.js
//
// The history matters, because the tempting fix is the one that was removed.
// A handheld reporting "On battery" with 7h 9m left held a crit for as long
// as it stayed undocked, so `state` was suppressed on any host reporting BOTH
// a battery and a filesystem - no UPS or PDU has a filesystem, so the shape
// looked decisive.
//
// It is not. A SERVER wired to a UPS reports that UPS's battery and runtime
// through its own agent, next to its own disks, and is byte-for-byte a laptop
// in the feed. Three Proxmox hosts on a real fleet did exactly that. The
// suppression would have silenced the alarm they exist to raise.
//
// So the classifier survives as a HINT and never as a decision, and the tests
// below exist mostly to keep it that way: the fourth fixture is the
// counterexample, and it is the one that must never go quiet.

const assert = require('node:assert');
const rules = require('../server/rules');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; }
    catch (err) { console.error(`FAIL: ${name}`); console.error(err.message); process.exit(1); }
}

const M = (host, kind, value, code) => ({ host, kind, code: code || `${host}-${kind}`, value, display: `${host} ${kind}`, unit: '' });

// A handheld: its own battery, its own disk, unplugged.
const handheld = [
    M('handheld-1', 'battery', 70), M('handheld-1', 'runtime', 25740), M('handheld-1', 'state', 1),
    M('handheld-1', 'cpu', 2), M('handheld-1', 'mem', 40), M('handheld-1', 'disk', 77)
];
// A UPS: battery and runtime, no operating system anywhere.
const ups = [
    M('ups-1', 'battery', 100), M('ups-1', 'runtime', 1800), M('ups-1', 'state', 1),
    M('ups-1', 'util', 22)
];
// A switch: cpu and memory, a state sensor for a PSU or fan alarm, no battery.
const sw = [
    M('sw-1', 'cpu', 9), M('sw-1', 'mem', 40), M('sw-1', 'state', 1)
];
// THE COUNTEREXAMPLE. A Proxmox host reporting its APC through its own agent:
// the UPS's battery and runtime, and the server's own cpu, memory and disks.
// Indistinguishable from the handheld above by shape alone, and the opposite
// thing entirely when it says "on battery".
const upsBackedServer = [
    M('srv-1', 'battery', 100), M('srv-1', 'runtime', 7680), M('srv-1', 'state', 1),
    M('srv-1', 'cpu', 14), M('srv-1', 'mem', 61), M('srv-1', 'disk', 44)
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

// --- THE INVARIANT: a state sensor is never silenced by inference ----------
// Every one of these is a device somebody would be furious to miss.
test('a UPS on battery crits', () => {
    assert.strictEqual(sev(ups, 'ups-1'), 'crit');
});
test('a UPS-BACKED SERVER on battery crits - the case that killed the guess', () => {
    assert.strictEqual(sev(upsBackedServer, 'srv-1'), 'crit');
});
test("a switch's fault state crits", () => {
    assert.strictEqual(sev(sw, 'sw-1'), 'crit');
});
test('and so does a laptop, because the app cannot tell it from the server', () => {
    assert.strictEqual(sev(handheld, 'handheld-1'), 'crit');
});
test('one feed carrying all four silences none of them', () => {
    const all = handheld.concat(ups, sw, upsBackedServer);
    for (const h of ['handheld-1', 'ups-1', 'sw-1', 'srv-1']) {
        assert.strictEqual(sev(all, h), 'crit', `${h} went quiet`);
    }
});

// --- the operator's lever still works -------------------------------------
test('a host override mutes the laptop, which is how the noise goes away', () => {
    const cfg = config({ overrides: [{ scope: 'host-kind', code: null, host: 'handheld-1', kind: 'state', warn: null, crit: null, severity: null, enabled: 0 }] });
    assert.strictEqual(sev(handheld, 'handheld-1', cfg), 'no-condition');
});
test('...and muting the laptop does not touch the server', () => {
    const cfg = config({ overrides: [{ scope: 'host-kind', code: null, host: 'handheld-1', kind: 'state', warn: null, crit: null, severity: null, enabled: 0 }] });
    assert.strictEqual(sev(handheld.concat(upsBackedServer), 'srv-1', cfg), 'crit');
});

// --- the hint: information only -------------------------------------------
test('the hint marks a battery-plus-disk host', () => {
    const row = rules.explain({ metrics: handheld }, config()).metrics.find((r) => r.code === 'handheld-1-state');
    assert.strictEqual(row.batteryHost, true);
});
test('...and marks the UPS-backed server too, because it cannot tell', () => {
    const row = rules.explain({ metrics: upsBackedServer }, config()).metrics.find((r) => r.code === 'srv-1-state');
    assert.strictEqual(row.batteryHost, true, 'the hint is honest about its own ambiguity');
});
test('a real UPS is not marked - no filesystem', () => {
    const row = rules.explain({ metrics: ups }, config()).metrics.find((r) => r.code === 'ups-1-state');
    assert.strictEqual(row.batteryHost, undefined);
});
test('the hint never appears on a kind other than state', () => {
    const rows = rules.explain({ metrics: handheld }, config()).metrics;
    for (const r of rows) {
        if (r.kind !== 'state') assert.strictEqual(r.batteryHost, undefined, `${r.kind} was marked`);
    }
});
test('the hint does not change the rule it sits beside', () => {
    const row = rules.explain({ metrics: handheld }, config()).metrics.find((r) => r.code === 'handheld-1-state');
    assert.deepStrictEqual(row.rule, { warn: null, crit: 1 });
    assert.strictEqual(row.source, 'default');
});

// --- the classifier itself -------------------------------------------------
test('battery AND disk is the shape it detects', () => {
    assert.ok(rules.batteryPoweredHosts(handheld).has('handheld-1'));
    assert.ok(rules.batteryPoweredHosts(upsBackedServer).has('srv-1'));
    assert.ok(!rules.batteryPoweredHosts(ups).has('ups-1'));
    assert.ok(!rules.batteryPoweredHosts(sw).has('sw-1'));
});
test('one of the two is not enough', () => {
    assert.ok(!rules.batteryPoweredHosts([M('x', 'battery', 50)]).has('x'));
    assert.ok(!rules.batteryPoweredHosts([M('x', 'disk', 50)]).has('x'));
});
test('an empty or malformed feed does not throw', () => {
    assert.strictEqual(rules.batteryPoweredHosts(undefined).size, 0);
    assert.strictEqual(rules.batteryPoweredHosts([]).size, 0);
    assert.strictEqual(rules.batteryPoweredHosts([null, {}]).size, 0);
});

console.log(`ok - ${passed} tests passed`);
