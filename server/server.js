'use strict';
// Entry point: plain node:http - a URL parse, the /api dispatch, and a static
// file server for public/. No framework; the whole request path is this file.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const { db, DATA_DIR } = require('./db');
const auth = require('./auth');
const api = require('./api');
const scanner = require('./scanner');

// Default port 9162 ("162" for SNMP traps - fitting for the suite's alerting
// app) - deliberately clear of the usual home-lab suspects: UptimeKuma 3001,
// CrossCanvas/PingCanvas 8080/8443, SNMPCanvas 9161, SyslogCanvas 9514.
const PORT = parseInt(process.env.PORT || '9162', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// HTTPS is automatic when a cert/key pair exists: either at the paths in
// TLS_CERT/TLS_KEY, or dropped into <data>/certs/ (tools/gen-cert.sh writes
// a self-signed pair there). No cert -> plain HTTP.
const CERT_PATH = process.env.TLS_CERT || path.join(DATA_DIR, 'certs', 'server.crt');
const KEY_PATH = process.env.TLS_KEY || path.join(DATA_DIR, 'certs', 'server.key');
let tlsOptions = null;
if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    try {
        tlsOptions = { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
        // Session cookies default to Secure over HTTPS (COOKIE_SECURE=0 overrides).
        if (process.env.COOKIE_SECURE === undefined) process.env.COOKIE_SECURE = '1';
    } catch (err) {
        // Unreadable cert (usually file ownership: the container runs as uid
        // 1000) - stay up on HTTP rather than crashlooping.
        console.error(new Date().toISOString(),
            `[server] TLS cert found but unreadable (${err.message}) - falling back to HTTP. ` +
            'Fix ownership: chown -R 1000:1000 data/certs');
        tlsOptions = null;
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    // Resolve inside public/ only - with a separator boundary, so a sibling
    // directory that merely shares the prefix (public.bak/) can't leak.
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=300',
            'X-Content-Type-Options': 'nosniff'
        });
        fs.createReadStream(file).pipe(res);
    });
}

const handler = async (req, res) => {
    // The whole body is guarded: the handler is async, so any throw becomes an
    // unhandled rejection, and on modern Node that exits the process - a
    // malformed request (e.g. GET /%zz, whose decodeURIComponent throws
    // URIError) must cost the client a 400, never cost us the server.
    try {
        let url, pathname;
        try {
            url = new URL(req.url, 'http://localhost');
            pathname = decodeURIComponent(url.pathname);
        } catch (_) {
            res.writeHead(400); res.end(); return;
        }

        if (pathname.startsWith('/api/')) {
            const handled = await api.handle(req, res, pathname, url.searchParams);
            if (!handled) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); }
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        serveStatic(req, res, pathname);
    } catch (err) {
        console.error(new Date().toISOString(), '[server] request error:', err);
        try {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        } catch (_) { /* socket already gone */ }
    }
};

// Last-resort net: log and keep serving. Scanning and notification retries
// must survive a bug in one request path - crash-on-unknown is the wrong
// trade for an unattended alerting box.
process.on('uncaughtException', (err) => {
    console.error(new Date().toISOString(), '[server] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error(new Date().toISOString(), '[server] unhandled rejection:', err);
});

const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

auth.seedFromEnv();
scanner.start();
server.listen(PORT, () => {
    console.log(new Date().toISOString(),
        `[server] AlertCanvas listening on ${tlsOptions ? 'https' : 'http'}://0.0.0.0:${PORT}` +
        (tlsOptions ? ` (cert: ${CERT_PATH})` : ''));
});

// Docker sends SIGTERM on stop: close cleanly so WAL merges back into the db.
function shutdown(signal) {
    console.log(new Date().toISOString(), `[server] ${signal} - shutting down`);
    scanner.stop();
    server.close(() => {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* best effort */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
