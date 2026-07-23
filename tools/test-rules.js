'use strict';
// Tests for the alerting brain (server/rules.js). Plain node + assert, no
// framework - run with `npm test` or `node tools/test-rules.js`. Exits
// non-zero on the first failure. rules.js is pure, so every case is just
// (doc, config) in -> conditions out.

const assert = require('node:assert');
const rules = require('../server/rules');

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; }
    catch (err) {
        console.error(`FAIL: ${name}`);
        console.error(err.message);
        process.exit(1);
    }
}

// --- fixtures ---
function config(extra = {}) {
    return {
        thresholds: {
            cpu: { warn: 85, crit: 95 },
            temp: { warn: 45, crit: 55 },
            battery: { warn: 50, crit: 20 },
            runtime: { warn: 600, crit: 300 },
            fan: null,
            ...extra.thresholds
        },
        ifRules: {
            down: { enabled: true, severity: 'crit' },
            errors: { warn: 1, crit: 10 },
            discards: { warn: 5, crit: 50 },
            util: { warn: 80, crit: 95 },
            ...extra.ifRules
        },
        deviceDown: extra.deviceDown || { enabled: true, severity: 'crit' },
        overrides: extra.overrides || []
    };
}

function metric(over = {}) {
    return { code: 'M1', kind: 'cpu', host: 'h1', display: 'CPU 50%', value: 50, unit: '%', ...over };
}

function iface(over = {}) {
    return {
        id: 'sw1:eth0', code: 'I1', device: { name: 'sw1', host: '10.0.0.1', status: 'up' },
        name: 'eth0', alias: '', speedBps: 1e9, adminStatus: 'up', operStatus: 'up',
        inBps: 1000, outBps: 2000, inErrorsPerSec: 0, outErrorsPerSec: 0,
        inDiscardsPerSec: 0, outDiscardsPerSec: 0, ...over
    };
}

function evalOne(doc, cfg) { return rules.evaluate(doc, cfg || config()); }
function byKey(conds, key) {
    const c = conds.find((x) => x.key === key);
    assert.ok(c, `expected a condition with key ${key}; got ${conds.map((x) => x.key).join(', ')}`);
    return c;
}

// --- higher-is-bad thresholds ---
test('cpu below warn is normal', () => {
    const c = byKey(evalOne({ metrics: [metric({ value: 84 })] }), 'metric:M1');
    assert.strictEqual(c.severity, null);
    assert.strictEqual(c.frozen, false);
});
test('cpu at warn is warn, at crit is crit', () => {
    assert.strictEqual(byKey(evalOne({ metrics: [metric({ value: 85 })] }), 'metric:M1').severity, 'warn');
    assert.strictEqual(byKey(evalOne({ metrics: [metric({ value: 95 })] }), 'metric:M1').severity, 'crit');
});
test('threshold value is reported', () => {
    const c = byKey(evalOne({ metrics: [metric({ value: 90 })] }), 'metric:M1');
    assert.strictEqual(c.threshold, 85);
    assert.strictEqual(byKey(evalOne({ metrics: [metric({ value: 96 })] }), 'metric:M1').threshold, 95);
});

// --- lower-is-bad kinds ---
test('battery alerts low, not high', () => {
    const m = (v) => metric({ kind: 'battery', value: v, display: `Batt ${v}%` });
    assert.strictEqual(byKey(evalOne({ metrics: [m(100)] }), 'metric:M1').severity, null);
    assert.strictEqual(byKey(evalOne({ metrics: [m(50)] }), 'metric:M1').severity, 'warn');
    assert.strictEqual(byKey(evalOne({ metrics: [m(20)] }), 'metric:M1').severity, 'crit');
});
test('runtime is lower-is-bad', () => {
    const c = byKey(evalOne({ metrics: [metric({ kind: 'runtime', value: 200, unit: 's' })] }), 'metric:M1');
    assert.strictEqual(c.severity, 'crit');
});

// --- null / unknown handling ---
test('null value freezes, never clears or raises', () => {
    const c = byKey(evalOne({ metrics: [metric({ value: null })] }), 'metric:M1');
    assert.strictEqual(c.frozen, true);
    assert.strictEqual(c.severity, null);
});
test('non-numeric metric values freeze instead of evaluating', () => {
    // Number('') === 0 and Number(true) === 1 - neither is a reading. An
    // empty-string battery value must not read as 0% (instant false crit).
    for (const junk of ['', true, '42', {}]) {
        const c = byKey(evalOne({ metrics: [metric({ kind: 'battery', value: junk })] }), 'metric:M1');
        assert.strictEqual(c.frozen, true, `value ${JSON.stringify(junk)} should freeze`);
        assert.strictEqual(c.severity, null);
    }
});
test('garbage interface rates freeze instead of reading normal', () => {
    const conds = evalOne({ interfaces: [iface({ inErrorsPerSec: 'abc', outErrorsPerSec: 'abc' })] });
    assert.strictEqual(byKey(conds, 'if:I1:errors').frozen, true);
});
test('entries without a code are skipped, odd shapes do not throw', () => {
    const conds = evalOne({
        interfaces: [iface({ code: undefined }), { id: undefined, device: null, code: 'I9', name: 'x', adminStatus: 'up', operStatus: 'up', speedBps: 0 }],
        metrics: [metric({ code: undefined })]
    });
    assert.strictEqual(conds.find((c) => c.key === 'metric:undefined'), undefined);
    assert.strictEqual(conds.find((c) => c.key === 'if:undefined:down'), undefined);
    assert.ok(byKey(conds, 'if:I9:down')); // survives missing id/device
});
test('unknown kind produces no condition', () => {
    const conds = evalOne({ metrics: [metric({ kind: 'mystery' })] });
    assert.strictEqual(conds.find((c) => c.key === 'metric:M1'), undefined);
});
test('kind with null default produces no condition', () => {
    const conds = evalOne({ metrics: [metric({ kind: 'fan', value: 9000 })] });
    assert.strictEqual(conds.find((c) => c.key === 'metric:M1'), undefined);
});

// --- override precedence ---
test('code override beats host-kind override beats default', () => {
    const doc = { metrics: [metric({ value: 60 })] };
    const hostOnly = config({ overrides: [{ scope: 'host-kind', code: null, host: 'h1', kind: 'cpu', warn: 55, crit: 65, severity: null, enabled: 1 }] });
    assert.strictEqual(byKey(evalOne(doc, hostOnly), 'metric:M1').severity, 'warn');
    const both = config({ overrides: [
        { scope: 'host-kind', code: null, host: 'h1', kind: 'cpu', warn: 55, crit: 65, severity: null, enabled: 1 },
        { scope: 'code', code: 'M1', host: null, kind: 'cpu', warn: 70, crit: 90, severity: null, enabled: 1 }
    ] });
    assert.strictEqual(byKey(evalOne(doc, both), 'metric:M1').severity, null); // code override 70/90: 60 is normal
});
test('disabled override mutes the target', () => {
    const cfg = config({ overrides: [{ scope: 'code', code: 'M1', host: null, kind: 'cpu', warn: 85, crit: 95, severity: null, enabled: 0 }] });
    const conds = evalOne({ metrics: [metric({ value: 99 })] }, cfg);
    assert.strictEqual(conds.find((c) => c.key === 'metric:M1'), undefined);
});
test('override with only crit set still works', () => {
    const cfg = config({ overrides: [{ scope: 'code', code: 'M1', host: null, kind: 'cpu', warn: null, crit: 50, severity: null, enabled: 1 }] });
    assert.strictEqual(byKey(evalOne({ metrics: [metric({ value: 60 })] }, cfg), 'metric:M1').severity, 'crit');
    assert.strictEqual(byKey(evalOne({ metrics: [metric({ value: 40 })] }, cfg), 'metric:M1').severity, null);
});
test('devices[] roster arms up/down for sensor-only devices (no interfaces)', () => {
    const doc = {
        devices: [{ name: 'vm1', host: '192.0.2.10', status: 'down' }],
        metrics: [metric({ code: 'C9', host: 'vm1', value: 50 })]
    };
    const conds = evalOne(doc);
    assert.strictEqual(byKey(conds, 'device:vm1').severity, 'crit');
    const m = byKey(conds, 'metric:C9');
    assert.strictEqual(m.frozen, true);      // down device suppresses its metrics
    assert.strictEqual(m.severity, null);
});
test('devices[] roster: up device stays quiet', () => {
    const doc = {
        devices: [{ name: 'vm1', host: '192.0.2.10', status: 'up' }],
        metrics: [metric({ code: 'C9', host: 'vm1', value: 50 })]
    };
    const conds = evalOne(doc);
    assert.strictEqual(byKey(conds, 'device:vm1').severity, null);
    assert.strictEqual(byKey(conds, 'metric:C9').frozen, false);
});
test('roster and interface device entries dedupe to one condition', () => {
    const doc = {
        devices: [{ name: 'sw1', host: '10.0.0.1', status: 'down' }],
        interfaces: [iface({ device: { name: 'sw1', host: '10.0.0.1', status: 'down' } })]
    };
    const conds = evalOne(doc).filter((c) => c.key === 'device:sw1');
    assert.strictEqual(conds.length, 1);
    assert.strictEqual(conds[0].severity, 'crit');
});
test('LOWER_IS_BAD is exported and covers battery/runtime/uptime', () => {
    // The override validation and the settings order-check both key off this.
    for (const k of ['battery', 'runtime', 'uptime']) assert.ok(rules.LOWER_IS_BAD.has(k), k);
    for (const k of ['cpu', 'temp', 'state']) assert.ok(!rules.LOWER_IS_BAD.has(k), k);
});
test('state kind alarms at crit by default when value is 1, quiet at 0', () => {
    const m = (v) => ({ code: 'S1', kind: 'state', host: 'ups1', display: v ? 'Power On battery' : 'Power Online', value: v, unit: '' });
    const cfg = config({ thresholds: { state: { warn: null, crit: 1 } } });
    assert.strictEqual(byKey(evalOne({ metrics: [m(1)] }, cfg), 'metric:S1').severity, 'crit');
    assert.strictEqual(byKey(evalOne({ metrics: [m(0)] }, cfg), 'metric:S1').severity, null);
});
test('meter kind (amps/volts) has no default threshold but honors an override', () => {
    const m = { code: 'A1', kind: 'meter', host: 'pdu1', display: 'Phase L1 15 A', value: 15, unit: 'A' };
    // No universal number for a raw reading - a meter never alarms by default.
    assert.strictEqual(evalOne({ metrics: [m] }).find((c) => c.key === 'metric:A1'), undefined);
    // Until the user sets one (e.g. warn near a branch-circuit limit).
    const cfg = config({ overrides: [{ scope: 'code', code: 'A1', host: null, kind: 'meter', warn: 12, crit: 16, severity: null, enabled: 1 }] });
    assert.strictEqual(byKey(evalOne({ metrics: [m] }, cfg), 'metric:A1').severity, 'warn');
});

// --- interface rules ---
test('oper down while admin up alarms at configured severity', () => {
    const c = byKey(evalOne({ interfaces: [iface({ operStatus: 'down' })] }), 'if:I1:down');
    assert.strictEqual(c.severity, 'crit');
});
test('admin down is intentional - no alarm', () => {
    const c = byKey(evalOne({ interfaces: [iface({ adminStatus: 'down', operStatus: 'down' })] }), 'if:I1:down');
    assert.strictEqual(c.severity, null);
});
test('unknown statuses freeze the down rule', () => {
    const c = byKey(evalOne({ interfaces: [iface({ adminStatus: 'unknown', operStatus: 'unknown' })] }), 'if:I1:down');
    assert.strictEqual(c.frozen, true);
});
test('worst direction drives error rate', () => {
    const c = byKey(evalOne({ interfaces: [iface({ inErrorsPerSec: 0, outErrorsPerSec: 12 })] }), 'if:I1:errors');
    assert.strictEqual(c.severity, 'crit');
    assert.strictEqual(c.value, 12);
});
test('utilization is percent of speed, worst direction', () => {
    const c = byKey(evalOne({ interfaces: [iface({ inBps: 1e8, outBps: 8.5e8 })] }), 'if:I1:util');
    assert.strictEqual(c.severity, 'warn'); // 85% of 1G
    assert.strictEqual(c.value, 85);
});
test('no speed means no utilization condition', () => {
    const conds = evalOne({ interfaces: [iface({ speedBps: 0 })] });
    assert.strictEqual(conds.find((c) => c.key === 'if:I1:util'), undefined);
});

// --- device down ---
test('down device raises one device alarm and freezes its interface rules', () => {
    const conds = evalOne({ interfaces: [
        iface({ device: { name: 'sw1', host: '10.0.0.1', status: 'down' }, operStatus: 'unknown', adminStatus: 'unknown', inBps: null, outBps: null }),
        iface({ id: 'sw1:eth1', code: 'I2', device: { name: 'sw1', host: '10.0.0.1', status: 'down' }, operStatus: 'unknown', adminStatus: 'unknown', inBps: null, outBps: null })
    ] });
    assert.strictEqual(byKey(conds, 'device:sw1').severity, 'crit');
    assert.strictEqual(conds.filter((c) => c.key.startsWith('device:')).length, 1);
    assert.strictEqual(byKey(conds, 'if:I1:down').frozen, true);
    assert.strictEqual(byKey(conds, 'if:I2:down').frozen, true);
});
test('down device freezes its host metrics too', () => {
    const conds = evalOne({
        interfaces: [iface({ device: { name: 'h1', host: '10.0.0.2', status: 'down' }, id: 'h1:eth0' })],
        metrics: [metric({ value: 99 })]
    });
    assert.strictEqual(byKey(conds, 'metric:M1').frozen, true);
});
test('device-down rule can be muted per host', () => {
    const cfg = config({ overrides: [{ scope: 'host-kind', code: null, host: 'sw1', kind: 'device-down', warn: null, crit: null, severity: null, enabled: 0 }] });
    const conds = evalOne({ interfaces: [iface({ device: { name: 'sw1', host: '10.0.0.1', status: 'down' } })] }, cfg);
    assert.strictEqual(conds.find((c) => c.key === 'device:sw1'), undefined);
});

// --- labels ---
test('metric label keeps the multi-word display name and appends the kind', () => {
    const c = byKey(evalOne({ metrics: [metric({ kind: 'util', display: 'UPS1-Load 85%', value: 85, host: 'ups-host',
        code: 'M1' })] }, config({ thresholds: { util: { warn: 70, crit: 90 } } })), 'metric:M1');
    assert.strictEqual(c.label, 'ups-host UPS1-Load (util)');
});
test('label appends the kind when the name does not say it (compute-01 GPU)', () => {
    const c = byKey(evalOne({ metrics: [metric({ kind: 'util', display: 'GPU 90%', value: 91, host: 'compute-01',
        code: 'M1' })] }, config({ thresholds: { util: { warn: 70, crit: 90 } } })), 'metric:M1');
    assert.strictEqual(c.label, 'compute-01 GPU (util)');
});
test('label skips the kind when redundant (CPU/cpu, Batt/battery, Temp/temp)', () => {
    const cases = [
        [{ kind: 'cpu', display: 'CPU 90%', value: 90 }, 'h1 CPU'],
        [{ kind: 'battery', display: 'Batt 10%', value: 10 }, 'h1 Batt'],
        [{ kind: 'temp', display: 'Temp 60C', value: 60, unit: 'C' }, 'h1 Temp']
    ];
    for (const [over, expected] of cases) {
        const c = byKey(evalOne({ metrics: [metric(over)] }), 'metric:M1');
        assert.strictEqual(c.label, expected);
    }
});
test('interface label includes device, name and alias', () => {
    const c = byKey(evalOne({ interfaces: [iface({ alias: 'Uplink', operStatus: 'down' })] }), 'if:I1:down');
    assert.strictEqual(c.label, 'sw1 eth0 (Uplink) link');
});

// --- explain() sanity ---
test('explain reports source and current state', () => {
    const ex = rules.explain({ metrics: [metric({ value: 90 })], interfaces: [iface()] }, config());
    assert.strictEqual(ex.metrics[0].source, 'default');
    assert.strictEqual(ex.metrics[0].current, 'warn');
    assert.strictEqual(ex.interfaces[0].down.current, 'ok');
    assert.strictEqual(ex.devices[0].host, 'sw1');
});
test('explain flags muted and rule-less values', () => {
    const cfg = config({ overrides: [{ scope: 'code', code: 'M1', host: null, kind: 'cpu', warn: 85, crit: 95, severity: null, enabled: 0 }] });
    const ex = rules.explain({ metrics: [metric(), metric({ code: 'M2', kind: 'fan', display: 'Fan 900rpm', value: 900 })] }, cfg);
    assert.strictEqual(ex.metrics[0].muted, true);
    assert.strictEqual(ex.metrics[1].source, 'none');
    assert.strictEqual(ex.metrics[1].current, null);
});

// --- reboot detection ---
test('uptime going backwards is a reboot', () => {
    const prev = new Map([['U1', 500000]]);
    const evts = rules.detectReboots(prev, [{ code: 'U1', kind: 'uptime', host: 'h1', value: 120 }]);
    assert.strictEqual(evts.length, 1);
    assert.deepStrictEqual(evts[0], { code: 'U1', host: 'h1', from: 500000, to: 120 });
});
test('uptime rising or first sighting is not a reboot', () => {
    const prev = new Map([['U1', 500000]]);
    assert.strictEqual(rules.detectReboots(prev, [{ code: 'U1', kind: 'uptime', host: 'h1', value: 500030 }]).length, 0);
    assert.strictEqual(rules.detectReboots(new Map(), [{ code: 'U1', kind: 'uptime', host: 'h1', value: 120 }]).length, 0);
});
test('small backwards jitter is absorbed, null ignored', () => {
    const prev = new Map([['U1', 500000]]);
    assert.strictEqual(rules.detectReboots(prev, [{ code: 'U1', kind: 'uptime', host: 'h1', value: 499985 }]).length, 0);
    assert.strictEqual(rules.detectReboots(prev, [{ code: 'U1', kind: 'uptime', host: 'h1', value: null }]).length, 0);
});
test('non-uptime kinds never look like reboots', () => {
    const prev = new Map([['M1', 90]]);
    assert.strictEqual(rules.detectReboots(prev, [metric({ value: 5 })]).length, 0);
});

// --- ping feed (evaluatePing) ---
const pingDoc = (devices) => ({ generated: '2026-01-01T00:00:00Z', pollIntervalSec: 15, devices });

test('ping: watched down device raises crit, label preference watch > name > key', () => {
    const doc = pingDoc({
        '203.0.113.1': { state: 'down', latencyMs: null, name: 'ISP A' },
        '198.51.100.1': { state: 'down', latencyMs: null }
    });
    const out = rules.evaluatePing(doc, { '203.0.113.1': { label: 'Primary ISP' }, '198.51.100.1': {} }, {});
    assert.strictEqual(out.length, 2);
    const a = out.find((c) => c.key === 'ping:203.0.113.1');
    assert.strictEqual(a.severity, 'crit');
    assert.strictEqual(a.kind, 'ping-down');
    assert.strictEqual(a.label, 'Primary ISP ping');
    const b = out.find((c) => c.key === 'ping:198.51.100.1');
    assert.strictEqual(b.label, '198.51.100.1 ping');
});
test('ping: unwatched devices are ignored entirely', () => {
    const doc = pingDoc({ '10.0.0.1': { state: 'down' } });
    assert.strictEqual(rules.evaluatePing(doc, {}, {}).length, 0);
});
test('ping: up device emits a normal (clearing) condition with latency', () => {
    const doc = pingDoc({ '10.0.0.1': { state: 'up', latencyMs: 12, name: 'gw' } });
    const [c] = rules.evaluatePing(doc, { '10.0.0.1': {} }, {});
    assert.strictEqual(c.severity, null);
    assert.strictEqual(c.value, 12);
    assert.strictEqual(c.unit, 'ms');
});
test('ping: degraded is normal by default, warn when opted in', () => {
    const doc = pingDoc({ '10.0.0.1': { state: 'degraded', latencyMs: 240 } });
    assert.strictEqual(rules.evaluatePing(doc, { '10.0.0.1': {} }, {})[0].severity, null);
    assert.strictEqual(rules.evaluatePing(doc, { '10.0.0.1': {} }, { degradedWarn: true })[0].severity, 'warn');
});
test('ping: a watched key missing from the feed emits nothing (missing machinery ages it out)', () => {
    const doc = pingDoc({ '10.0.0.1': { state: 'up' } });
    assert.strictEqual(rules.evaluatePing(doc, { '10.9.9.9': {} }, {}).length, 0);
});
test('ping: unknown state freezes instead of clearing', () => {
    const doc = pingDoc({ '10.0.0.1': { state: 'unknown', latencyMs: null } });
    const [c] = rules.evaluatePing(doc, { '10.0.0.1': {} }, {});
    assert.strictEqual(c.severity, null);
    assert.strictEqual(c.frozen, true);
    const [up] = rules.evaluatePing(pingDoc({ '10.0.0.1': { state: 'up', latencyMs: 5 } }), { '10.0.0.1': {} }, {});
    assert.strictEqual(up.frozen, false);
});
test('ping: malformed entries are skipped, not thrown', () => {
    const doc = pingDoc({ '10.0.0.1': 'garbage', '10.0.0.2': null, '10.0.0.3': { state: 'down' } });
    const out = rules.evaluatePing(doc, { '10.0.0.1': {}, '10.0.0.2': {}, '10.0.0.3': {} }, {});
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].key, 'ping:10.0.0.3');
});

console.log(`ok - ${passed} tests passed`);
