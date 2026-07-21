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

const db = new Database(path.join(DATA_DIR, 'alertcanvas.db'));
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

// --- settings ---
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

// Per-kind threshold defaults. Direction is fixed per kind (rules.js):
// battery/runtime/uptime alert when the value drops TO OR BELOW the level,
// everything else when it rises to or above it. null = no default - that
// kind alerts only via an override (fan rpm and power watts have no
// universal number; outlet/uptime are opt-in).
const DEFAULT_THRESHOLDS = {
    cpu: { warn: 85, crit: 95 },       // matches SNMPCanvas's exported status
    mem: { warn: 85, crit: 95 },
    disk: { warn: 85, crit: 95 },
    temp: { warn: 45, crit: 55 },      // C
    util: { warn: 70, crit: 90 },      // UPS load / generic gauge %
    battery: { warn: 50, crit: 20 },   // <=, matches SNMPCanvas
    runtime: { warn: 600, crit: 300 }, // <= seconds of battery runtime left
    fan: null,
    power: null,
    outlet: null,
    uptime: null
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
    tmpl_body_raise: '{{time}}\n{{label}} is {{severity}}: value {{value}}{{unit}} (threshold {{threshold}}{{unit}}).\n\n-- AlertCanvas',
    tmpl_subject_clear: '[AlertCanvas] cleared: {{label}}',
    tmpl_body_clear: '{{time}}\n{{label}} returned to normal after {{duration}} (value {{value}}{{unit}}).\n\n-- AlertCanvas',
    tmpl_syslog_raise: '{{severity}} {{label}} value {{value}}{{unit}} threshold {{threshold}}{{unit}}',
    tmpl_syslog_clear: 'clear {{label}} value {{value}}{{unit}} after {{duration}}'
};

function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : (DEFAULTS[key] !== undefined ? String(DEFAULTS[key]) : null);
}
function setSetting(key, value) { setSettingStmt.run(key, String(value)); }

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
