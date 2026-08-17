'use strict';
// SQLite via better-sqlite3: one connection shared by the web handlers and the
// scanner (same process, synchronous library - no cross-connection contention).
// WAL keeps web reads unblocked during scanner writes.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.ALERTCANVAS_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'alertcanvas.db');
const db = new Database(DB_FILE);
// Owner-only. This file holds your alert history and notification settings, and it sits in a directory the suite
// deliberately leaves world-readable (the kiosk's web tier runs as a different
// uid and serves boards out of it), so the directory cannot protect it.
// Narrowed here rather than with a process-wide umask, which would also
// restrict the export files that web tier has to read. SQLite copies this mode
// onto the -wal and -shm files it creates alongside.
try { fs.chmodSync(DB_FILE, 0o600); } catch (_) { /* best effort - some mounts refuse chmod */ }
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL
);

-- Threshold overrides. Two scopes:
--   'code'      - one exported value (metric or interface), matched by its
--                 stable snmp-status.json code, per rule kind
--   'host-kind' - every value of one kind on one host
-- kind is a metric kind (cpu, mem, disk, temp, fan, power, util, battery,
-- runtime, outlet, uptime) or a structural rule (if-down, if-errors,
-- if-discards, if-util, device-down).
-- warn/crit NULL = that level disabled; enabled=0 mutes the target entirely.
-- severity applies to the boolean rules (if-down, device-down) only.
CREATE TABLE IF NOT EXISTS overrides (
  id       INTEGER PRIMARY KEY,
  scope    TEXT NOT NULL CHECK (scope IN ('code','host-kind')),
  code     TEXT,
  host     TEXT,
  kind     TEXT NOT NULL,
  warn     REAL,
  crit     REAL,
  severity TEXT CHECK (severity IN ('warn','crit')),
  enabled  INTEGER NOT NULL DEFAULT 1,
  note     TEXT,
  UNIQUE (scope, code, host, kind)
);

-- One row per alert through its whole life. state:
--   pending  - breaching, not yet confirmed for raise_scans consecutive scans
--   active   - raised (notified)
--   clearing - back to normal, not yet confirmed for clear_scans scans
--   cleared  - done; kept as history until pruned by retention_days
CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY,
  alert_key       TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','active','clearing','cleared')),
  severity        TEXT NOT NULL CHECK (severity IN ('warn','crit')),
  kind            TEXT NOT NULL,
  host            TEXT,
  code            TEXT,
  label           TEXT,
  value           REAL,
  peak_value      REAL,
  threshold       REAL,
  unit            TEXT,
  breach_count    INTEGER NOT NULL DEFAULT 0,
  clear_count     INTEGER NOT NULL DEFAULT 0,
  missing_count   INTEGER NOT NULL DEFAULT 0,
  first_breach_ts INTEGER NOT NULL,
  raised_ts       INTEGER,
  cleared_ts      INTEGER,
  last_seen_ts    INTEGER,
  acked_ts        INTEGER,
  renotified_ts   INTEGER,
  clear_reason    TEXT,
  notified_raise  INTEGER NOT NULL DEFAULT 0,
  notified_clear  INTEGER NOT NULL DEFAULT 0,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_ts INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open ON alerts(alert_key) WHERE state != 'cleared';
CREATE INDEX IF NOT EXISTS idx_alerts_hist ON alerts(cleared_ts) WHERE state = 'cleared';

-- Every notification attempt, success or failure (alert_id NULL = test send).
CREATE TABLE IF NOT EXISTS notifications (
  id       INTEGER PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  channel  TEXT NOT NULL CHECK (channel IN ('email','syslog','ntfy')),
  event    TEXT NOT NULL CHECK (event IN ('raise','clear','escalate','renotify','test')),
  ts       INTEGER NOT NULL,
  ok       INTEGER NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);

-- Last-seen uptime per exported uptime metric, for reboot detection (an
-- uptime that goes backwards means the host restarted).
CREATE TABLE IF NOT EXISTS uptime_seen (
  code  TEXT PRIMARY KEY,
  value REAL NOT NULL,
  ts    INTEGER NOT NULL
);
`);

// --- lightweight migration: the notifications channel CHECK grew 'ntfy'.
// SQLite can't alter a CHECK, so databases created before it get a one-time
// table rebuild (same pattern as SNMPCanvas's entities migration).
{
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get().sql;
    if (!sql.includes("'ntfy'")) {
        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
            db.exec(`
                CREATE TABLE notifications_migrate (
                  id       INTEGER PRIMARY KEY,
                  alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
                  channel  TEXT NOT NULL CHECK (channel IN ('email','syslog','ntfy')),
                  event    TEXT NOT NULL CHECK (event IN ('raise','clear','escalate','renotify','test')),
                  ts       INTEGER NOT NULL,
                  ok       INTEGER NOT NULL,
                  detail   TEXT
                );
                INSERT INTO notifications_migrate (id, alert_id, channel, event, ts, ok, detail)
                  SELECT id, alert_id, channel, event, ts, ok, detail FROM notifications;
                DROP TABLE notifications;
                ALTER TABLE notifications_migrate RENAME TO notifications;
                CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);
            `);
        })();
        db.pragma('foreign_keys = ON');
    }
}

// --- overrides uniqueness. The table's UNIQUE (scope, code, host, kind) never
// fires: a code-scope row leaves host NULL, a host-kind row leaves code NULL,
// and SQLite counts NULLs as distinct - so every row is unique to it and the
// 409 in api.js was dead code. Double-clicking Mute on the Watching page made
// a second row per target, and Unmute (which finds one row per kind) deleted
// only one of each pair, leaving the target muted while the button said Mute.
// COALESCE the NULLs to '' in a unique index so the constraint is real.
// Databases that already collected duplicates would refuse to build it, so
// collapse each group to its lowest id first - the survivor is the row the
// UI was already acting on.
db.transaction(() => {
    db.exec(`
        DELETE FROM overrides WHERE id NOT IN (
          SELECT MIN(id) FROM overrides
           GROUP BY scope, kind, COALESCE(code, ''), COALESCE(host, ''));
        CREATE UNIQUE INDEX IF NOT EXISTS idx_overrides_target
          ON overrides (scope, kind, COALESCE(code, ''), COALESCE(host, ''));
    `);
})();

// --- settings ---
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

// Per-kind threshold defaults. Direction is fixed per kind (rules.js):
// battery/runtime/uptime alert when the value drops TO OR BELOW the level,
// everything else when it rises to or above it. null = no default - that
// kind alerts only via an override (fan rpm, power watts and temperature
// have no universal number; outlet/uptime are opt-in).
const DEFAULT_THRESHOLDS = {
    cpu: { warn: 85, crit: 95 },       // matches SNMPCanvas's exported status
    mem: { warn: 85, crit: 95 },
    disk: { warn: 85, crit: 95 },
    util: { warn: 70, crit: 90 },      // UPS load / generic gauge %
    battery: { warn: 50, crit: 20 },   // <=, matches SNMPCanvas
    runtime: { warn: 600, crit: 300 }, // <= seconds of battery runtime left
    // temp has NO DEFAULT, deliberately, and it is the one kind where that
    // looks like an oversight. Celsius reads as an absolute scale, so a number
    // here seems more portable than fan rpm - but the sensor's SUBJECT sets the
    // range, and the feed does not say what the sensor is on. A small-form-
    // factor host idling at 65C is healthy; a spinning disk at 50C is wearing
    // out; a 40C INLET reading is an emergency. The old 45/55 made every mini
    // PC in the fleet permanently critical. This also matches what production
    // NMS platforms do: Zenoss and SolarWinds ship temperature alerting off,
    // and Catalyst Center only gets it right by supporting a narrow device list
    // with per-sensor built-in limits - the one thing a generic collector that
    // takes whatever the feed reports cannot copy.
    temp: null,
    fan: null,
    power: null,
    outlet: null,
    uptime: null,
    meter: null,       // amps/volts/etc - no universal number; alert via override
    state: { warn: null, crit: 1 }   // 1 = alarm (on battery, fault) - universally alert-worthy
};

const DEFAULT_IF_RULES = {
    down: { enabled: true, severity: 'crit' },  // operStatus != up while adminStatus == up
    errors: { warn: 1, crit: 10 },              // packets/s, worst direction
    discards: { warn: 5, crit: 50 },            // discards are often benign - looser
    util: { warn: 80, crit: 95 }                // % of speedBps, worst direction
};

const DEFAULTS = {
    status_file: process.env.STATUS_FILE || '/status/snmp-status.json',
    scan_interval_s: '30',
    raise_scans: '2',
    clear_scans: '2',
    stale_after_s: '0',            // 0 = auto: max(3 x feed pollIntervalSec, 120)
    missing_scans_to_clear: '20',
    renotify_interval_s: '0',      // 0 = off; else re-send raise for unacked active alerts
    silence_until: '0',            // epoch s; while in the future, notifications are suppressed
    retention_days: '90',
    thresholds: JSON.stringify(DEFAULT_THRESHOLDS),
    if_rules: JSON.stringify(DEFAULT_IF_RULES),
    device_down: JSON.stringify({ enabled: true, severity: 'crit' }),
    // ping alerting (PingCanvas's status-all.json - reachability for devices
    // SNMPCanvas doesn't poll, e.g. ISP gateways). Opt-in per device: the
    // watch map is { feedKey: { label? } }, empty = the feature is inert.
    // PING_STATUS_FILE mirrors STATUS_FILE above: a deploy-time default the
    // suite installer sets when the poller's combined file lives under the
    // wall split's .private dir. Live fallback only - a value saved in
    // Settings still wins.
    ping_status_file: process.env.PING_STATUS_FILE || '/status/status-all.json',
    ping_watch: '{}',
    ping_degraded_warn: '0',
    // email
    email_enabled: '0',
    smtp_host: '',
    smtp_port: '587',
    smtp_mode: 'starttls',         // none | starttls | tls
    smtp_user: '',
    smtp_pass: '',
    smtp_allow_self_signed: '0',
    smtp_from: '',
    smtp_to: '',                   // comma-separated
    // reboot detection (uptime metric going backwards = the host restarted)
    reboot_detect: '1',
    reboot_severity: 'warn',
    // ntfy push notifications
    ntfy_enabled: '0',
    ntfy_server: 'https://ntfy.sh',
    ntfy_topic: '',
    ntfy_token: '',
    // syslog
    syslog_enabled: '0',
    syslog_host: '',
    syslog_port: '514',
    syslog_facility: '16',         // local0
    syslog_sev_crit: '2',
    syslog_sev_warn: '4',
    syslog_sev_clear: '5',
    // alert formatting - templates.js substitutes {{...}} variables
    tmpl_subject_raise: '[AlertCanvas] {{severity}}: {{label}}',
    tmpl_body_raise: '{{time}}\n{{label}} is {{severity}}: {{detail}}.\n\n-- AlertCanvas',
    tmpl_subject_clear: '[AlertCanvas] cleared: {{label}}',
    tmpl_body_clear: '{{time}}\n{{label}} returned to normal after {{duration}}.{{reading}}\n\n-- AlertCanvas',
    tmpl_syslog_raise: '{{severity}} {{label}} {{detail}}',
    tmpl_syslog_clear: 'clear {{label}} after {{duration}}{{reading}}'
};

function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : (DEFAULTS[key] !== undefined ? String(DEFAULTS[key]) : null);
}
function setSetting(key, value) { setSettingStmt.run(key, String(value)); }

// --- migration: the default alert templates gained a kind-aware {{detail}}
// clause (and a {{reading}} clear suffix) so value-less alarms - a device
// that dropped out of the feed, a downed link, a reboot - stop rendering the
// confusing "value -- (threshold --)". DEFAULTS are only a fallback, so a
// fresh or never-customized install picks the new wording up for free; this
// upgrades installs that persisted an OLD default verbatim (e.g. saved the
// Settings tab once). Genuinely customized templates never match, so they
// are left untouched.
(function upgradeDefaultTemplates() {
    const SUPERSEDED = {
        tmpl_body_raise: '{{time}}\n{{label}} is {{severity}}: value {{value}}{{unit}} (threshold {{threshold}}{{unit}}).\n\n-- AlertCanvas',
        tmpl_body_clear: '{{time}}\n{{label}} returned to normal after {{duration}} (value {{value}}{{unit}}).\n\n-- AlertCanvas',
        tmpl_syslog_raise: '{{severity}} {{label}} value {{value}}{{unit}} threshold {{threshold}}{{unit}}',
        tmpl_syslog_clear: 'clear {{label}} value {{value}}{{unit}} after {{duration}}'
    };
    for (const [key, old] of Object.entries(SUPERSEDED)) {
        const row = getSettingStmt.get(key);
        if (row && row.value === old) setSettingStmt.run(key, DEFAULTS[key]);
    }
})();

// --- migration: temperature lost its default (warn 45 / crit 55 C, see the
// note on DEFAULT_THRESHOLDS). Same rule as the template upgrade above, and
// for the same reason: DEFAULTS are only a read-time FALLBACK, so an install
// that never saved the Settings tab picks the new behaviour up for free, and
// this exists for the ones that persisted the old numbers by saving.
//
// Only the OLD DEFAULT VERBATIM is cleared - change either number and it is
// treated as a choice and left alone. The known cost: somebody who
// deliberately set 45/55 (right for a UPS battery, say) is indistinguishable
// from somebody who never touched it, and gets cleared too. Accepted, because
// the alternative is leaving every mini PC permanently critical to protect a
// setting that reproduces the default. Either way the repair is the same one
// the new behaviour asks for anyway: an override on the host or the exported
// value, where the sensor is actually known.
(function upgradeTempThreshold() {
    const row = getSettingStmt.get('thresholds');
    if (!row) return;                       // never saved Settings: reads through to DEFAULTS
    let stored;
    // A corrupt blob already falls back to defaults at read time (api.js), so
    // crashing the boot over one here would be a new failure, not a caught one.
    try { stored = JSON.parse(row.value); } catch (_) { return; }
    if (!stored || typeof stored !== 'object') return;
    const t = stored.temp;
    if (!t || t.warn !== 45 || t.crit !== 55) return;
    stored.temp = null;
    setSettingStmt.run('thresholds', JSON.stringify(stored));
})();

// --- SMTP password encryption at rest (optional, ALERTCANVAS_SECRET) ---
// The password must be recoverable (it's sent on every SMTP session), so this
// is encryption, not hashing. Without the secret it's stored as-is and the
// protection is filesystem permissions on the data volume.
const SECRET = process.env.ALERTCANVAS_SECRET || null;
const encKey = SECRET ? crypto.scryptSync(SECRET, 'alertcanvas-cred-v1', 32) : null;

function encryptValue(plain) {
    if (!encKey || plain === null || plain === undefined || plain === '') return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decryptValue(stored) {
    if (!encKey || stored === null || stored === undefined || stored === '') return stored;
    const [iv, tag, ct] = String(stored).split(':').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Any setting that is a credential goes through these: encrypted when the
// secret is set, with a companion <key>_enc flag so a DB can move between
// encrypted and plain deployments.
function setSecretSetting(key, plain) {
    setSetting(key, encryptValue(plain ?? ''));
    setSetting(`${key}_enc`, encKey ? '1' : '0');
}
function getSecretSetting(key) {
    const stored = getSetting(key);
    if (getSetting(`${key}_enc`) === '1') {
        try { return decryptValue(stored); }
        catch (_) { return ''; } // secret changed - treat as unset
    }
    return stored;
}
const setSmtpPassword = (plain) => setSecretSetting('smtp_pass', plain);
const getSmtpPassword = () => getSecretSetting('smtp_pass');

module.exports = {
    db, DATA_DIR, getSetting, setSetting,
    setSecretSetting, getSecretSetting, setSmtpPassword, getSmtpPassword,
    DEFAULT_THRESHOLDS, DEFAULT_IF_RULES
};
