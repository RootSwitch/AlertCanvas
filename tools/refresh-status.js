'use strict';
// Dev helper: copy a snmp-status.json somewhere with a fresh generatedAt, and
// optionally mutate it to simulate trouble - so you can watch AlertCanvas
// raise and clear without owning a misbehaving UPS.
//
//   node tools/refresh-status.js                                # ./snmp-status.json -> ./data/live.json
//   node tools/refresh-status.js --in feed.json --out data/live.json
//   node tools/refresh-status.js --set K7Q2=60                  # metric code K7Q2 reads 60
//   node tools/refresh-status.js --set K7Q2=null                # metric goes unreadable
//   node tools/refresh-status.js --ifdown P9WT                  # interface code P9WT oper down
//   node tools/refresh-status.js --devdown fw-1                 # every entry for device fw-1 down
//   node tools/refresh-status.js --drop K7Q2                    # remove that code from the feed
//   node tools/refresh-status.js --stale                        # keep the old generatedAt
//
// Ping feed (samples/status-all.json -> ./data/status-all.json):
//   node tools/refresh-status.js --ping                          # fresh copy of the ping feed
//   node tools/refresh-status.js --ping --pingdown 8.8.8.8       # that key goes down
//   node tools/refresh-status.js --ping --pingup 192.168.1.10    # that key recovers
//
// Flags combine; --set/--ifdown/--devdown/--drop/--pingdown/--pingup repeat.

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function opts(name) {
    const out = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--' + name && args[i + 1] !== undefined) out.push(args[++i]);
    return out;
}
const opt = (name, dflt) => opts(name)[0] ?? dflt;
const has = (name) => args.includes('--' + name);

// --ping switches the tool to the PingCanvas feed (its own default paths).
const PING = has('ping');
const inFile = opt('in', path.join(__dirname, '..', 'samples', PING ? 'status-all.json' : 'snmp-status.json'));
const outFile = opt('out', path.join(__dirname, '..', 'data', PING ? 'status-all.json' : 'live.json'));

const doc = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const nowIso = new Date().toISOString();

if (!has('stale')) {
    if (PING) doc.generated = nowIso;
    else doc.generatedAt = nowIso;
    for (const i of doc.interfaces || []) i.sampledAt = nowIso;
    for (const m of doc.metrics || []) m.sampledAt = nowIso;
}

for (const key of opts('pingdown')) {
    const d = (doc.devices || {})[key];
    if (!d) { console.error(`--pingdown: no ping device with key ${key}`); process.exit(1); }
    d.state = 'down'; d.latencyMs = null; d.since = nowIso;
    console.log(`ping ${key}${d.name ? ' (' + d.name + ')' : ''} -> down`);
}
for (const key of opts('pingup')) {
    const d = (doc.devices || {})[key];
    if (!d) { console.error(`--pingup: no ping device with key ${key}`); process.exit(1); }
    d.state = 'up'; d.latencyMs = 5; d.since = nowIso;
    console.log(`ping ${key}${d.name ? ' (' + d.name + ')' : ''} -> up`);
}

for (const kv of opts('set')) {
    const eq = kv.indexOf('=');
    const code = kv.slice(0, eq), val = kv.slice(eq + 1);
    const m = (doc.metrics || []).find((x) => x.code === code);
    if (!m) { console.error(`--set: no metric with code ${code}`); process.exit(1); }
    m.value = val === 'null' ? null : Number(val);
    // Display convention is "<name> <value><unit>" - swap only the last token.
    const name = (m.display || '').replace(/\s+\S+$/, '').trim();
    m.display = m.value === null ? '--' : `${name} ${val}${m.unit || ''}`.trim();
    console.log(`set metric ${code} (${m.host} ${m.kind}) -> ${m.value}`);
}

for (const code of opts('ifdown')) {
    const i = (doc.interfaces || []).find((x) => x.code === code);
    if (!i) { console.error(`--ifdown: no interface with code ${code}`); process.exit(1); }
    i.operStatus = 'down';
    i.inBps = i.outBps = 0;
    console.log(`interface ${code} (${i.id}) -> oper down`);
}

for (const name of opts('devdown')) {
    let hit = 0;
    for (const i of doc.interfaces || []) {
        if (i.device && (i.device.name === name || i.device.host === name)) {
            i.device.status = 'down';
            i.operStatus = i.adminStatus = 'unknown';
            i.inBps = i.outBps = i.inErrorsPerSec = i.outErrorsPerSec = i.inDiscardsPerSec = i.outDiscardsPerSec = null;
            hit++;
        }
    }
    if (!hit) { console.error(`--devdown: no interfaces on device ${name}`); process.exit(1); }
    console.log(`device ${name} -> down (${hit} interfaces)`);
}

for (const code of opts('drop')) {
    const nm = (doc.metrics || []).length, ni = (doc.interfaces || []).length;
    doc.metrics = (doc.metrics || []).filter((x) => x.code !== code);
    doc.interfaces = (doc.interfaces || []).filter((x) => x.code !== code);
    if (doc.metrics.length === nm && doc.interfaces.length === ni) {
        console.error(`--drop: no entry with code ${code}`); process.exit(1);
    }
    console.log(`dropped ${code} from the feed`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
// Atomic publish, same as the real producer: temp file + rename.
const tmp = path.join(path.dirname(outFile), `.${path.basename(outFile)}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
fs.renameSync(tmp, outFile);
console.log(`wrote ${outFile}${has('stale') ? ' (stale timestamps kept)' : ''}`);
