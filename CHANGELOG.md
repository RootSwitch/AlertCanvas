# Changelog

## Unreleased

- **The Watching page flags hosts that might be laptops, and alerts on all of
  them anyway.** A `state` sensor reading "on battery" is an emergency on a UPS
  and normal on a handheld, and the shipped default (crit at 1) held a crit for
  as long as anyone worked untethered.

  An earlier attempt at this suppressed the default on hosts reporting both a
  battery and a filesystem, reasoning that no UPS or PDU has a filesystem.
  True, and irrelevant: a **server wired to a UPS** reports that UPS's battery
  and runtime through its own agent, next to its own disks, and is
  byte-for-byte a laptop in the feed. Three Proxmox hosts on a real fleet did
  exactly that, and the suppression would have silenced the alarm they exist
  to raise. Guessing wrong in that direction fails silently on a genuine
  outage; the noise it was removing is at least visible.

  So the classifier stayed and the decision went. `state` alerts everywhere as
  before, and the Watching page marks those hosts "laptop or UPS-backed?" with
  the mute control beside them - one click per laptop, and no server can go
  quiet by inference.

- **Temperature no longer has a default threshold.** It shipped at warn 45 /
  crit 55 C, which is a UPS-battery or switch-inlet number - on a small-form-
  factor host it made idle temperatures permanently critical. The feed does
  not say what a sensor is attached to, and the same reading means opposite
  things on an NVMe drive, a spinning disk and an air inlet, so `temp` now
  joins fan rpm, power draw and meters as override-only. Existing installs
  that persisted the old 45/55 are cleared on the next start; a temperature
  threshold you actually chose is left alone. To keep alerting on it, set an
  override on the host or the exported value, where the sensor is known.

- **The retention setting shows what it is holding.** A line under History
  Retention counts the cleared alerts and notification rows currently kept,
  with the oldest row's date. Unlike its siblings' readouts there is no size
  or growth projection, on purpose: alerts are sparse events, so an oldest
  row younger than the window usually means nothing alerted before then, not
  that history was trimmed - and the tooltip says exactly that. (The whole
  history stays kilobyte-sized regardless; this is about visibility, not
  disk.)

- **`tools/refresh-status.js` stamps `sampledAt` as epoch seconds.** It refreshed
  `generatedAt` and every `sampledAt` with one ISO string, but as of export schema
  v4 only the former is an ISO string - so the fixture it produced was one no real
  SNMPCanvas would ever write. Harmless while nothing reads `sampledAt`, but the
  point of a fixture is to look like the thing it stands in for, and a scanner
  being developed against it should see the real shape.

- **Bring your own theme, without a rebuild.** A `theme.json` in the data
  directory adds a thirtieth entry to the picker, above the twenty-nine shipped
  ones. It is the same fifteen `--se-*` variables, hex only, and partial files
  are fine - anything you leave out inherits Classic, so changing two colours
  takes a two-line file. Because the data directory is a bind mount, editing it
  is a browser refresh rather than a `docker compose up --build`; delete the
  file and the entry goes away. Point several apps at one shared data directory
  and a single file themes all of them.

  The shipped themes were deliberately left alone. They are duplicated across
  six repos, the style guide and the demo, so every addition is drift - which is
  exactly why a user's palette should not join that set. `tools/export-theme.js`
  prints any shipped theme as a starting file so nobody has to learn the format
  from documentation.

  `tools/check-theme.js` validates a file before you restart anything, and calls
  the same loader the server calls so it cannot accept what the app would reject.
  It also audits readability, because fifteen variables include `--se-up`,
  `--se-down` and `--se-warn`: on a wall display a palette where healthy and
  failed do not separate at a glance is a different kind of problem from one
  that is merely ugly. Text contrast is checked against WCAG AA; state colours
  are checked for hue separation and for being so washed out they read as "no
  data" rather than a state. It reports and never refuses - several shipped
  themes would warn, having been built for the CrossCanvas editor before
  monitoring was layered on.

  The endpoint serving it is deliberately public. The login page is themed too,
  and gating this would leave the first page every user sees stuck on Classic
  while their palette waited behind a session. It carries fifteen colours and a
  label, and the loader rebuilds the object from validated values rather than
  passing the file through, so nothing else in it can reach a browser.

  The saturation check exists because a test found the hue check insufficient:
  `#8a8f98` is the shipped grey, but it is really a blue-grey sitting 76 degrees
  off green, so hue passed it while it still read as no-state on a board. The
  test was written expecting hue to cover that case and did not pass.

- **The container healthcheck no longer leaks zombies onto the host.** The
  image runs `node` as PID 1, and Node does not reap processes it did not
  spawn - so the HEALTHCHECK's `wget` left an `ssl_client` behind on every
  HTTPS probe and nothing collected it. One a minute, indefinitely. A zombie
  still holds a process slot against the `nproc` limit of the HOST uid the
  container runs as (1000), so after roughly a day that user could no longer
  fork: its SSH logins failed with "Server refused to start a shell/command"
  while root connected fine, and only a reboot cleared it. The symptom points
  nowhere near an alerting app, which is why it went unexplained for a while.
  `docker-compose.yml` now sets `init: true`, putting tini at PID 1 to reap
  orphans. No image rebuild needed - `docker compose up -d` recreates the
  container with the init in place, and that also clears the existing zombies.

- **Passwords hash and verify off the event loop.** `crypto.scryptSync` in
  `server/auth.js` serialised concurrent logins into one unbroken stall (8 at
  once measured ~218ms in which no scan ran and no notification dispatched),
  while each single call sat under per-call blocking thresholds - the burst is
  the cost, so a blocking sweep cannot see it. Now the async `crypto.scrypt`,
  awaited in the setup, login and password-change handlers; the server waits
  for the `ADMIN_PASSWORD` seed before listening. The stored hash format is
  unchanged - `tools/test-auth.js` (new, in `npm test`) proves a hash minted
  by the old synchronous code still verifies.

- **`tools/charcheck.js` now checks itself.** The checker banned em/en dashes
  and curly quotes while containing all six as literals - and never flagged
  itself, because its binary guard was a literal NUL byte embedded in the
  source, which made charcheck.js the one tracked file matching its own
  binary test. The banned set is now built from code points, the NUL is
  constructed with `String.fromCharCode(0)`, and files skipped as binary are
  logged by name instead of passed over silently - that silence is what hid
  the bug.

- **Two more tests in `npm test`.** `tools/test-ping-alerts.js` drives the real
  scanner and database through both deployments: paired (a watched address
  raises and clears; an unwatched one stays silent however loudly it is down)
  and ping-only with `STATUS_FILE=off` (the SNMP watchdog must never fire -
  "no SNMP configured" is not "SNMP is broken", and an alerting tool that cries
  wolf about a deployment it was told about is worse than one that says
  nothing). `tools/test-conditions.js` covers the poll-loop watchdog, in
  particular a feed from an SNMPCanvas too old to publish poller health: absence
  must read as "cannot say", never as "behind", and the healthy case must keep
  pushing a condition so an alarm raised earlier can still clear.

- **Alerts when SNMPCanvas cannot keep up.** SNMPCanvas now publishes a
  `poller` block saying whether its poll loop is behind; AlertCanvas raises a
  **warning** on it by default. Deliberately warn rather than crit - nothing is
  down, history is just being recorded at a longer interval than configured -
  but it alerts out of the box because the whole failure mode is that nothing
  looks wrong. The condition is pushed on every readable scan with a null
  severity when healthy, or when the field is absent on an older SNMPCanvas, so
  "cannot say" never reads as "behind" and a raised alarm still clears.
- Reads `snmp-status.json` schema **v4** as well as v3. v4 sends `device` as
  the device NAME rather than a `{name, host, status}` object and drops `id`,
  roughly halving the file. Only the "devices seen" heartbeat count touched
  those fields - alert conditions key off `code` and were unaffected - but that
  count would have silently gone wrong on a v4 feed. Both shapes are accepted
  deliberately: suite apps are updated independently, so SNMPCanvas moving to
  v4 before AlertCanvas is updated must not distort what the UI reports it is
  watching.

## 0.4.2 - 2026-07-22

- Review fixes for ping alerting, found by an adversarial pass before
  anyone hit them:
  - The missing-source aging machinery is now gated PER FEED: a dead
    ping poller no longer auto-clears a live ISP outage just because the
    SNMP feed is healthy, and a ping-only install (SNMP off) can still
    age out an alarm whose device was un-watched. The ping-feed watchdog
    condition is always pushed (clearing when unarmed), so un-watching
    the last device resolves a raised watchdog instead of stranding it.
  - `state: "unknown"` in the ping feed freezes an alarm (no evidence
    either way) instead of counting as recovered.
  - Settings now accepts 'off' / blank for the status file path - the
    documented ping-only mode was rejected by the ".json" validator, and
    any install whose settings row predated 0.4.1 could never reach
    ping-only mode at all.
  - Feed keys named after Object.prototype members (a board could name a
    Monitor ID "constructor") no longer render as phantom-watched rows;
    watch lookups are own-property on a null-prototype map.
  - The Watching page in ping-only mode now auto-refreshes, explains
    that the SNMP feed is off rather than saying "No feed read yet",
    and warns when the ping feed itself is unreadable or stale (the
    roster shown may be old).
  - `/api/status` pingFeed.generatedAt now reads the ping feed's
    `generated` field (was always null).

## 0.4.1 - 2026-07-22

- Ping-only deployments are first-class: set the status file path to
  `off` (or blank, e.g. `STATUS_FILE=off` in the compose file) and the
  SNMP feed is disabled entirely - no permanent watchdog alarm about a
  feed the deployment never runs. This is the symmetric rule to ping
  alerting's own arming: each feed is inert until asked for. Enables the
  lightweight PingCanvas + AlertCanvas pair (a ping wall that pages you -
  no databases beyond AlertCanvas's own, Pi-friendly). The heartbeat and
  "all quiet" lines count watched ping devices so a ping-only install
  reads honestly.

## 0.4.0 - 2026-07-22

- Ping alerting: alarm on the devices PingCanvas pings but SNMPCanvas
  does not poll - ISP gateways, an internet canary, anything on a board.
  AlertCanvas reads the poller's combined status file (status-all.json;
  the suite's shared layout already puts it in the mounted /status dir).
  Strictly opt-in per device via checkboxes on the Watching page, so a
  device covered by SNMP device-down alarms never alarms twice; each
  watched device takes an optional notification label ("Primary ISP
  (fiber)" instead of a bare address, with the feed's board name as the
  fallback). Down raises crit; a warn on degraded (high latency) is a
  separate Settings toggle. The ping feed gets its own stale-feed
  watchdog, armed only once at least one device is watched - an
  SNMP-only install never hears about a feed it doesn't use.
- Feed reading tolerates a UTF-8 BOM (PowerShell writers - including
  PingCanvas's own poller path on Windows - prepend one, and it used to
  read as "not valid JSON").

## 0.3.0 - 2026-07-21

- Device up/down alarms now cover every device with ANY exported value:
  SNMPCanvas's feed (schema v3) carries a devices[] roster, and the
  device-down rule reads it - a VM exporting only its CPU or a UPS
  exporting only battery gets a down alarm instead of silently freezing.
  Older feeds without the roster keep the previous interface-based behavior
- New `state` kind (binary status alarms - UPS on battery, fault flags):
  alerts at crit by default, with the device's own wording carried through
  ("Power On battery"); notifications say "reporting an alarm condition"
  instead of "value 1 (threshold 1)"
- New `meter` kind (arbitrary-unit readings - amps, volts) accepted from
  the feed; no universal default, alert via per-target overrides
- Notification templates gained kind-aware {{detail}} and {{reading}}
  variables, so value-less alarms (device down, link down, reboot, feed
  failure) read as plain statements instead of "value -- (threshold --)";
  stored templates still matching an old default upgrade automatically,
  customized templates are left alone
- README: new "Exporting is what arms alerting" section - export gating,
  device up/down requirements, scan-rate vs poll-rate interaction, and how
  this relates to what PingCanvas displays
- Fixed: unauthenticated API requests double-wrote a 404 over the 401
  (ERR_HTTP_HEADERS_SENT in the server log on every pre-login page load)
- Settings: the thresholds table gained the state row; the template
  reference documents the new variables

## 0.2.0 - 2026-07-21

- Review pass before first publication: feed-shape failures now degrade to
  the stale-feed watchdog instead of silently stopping the scan loop;
  garbage (non-numeric) values freeze alarms rather than reading as normal;
  partial settings PATCHes merge with stored rules instead of disabling
  them; failed reboot-event emails retry; backup downloads clean their
  temp files on abort; password changes evict other sessions; feed-supplied
  units are HTML-escaped in the UI; auto-refresh no longer repaints a view
  mid-navigation or under an open dropdown; warn amber gets a legible
  light-theme variant; README rebuilt on the family template with a tracked
  samples/ feed for development

- Severity is sticky at the worst level while an alarm is open: a metric
  bouncing across the crit line escalates ONCE per incident instead of on
  every wobble, and History records the incident's true worst severity;
  the crossed threshold sticks with it, so a crit incident always shows
  the crit limit rather than whatever level the value last sat above
- Metric labels append the rule kind when the name doesn't say it
  ("compute-01 GPU (util)"), in the UI, emails, and syslog alike
- History shows the crossed limit next to the peak value
- Compose sets a stable container hostname so syslog's HOSTNAME field reads
  "alertcanvas" instead of a container id
- Scan-interval floor raised to 30 s (matches SNMPCanvas); Alarms-page
  heartbeat, browser-tab status light, maintenance silence, Watching page,
  ntfy push channel, reboot detection, full-pipeline test alarm,
  /api/health?alarms=1 for Uptime Kuma, database backup download,
  click-to-copy {CODE} chips, rules test suite + charcheck

## 0.1.0 - 2026-07-20

Initial release.

- Scan SNMPCanvas's exported snmp-status.json on an interval (default 30 s)
- Warn/crit thresholds per metric kind (cpu, mem, disk, temp, util, battery,
  runtime, and override-only fan/power/outlet/uptime), with per-code and
  per-host+kind overrides
- Interface rules: link down, errors, discards, utilization; device-down
  dedupe; stale/missing-feed watchdog
- Anti-flap state machine (N scans to raise, N to clear), warn-to-crit
  escalation, acknowledge, optional reminder re-notification
- Email (nodemailer: STARTTLS/TLS/plain, auth, retry with backoff) and
  RFC 5424 UDP syslog with structured data; editable message templates;
  test buttons for both channels
- Alarm history and notification log with retention pruning
- Canvas-family web UI: themes, easel favicon with red exclamation mark,
  single shared password (scrypt), automatic HTTPS when a cert is present
- Docker: node:22-alpine, unprivileged, healthcheck, compose file with a
  read-only feed mount
