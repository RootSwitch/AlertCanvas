# Changelog

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
  ("GPU-1 GPU (util)"), in the UI, emails, and syslog alike
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
