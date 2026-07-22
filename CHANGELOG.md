# Changelog

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
