'use strict';
// The poll-loop watchdog: does a behind SNMPCanvas warn, and - the case that
// actually matters - does an SNMPCanvas too old to report say nothing?
//
//   node tools/test-conditions.js
//
// SNMPCanvas publishes its own poller health in the feed, so AlertCanvas can
// warn when polling falls behind. But siblings update independently, and a
// feed from a version that predates that field has no `poller` object at all.
// Absence must read as "cannot say", never as "behind": a watchdog that
// invents an alarm out of a missing field is worse than no watchdog, because
// the fix is not on the alarming machine.
//
// The mirror case is just as important. A healthy poller has to keep PUSHING a
// condition, not merely omit one, or an alarm raised while it was behind can
// never clear - the scanner clears on an explicit not-firing condition, and
// silence looks identical to "not evaluated".
//
// The real condition block is lifted out of scanner.js and evaluated, so this
// tests the shipped logic rather than a paraphrase of it.

const fs = require('node:fs');
const path = require('node:path');

const SRC = process.argv[2] || path.join(__dirname, '..', 'server', 'scanner.js');
const src = fs.readFileSync(SRC, 'utf8');

const START = 'const ph = feed.ok && feed.doc ? feed.doc.poller : null;';
const END = '// --- the ping feed';
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) {
    console.error(`FAIL: could not locate the poll-loop condition block in ${SRC}`);
    console.error('(if scanner.js was restructured, update the markers in this file)');
    process.exit(1);
}
const block = src.slice(start, end);

function conditionFor(feed) {
    const conditions = [];
    // eslint-disable-next-line no-new-func
    new Function('feed', 'conditions', block)(feed, conditions);
    return conditions.find((c) => c.key === 'watchdog:pollloop');
}

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const behind = conditionFor({ ok: true, doc: { poller: { behind: true, overdueDevices: 7, worstLateS: 62, concurrency: 16 } } });
check('a behind poller warns', behind && behind.severity === 'warn', behind && String(behind.severity));
check('the label names the count, the lateness and the knob to turn',
    !!behind && /7 device\(s\) overdue/.test(behind.label) && /62s late/.test(behind.label) && /POLL_CONCURRENCY is 16/.test(behind.label),
    behind && behind.label);
check('it carries the overdue count as its value', behind && behind.value === 7, behind && String(behind.value));

const healthy = conditionFor({ ok: true, doc: { poller: { behind: false, overdueDevices: 0, worstLateS: 0, concurrency: 16 } } });
check('a healthy poller still pushes a clearing condition', !!healthy && healthy.severity === null, healthy && String(healthy.severity));

const old = conditionFor({ ok: true, doc: { schemaVersion: 4 } });   // no poller field at all
check('an SNMPCanvas too old to report does not read as behind', !!old && old.severity === null, old && String(old.severity));
check('...but still pushes, so an existing alarm can clear', !!old);

const dead = conditionFor({ ok: false, doc: null });
check('an unreadable feed pushes nothing (the feed watchdog owns that)', dead === undefined);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nthe poll-loop watchdog reads absence correctly');
process.exit(failures ? 1 : 0);
