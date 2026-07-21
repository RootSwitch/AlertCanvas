# AlertCanvas

Lightweight self-hosted alerting for the Canvas suite: watch the
`snmp-status.json` file that [SNMPCanvas](https://github.com/RootSwitch/SNMPCanvas)
exports, evaluate thresholds, and raise/clear alarms by **email** and
**syslog** - with a small web UI for active alarms, history, and settings.

AlertCanvas deliberately alerts only on values you have explicitly chosen to
export from SNMPCanvas. That keeps it tiny: no per-vendor MIB knowledge, no
discovery, no agents - just the numbers you already decided matter, a
threshold for each kind, and a notification when one crosses.

- **One container, two dependencies** (`better-sqlite3`, `nodemailer`), no
  framework, no build step
- **Raise and clear notifications** with anti-flap confirmation (N consecutive
  scans to raise, N to clear), warn/crit severities, and escalation
- **Email (SMTP)** - STARTTLS / implicit TLS / plaintext, auth, test button,
  failed sends retried with backoff and surfaced in the UI
- **Syslog (RFC 5424 over UDP)** - lands first-class in
  [SyslogCanvas](https://github.com/RootSwitch/SyslogCanvas) or any receiver,
  with structured data carrying host/kind/severity/code
- **ntfy push** - point it at ntfy.sh or a self-hosted server for phone
  notifications; crit pushes as urgent priority, warn as high
- **Reboot detection** - an exported uptime value going backwards raises a
  one-shot "host rebooted" event (no clear noise; sysUpTime's ~497-day wrap
  is indistinguishable from a reboot)
- **Test alarm** - fire a synthetic alarm through the real pipeline
  (templates, every enabled channel, raise then clear) so you know what the
  2 AM email will look like before 2 AM does
- **Stale-feed watchdog** - if SNMPCanvas stops writing, that is itself an alarm
- **Watching page** - every exported value with the rule that applies to it
  (and where it came from: default, override, or muted), so misconfiguration
  is visible instead of silent
- **Maintenance silence** - suppress notifications for 1h to 7d while alarms
  keep tracking; suppressed sends are logged, and the window can't be forgotten
  because it is bounded
- **Status in the browser tab** - the title shows the raised-alarm count and
  the favicon's canvas washes amber/red, so a pinned tab reads at a glance
- **Single shared password** (scrypt), sessions in SQLite, automatic HTTPS
  when a certificate is present
- The Canvas family look: same themes as CrossCanvas, same easel - with a red
  exclamation mark on the canvas

## How it fits the suite

```
SNMPCanvas  --writes-->  snmp-status.json  --read by-->  PingCanvas (NOC wall)
                                            --read by-->  AlertCanvas (this)
```

SNMPCanvas polls devices and exports selected interfaces and host metrics
(CPU, temperature, UPS load, battery, runtime, ...) to `snmp-status.json` on
its data volume. PingCanvas displays them; AlertCanvas alerts on them. Each
app stays small because it does one job.

## Quick start (Docker)

```sh
git clone https://github.com/RootSwitch/AlertCanvas.git
cd AlertCanvas
mkdir -p data && sudo chown 1000:1000 data
# Point the feed mount at YOUR SNMPCanvas data dir via an override file
# (gitignored, auto-loaded - keeps future git pulls conflict-free):
cat > docker-compose.override.yml <<'EOF'
services:
  alertcanvas:
    volumes:
      - /srv/snmpcanvas/data:/status:ro,z
EOF
docker compose up -d --build
```

Local knobs (volume paths, `ADMIN_PASSWORD`, `ALERTCANVAS_SECRET`) belong in
`docker-compose.override.yml`, not in edits to the tracked compose file -
Compose merges the two automatically, volume entries merge by mount path,
and `git pull` never conflicts with your deployment.

Open `http://your-host:9162`, set the admin password on the first-run page
(or pre-set `ADMIN_PASSWORD` in the compose file), and check the Alarms page.
If the feed mount is right you'll see "All quiet"; if not, the stale-feed
watchdog will tell you within a couple of minutes - which is also your proof
that alerting works.

Then, under Settings:

1. **Email** - SMTP server, from/to, Send test email.
2. **Syslog** (optional) - point it at SyslogCanvas (`host:514`) or any syslog
   server, Send test message.
3. **Thresholds** - the defaults are sane for a homelab (CPU 85/95%,
   temp 45/55C, UPS load 70/90%, battery 50/20%, runtime 10m/5m); adjust to
   taste, and add per-target overrides for the odd sensor that runs hot.

## What it can alert on

| Rule | Default | Direction |
|---|---|---|
| CPU / memory / disk utilization | warn 85, crit 95 (%) | >= |
| Temperature | warn 45, crit 55 (C) | >= |
| Gauge / UPS load (`util`) | warn 70, crit 90 (%) | >= |
| Battery charge | warn 50, crit 20 (%) | <= |
| Battery runtime | warn 600, crit 300 (s) | <= |
| Fan rpm, power draw, outlet, uptime | off (no universal number) | override-only |
| Interface link down (oper down while admin up) | crit | - |
| Interface errors / discards | 1/10 and 5/50 pkt/s | >= |
| Interface utilization (% of link speed) | warn 80, crit 95 | >= |
| Device down (SNMP unreachable) | crit | - |
| Stale or missing status file | crit | - |

Per-kind defaults apply everywhere; **overrides** (Settings) change or mute a
single exported value (by its stable code) or one host+kind. A down device
raises one alarm, not one per interface.

### Anti-flap

A threshold crossing must hold for `raise scans` consecutive scans (default 2
at 30 s) before anything is sent, and a recovery must hold for `clear scans`
scans before the all-clear goes out. Unreadable values (`null`) freeze an
alarm rather than clearing it; a value that disappears from the feed entirely
auto-clears after a configurable number of scans. Warn-to-crit escalation
re-notifies once. An optional reminder interval re-sends unacknowledged
active alarms; the Ack button silences an alarm you know about until it
clears.

## Notifications

Email is plain text with editable **alert formatting templates**
(`{{host}} {{metric}} {{value}} {{threshold}} {{severity}} {{duration}} ...`).
Syslog messages are RFC 5424 with a structured-data block:

```
<130>1 2026-07-20T23:09:29Z nas alertcanvas 7316 ESCALATE
  [alertc@0 event="escalate" severity="crit" kind="temp" host="TrueNASMain" code="8PTS"]
  crit TrueNASMain Temp value 60C threshold 55C
```

Facility and the crit/warn/clear severity mapping are configurable. Failed
emails are retried with exponential backoff (1 min doubling, 15 min cap) and
shown as a banner plus a notifications log entry; syslog and ntfy are
fire-and-forget by design - email is the guaranteed channel.

### SMTP relay / syslog server on the SAME docker host

The compose file maps `host.docker.internal` to the host, so when your relay
or syslog server runs on the AlertCanvas box itself (as a host service or a
sibling container with a published port), set Settings -> Email/Syslog server
to `host.docker.internal` - no bridge IPs to look up, and it survives network
recreations. Two things to check on the host side:

1. Container traffic arrives from the docker bridge subnet (`172.x`), not
   your LAN. A relay that restricts by source network (Postfix `mynetworks`,
   etc.) must also allow `172.16.0.0/12`, and any host firewall must accept
   the docker bridge for those ports.
2. The service must listen on `0.0.0.0` (or the bridge address) - one bound
   strictly to the LAN interface IP is reachable at that LAN IP instead,
   which also works from containers as long as point 1 is satisfied.

The Test buttons in Settings exercise exactly this path, so they'll tell you
immediately whether the plumbing is right.

### Uptime Kuma (or any external monitor)

`GET /api/health?alarms=1` returns **503 while any crit alarm is raised**
(counts only, no alarm details - the endpoint is public). Point an Uptime
Kuma HTTP monitor at it and you get a free second notification path, plus a
dead-man's switch: if AlertCanvas itself dies, Kuma notices that too.

## HTTPS

```sh
./tools/gen-cert.sh 192.168.1.50 nas.lan
docker compose restart
```

The server switches to HTTPS automatically when
`data/certs/server.crt` + `server.key` exist (or set `TLS_CERT`/`TLS_KEY`).
For a real certificate, drop your own PEM pair there, or front the container
with a reverse proxy and set `TRUST_PROXY=1` so login rate-limiting sees real
client IPs.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9162` | listen port |
| `ALERTCANVAS_DATA` | `/data` (container) | SQLite DB + certs |
| `STATUS_FILE` | `/status/snmp-status.json` | initial feed path (Settings can change it) |
| `ADMIN_PASSWORD` | - | seed the password on first boot |
| `ALERTCANVAS_SECRET` | - | encrypt the stored SMTP password (AES-256-GCM) |
| `TLS_CERT` / `TLS_KEY` | `<data>/certs/server.crt|key` | HTTPS pair |
| `COOKIE_SECURE` | auto (`1` under HTTPS) | Secure flag on the session cookie |
| `TRUST_PROXY` | - | `1` = honor `X-Forwarded-For` for the login limiter |
| `TZ` | `Etc/UTC` | log timestamps |

## Local development (no Docker)

```sh
npm install
npm test                # rules-engine unit tests (tools/test-rules.js)
STATUS_FILE=./sample/snmp-status.json node server/server.js
# or on Windows PowerShell:
#   $env:STATUS_FILE = 'C:\path\to\snmp-status.json'; node server/server.js
```

`tools/refresh-status.js` fakes a live feed from any sample file - re-stamp
timestamps, force values, drop links, or take devices down:

```sh
node tools/refresh-status.js --in sample.json --out data/live.json --set 8PTS=60 --ifdown V5BV
```

## Notes and limitations

- AlertCanvas applies **its own thresholds** to the exported `value` fields;
  the `status` stamps SNMPCanvas puts on cpu/battery are ignored (one source
  of truth for alerting).
- A host that exports only metrics (no interfaces) has no up/down signal in
  the feed; if it dies its metrics go stale/vanish, which surfaces as
  "removed from feed" rather than "device down".
- Email is plain text, password/no-auth/app-password SMTP - no OAuth. If your
  provider requires XOAUTH2, use an app password or a local relay.
- Settings/thresholds/history live in one SQLite file; the **Download
  backup** button in Settings streams a consistent snapshot of it.
- The web UI has no per-user accounts - it's one shared password, same as the
  rest of the suite. Keep it on a trusted network segment.

## License

Unlicense - public domain. Do what you like; attribution appreciated.
