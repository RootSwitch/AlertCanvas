# Changelog

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
