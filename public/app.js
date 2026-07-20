'use strict';
// AlertCanvas frontend: hash-routed views over the JSON API. Vanilla DOM, no
// framework, no build step - the file you read is the file that runs.

(function () {
    const $main = document.getElementById('main');
    const $nav = document.getElementById('nav');
    const $logout = document.getElementById('logout-btn');

    let refreshTimer = null;

    // ===== helpers =====
    function esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function api(method, path, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        if (res.status === 401 && !path.startsWith('/api/session') && !path.startsWith('/api/login')) {
            renderLogin(false);
            throw new Error('authentication required');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }
    const GET = (p) => api('GET', p);

    function fmtAgo(ts) {
        if (!ts) return 'never';
        const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
        return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
    }
    function fmtDuration(sec) {
        if (sec == null || sec < 0) return '-';
        sec = Math.round(sec);
        const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
            m = Math.floor((sec % 3600) / 60), s = sec % 60;
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }
    function fmtTs(ts) {
        return ts ? new Date(ts * 1000).toLocaleString() : '-';
    }
    // Values: seconds read better as durations (runtime/uptime kinds).
    function fmtValue(value, unit) {
        if (value == null) return '--';
        if (unit === 's') return fmtDuration(value);
        return `${value}${unit || ''}`;
    }

    function setAutoRefresh(fn, ms) {
        clearInterval(refreshTimer);
        refreshTimer = fn ? setInterval(fn, ms) : null;
    }

    function setNav(active, visible) {
        $nav.style.display = visible ? '' : 'none';
        $logout.style.display = visible ? '' : 'none';
        for (const a of $nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.nav === active);
    }

    // ===== theme picker (grouped like CrossCanvas's) =====
    const $theme = document.getElementById('theme-select');
    let optgroup = null;
    for (const [key, t] of Object.entries(Themes.THEMES)) {
        const o = document.createElement('option');
        o.value = key; o.textContent = t.label;
        if (!t.group) {
            $theme.appendChild(o);
        } else {
            if (!optgroup || optgroup.label !== t.group) {
                optgroup = document.createElement('optgroup');
                optgroup.label = t.group;
                $theme.appendChild(optgroup);
            }
            optgroup.appendChild(o);
        }
    }
    $theme.value = Themes.currentTheme();
    $theme.addEventListener('change', () => Themes.applyTheme($theme.value));

    $logout.addEventListener('click', async () => {
        await api('POST', '/api/logout', {});
        location.hash = '#/alarms';
        route();
    });

    // ===== router =====
    window.addEventListener('hashchange', route);

    async function route() {
        setAutoRefresh(null);
        const session = await GET('/api/session');
        if (!session.authenticated) { renderLogin(session.needsSetup); return; }

        const hash = location.hash || '#/alarms';
        if (hash.startsWith('#/history')) return renderHistory();
        if (hash.startsWith('#/settings')) return renderSettings();
        return renderAlarms();
    }

    // ===== login / first-run =====
    function renderLogin(needsSetup) {
        setNav(null, false);
        setAutoRefresh(null);
        $main.innerHTML = `
        <div class="login-wrap"><div class="login-card">
            <h1><svg width="20" height="20" viewBox="0 0 64 64" fill="none" stroke="var(--se-accent)">
                <path d="M32 5 L32 12" stroke-width="5" stroke-linecap="round"/>
                <path d="M18 45 L12 59 M46 45 L52 59 M32 45 L32 59" stroke-width="5" stroke-linecap="round"/>
                <rect x="9" y="12" width="46" height="34" rx="3" fill="#f4f1ea" stroke-width="4"/>
                <g fill="var(--se-down)" stroke="none"><rect x="28.5" y="17" width="7" height="16.5" rx="3.5"/><circle cx="32" cy="40.5" r="3.6"/></g>
            </svg> AlertCanvas</h1>
            <div class="sub">${needsSetup ? 'First run - choose an admin password (8+ characters).' : 'Enter the password to continue.'}</div>
            <form id="login-form">
                <input type="password" id="pw" placeholder="Password" autofocus autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
                ${needsSetup ? '<input type="password" id="pw2" placeholder="Confirm password" autocomplete="new-password">' : ''}
                <button class="btn-primary" type="submit">${needsSetup ? 'Set password' : 'Log in'}</button>
                <div class="error-text" id="login-err" style="margin-top:8px"></div>
            </form>
        </div></div>`;
        document.getElementById('login-form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const pw = document.getElementById('pw').value;
            const err = document.getElementById('login-err');
            try {
                if (needsSetup) {
                    if (pw !== document.getElementById('pw2').value) { err.textContent = 'Passwords do not match.'; return; }
                    await api('POST', '/api/setup', { password: pw });
                } else {
                    await api('POST', '/api/login', { password: pw });
                }
                location.hash = '#/alarms';
                route();
            } catch (e) { err.textContent = e.message; }
        });
    }

    // ===== alarms =====
    function sevPill(a) {
        if (a.state === 'pending') return `<span class="sev pending" title="breaching, not yet confirmed">pending ${a.breachCount}</span>`;
        const cls = a.severity === 'crit' ? 'crit' : 'warn';
        const extra = a.state === 'clearing' ? ' (clearing)' : '';
        return `<span class="sev ${cls}">${esc(a.severity)}</span>${extra ? `<span class="muted small">${extra}</span>` : ''}`;
    }

    async function renderAlarms() {
        setNav('alarms', true);
        let status, alerts;
        try {
            [status, { alerts }] = await Promise.all([GET('/api/status'), GET('/api/alerts')]);
        } catch (e) { return; }

        const banners = [];
        if (!status.lastScanOk && status.lastScanError) {
            banners.push(`<div class="banner"><b>Feed problem:</b> <span class="detail">${esc(status.lastScanError)}</span></div>`);
        }
        if (status.emailError) {
            banners.push(`<div class="banner warn"><b>Email delivery failing:</b> <span class="detail">${esc(status.emailError.detail)} (${fmtAgo(status.emailError.ts)}) - retrying with backoff</span></div>`);
        }

        const raised = alerts.filter((a) => a.state !== 'pending');
        const sub = raised.length === 0 ? 'no active alarms'
            : `${raised.length} active alarm${raised.length === 1 ? '' : 's'}`;

        const rows = alerts.map((a) => `
            <tr class="${a.ackedTs ? 'acked' : ''}">
                <td>${sevPill(a)}</td>
                <td>${esc(a.label)}${a.code ? ` <span class="code-chip">${esc(a.code)}</span>` : ''}</td>
                <td class="num">${fmtValue(a.value, a.unit)}${a.threshold != null ? ` <span class="muted">/ ${fmtValue(a.threshold, a.unit)}</span>` : ''}</td>
                <td class="num hide-sm" title="worst value seen">${fmtValue(a.peakValue, a.unit)}</td>
                <td class="hide-sm">${fmtAgo(a.raisedTs || a.firstBreachTs)}</td>
                <td class="num">${fmtDuration(Math.floor(Date.now() / 1000) - (a.raisedTs || a.firstBreachTs))}</td>
                <td>${a.state === 'pending' ? '' : a.ackedTs
                    ? `<span class="muted small">acked ${fmtAgo(a.ackedTs)}</span>`
                    : `<button data-ack="${a.id}" title="Suppress reminder notifications; the alarm stays listed until it clears">Ack</button>`}</td>
            </tr>`).join('');

        $main.innerHTML = `
        <div class="page-head">
            <h1>Alarms</h1>
            <span class="sub">${sub}</span>
            <span class="spacer"></span>
            <span class="sub">scan ${fmtAgo(status.lastScanTs)}${status.feed && status.feed.ageSec != null ? ` - feed ${status.feed.ageSec}s old` : ''}</span>
        </div>
        ${banners.join('')}
        ${alerts.length === 0 ? `
            <div class="panel"><div class="all-quiet">
                <div class="big">All quiet</div>
                <div>No active alarms. Last scan ${fmtAgo(status.lastScanTs)}, every ${status.scanIntervalS}s.</div>
            </div></div>` : `
            <div class="panel"><table class="list">
                <thead><tr><th>Severity</th><th>Alarm</th><th class="num">Value / limit</th>
                    <th class="num hide-sm">Peak</th><th class="hide-sm">Since</th><th class="num">Duration</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`}`;

        for (const btn of $main.querySelectorAll('[data-ack]')) {
            btn.addEventListener('click', async () => {
                await api('POST', `/api/alerts/${btn.dataset.ack}/ack`, {});
                renderAlarms();
            });
        }
        setAutoRefresh(renderAlarms, 10000);
    }

    // ===== history =====
    async function renderHistory() {
        setNav('history', true);
        const [{ alerts }, { notifications }] = await Promise.all([
            GET('/api/alerts/history?limit=100'), GET('/api/notifications?limit=50')]);

        const rows = alerts.map((a) => `
            <tr>
                <td><span class="sev ${a.severity === 'crit' ? 'crit' : 'warn'}">${esc(a.severity)}</span></td>
                <td>${esc(a.label)}${a.code ? ` <span class="code-chip">${esc(a.code)}</span>` : ''}</td>
                <td class="num hide-sm" title="worst value seen">${fmtValue(a.peakValue, a.unit)}</td>
                <td>${fmtTs(a.raisedTs)}</td>
                <td>${fmtTs(a.clearedTs)}</td>
                <td class="num">${fmtDuration((a.clearedTs || 0) - (a.raisedTs || a.firstBreachTs))}</td>
                <td class="hide-sm">${a.clearReason === 'source-removed' ? '<span class="muted">removed from feed</span>' : 'returned to normal'}</td>
            </tr>`).join('');

        const noteRows = notifications.map((n) => `
            <tr>
                <td>${fmtTs(n.ts)}</td>
                <td>${esc(n.channel)}</td>
                <td>${esc(n.event)}</td>
                <td>${esc(n.alertLabel || (n.event === 'test' ? '(test)' : ''))}</td>
                <td><span class="badge ${n.ok ? 'ok' : 'fail'}">${n.ok ? 'sent' : 'failed'}</span></td>
                <td class="hide-sm muted small">${esc(n.detail || '')}</td>
            </tr>`).join('');

        $main.innerHTML = `
        <div class="page-head"><h1>History</h1>
            <span class="sub">${alerts.length} cleared alarm${alerts.length === 1 ? '' : 's'} shown</span></div>
        <div class="panel">
            ${alerts.length === 0 ? '<div class="muted">Nothing yet - cleared alarms land here.</div>' : `
            <table class="list">
                <thead><tr><th>Severity</th><th>Alarm</th><th class="num hide-sm">Peak</th>
                    <th>Raised</th><th>Cleared</th><th class="num">Duration</th><th class="hide-sm">Reason</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>`}
        </div>
        <div class="panel">
            <h2>Recent notifications</h2>
            ${notifications.length === 0 ? '<div class="muted">No notifications sent yet.</div>' : `
            <table class="list">
                <thead><tr><th>Time</th><th>Channel</th><th>Event</th><th>Alarm</th><th>Result</th><th class="hide-sm">Detail</th></tr></thead>
                <tbody>${noteRows}</tbody>
            </table>`}
        </div>`;
    }

    // ===== settings =====
    const KIND_INFO = [
        ['cpu', 'CPU utilization', '%', '>='],
        ['mem', 'Memory utilization', '%', '>='],
        ['disk', 'Disk / filesystem usage', '%', '>='],
        ['temp', 'Temperature', 'C', '>='],
        ['util', 'Gauge / UPS load', '%', '>='],
        ['power', 'Power draw', 'W', '>='],
        ['fan', 'Fan speed', 'rpm', '>='],
        ['battery', 'Battery charge', '%', '<='],
        ['runtime', 'Battery runtime', 's', '<='],
        ['uptime', 'Uptime', 's', '<='],
        ['outlet', 'Outlet state', '', '>=']
    ];
    const IF_KIND_LABEL = {
        'if-down': 'Link down', 'if-errors': 'Interface errors',
        'if-discards': 'Interface discards', 'if-util': 'Interface utilization',
        'device-down': 'Device down'
    };

    function numOrNull(el) {
        const v = el.value.trim();
        return v === '' ? null : Number(v);
    }

    async function renderSettings() {
        setNav('settings', true);
        const [s, { overrides }, sources] = await Promise.all([
            GET('/api/settings'), GET('/api/overrides'), GET('/api/sources')]);

        const th = s.thresholds || {};
        const kindRows = KIND_INFO.map(([kind, name, unit, dir]) => {
            const lv = th[kind] || {};
            return `<tr>
                <td>${esc(name)} <span class="muted small">${esc(kind)}</span></td>
                <td class="dir">${dir}</td>
                <td><input type="number" step="any" data-th="${kind}.warn" value="${lv.warn ?? ''}" placeholder="off"> ${esc(unit)}</td>
                <td><input type="number" step="any" data-th="${kind}.crit" value="${lv.crit ?? ''}" placeholder="off"> ${esc(unit)}</td>
            </tr>`;
        }).join('');

        const ifr = s.ifRules || {};
        const dd = s.deviceDown || {};
        const levelInputs = (key, lv, unit) => `
            <td><input type="number" step="any" data-if="${key}.warn" value="${(lv && lv.warn) ?? ''}" placeholder="off"> ${unit}</td>
            <td><input type="number" step="any" data-if="${key}.crit" value="${(lv && lv.crit) ?? ''}" placeholder="off"> ${unit}</td>`;

        const ovRows = overrides.map((o) => `
            <tr>
                <td>${o.scope === 'code' ? `<span class="code-chip">${esc(o.code)}</span>` : esc(o.host)}</td>
                <td>${esc(IF_KIND_LABEL[o.kind] || o.kind)}</td>
                <td class="num">${o.severity ? '-' : (o.warn ?? '-')}</td>
                <td class="num">${o.severity ? esc(o.severity) : (o.crit ?? '-')}</td>
                <td><input type="checkbox" data-ov-en="${o.id}" ${o.enabled ? 'checked' : ''} title="Untick to mute this target"></td>
                <td class="muted small">${esc(o.note || '')}</td>
                <td><button class="btn-danger" data-ov-del="${o.id}">Delete</button></td>
            </tr>`).join('');

        const srcOptions = [
            ...sources.metrics.map((m) =>
                `<option value="m|${esc(m.code)}|${esc(m.kind)}">${esc(m.code)} - ${esc(m.host)} ${esc(m.display)} (${esc(m.kind)})</option>`),
            ...sources.interfaces.map((i) =>
                `<option value="i|${esc(i.code)}|">${esc(i.code)} - ${esc(i.host || '')} ${esc(i.name)}${i.alias ? ' (' + esc(i.alias) + ')' : ''} [interface]</option>`)
        ].join('');

        $main.innerHTML = `
        <div class="page-head"><h1>Settings</h1></div>

        <div class="panel">
            <h2>Feed and scanning</h2>
            <div class="form-grid">
                <label>Status file path</label><input type="text" id="set-statusFile" value="${esc(s.statusFile)}">
                <label>Scan interval (s)</label><input type="number" id="set-scanIntervalS" value="${s.scanIntervalS}" min="30">
                <label>Scans to raise</label><input type="number" id="set-raiseScans" value="${s.raiseScans}" min="1" max="50" title="Consecutive breaching scans before an alarm raises">
                <label>Scans to clear</label><input type="number" id="set-clearScans" value="${s.clearScans}" min="1" max="50" title="Consecutive normal scans before an alarm clears">
                <label>Stale after (s)</label><input type="number" id="set-staleAfterS" value="${s.staleAfterS}" min="0" title="0 = automatic: 3x the feed's own poll interval, at least 120s">
                <label>Missing scans to clear</label><input type="number" id="set-missingScansToClear" value="${s.missingScansToClear}" min="1" title="Scans a value can vanish from the feed before its alarm auto-clears">
                <label>Reminder interval (s)</label><input type="number" id="set-renotifyIntervalS" value="${s.renotifyIntervalS}" min="0" title="0 = off. Re-send notifications for unacknowledged active alarms this often.">
            </div>
            <div class="form-actions"><button class="btn-primary" id="save-scan">Save</button><span id="scan-msg"></span></div>
        </div>

        <div class="panel">
            <h2>Host metric thresholds</h2>
            <div class="section-note">Global defaults per metric kind. Blank = that level off; both blank = kind not alerted.
                Direction is fixed: &gt;= kinds alarm when the value rises to the level, &lt;= kinds when it falls to it.
                Fan, power, outlet and uptime have no sensible universal default - leave them off globally and use per-target overrides.</div>
            <table class="list thresholds">
                <thead><tr><th>Kind</th><th>Dir</th><th>Warn at</th><th>Crit at</th></tr></thead>
                <tbody>${kindRows}</tbody>
            </table>
            <div class="form-actions"><button class="btn-primary" id="save-th">Save</button><span id="th-msg"></span></div>
        </div>

        <div class="panel">
            <h2>Interface and device rules</h2>
            <table class="list thresholds">
                <thead><tr><th>Rule</th><th></th><th>Warn at</th><th>Crit at</th></tr></thead>
                <tbody>
                <tr><td>Link down <span class="muted small">oper down while admin up</span></td>
                    <td><label><input type="checkbox" id="if-down-en" ${ifr.down && ifr.down.enabled ? 'checked' : ''}> enabled</label></td>
                    <td colspan="2">severity <select id="if-down-sev">
                        <option value="crit" ${(!ifr.down || ifr.down.severity !== 'warn') ? 'selected' : ''}>crit</option>
                        <option value="warn" ${ifr.down && ifr.down.severity === 'warn' ? 'selected' : ''}>warn</option></select></td></tr>
                <tr><td>Errors <span class="muted small">worst direction</span></td><td class="dir">&gt;=</td>${levelInputs('errors', ifr.errors, 'pkt/s')}</tr>
                <tr><td>Discards</td><td class="dir">&gt;=</td>${levelInputs('discards', ifr.discards, 'pkt/s')}</tr>
                <tr><td>Utilization <span class="muted small">of link speed</span></td><td class="dir">&gt;=</td>${levelInputs('util', ifr.util, '%')}</tr>
                <tr><td>Device down</td>
                    <td><label><input type="checkbox" id="dev-down-en" ${dd.enabled ? 'checked' : ''}> enabled</label></td>
                    <td colspan="2">severity <select id="dev-down-sev">
                        <option value="crit" ${dd.severity !== 'warn' ? 'selected' : ''}>crit</option>
                        <option value="warn" ${dd.severity === 'warn' ? 'selected' : ''}>warn</option></select></td></tr>
                </tbody>
            </table>
            <div class="form-actions"><button class="btn-primary" id="save-if">Save</button><span id="if-msg"></span></div>
        </div>

        <div class="panel">
            <h2>Overrides</h2>
            <div class="section-note">Per-target exceptions to the defaults above: a different limit for one sensor, or a mute for a noisy port.</div>
            ${overrides.length === 0 ? '' : `
            <table class="list">
                <thead><tr><th>Target</th><th>Kind</th><th class="num">Warn</th><th class="num">Crit / severity</th><th>On</th><th>Note</th><th></th></tr></thead>
                <tbody>${ovRows}</tbody>
            </table>`}
            <div class="form-actions" style="flex-wrap:wrap">
                <select id="ov-src" style="max-width:340px">
                    <option value="">Add override: pick a target...</option>
                    ${srcOptions}
                    <option value="hk||">By host + kind...</option>
                </select>
                <span id="ov-extra"></span>
                <input type="number" step="any" id="ov-warn" placeholder="warn" style="width:80px;display:none">
                <input type="number" step="any" id="ov-crit" placeholder="crit" style="width:80px;display:none">
                <select id="ov-sev" style="display:none"><option value="crit">crit</option><option value="warn">warn</option></select>
                <input type="text" id="ov-note" placeholder="note" style="width:140px;display:none">
                <button class="btn-primary" id="ov-add" style="display:none">Add</button>
                <span id="ov-msg"></span>
            </div>
        </div>

        <div class="panel">
            <h2>Email (SMTP)</h2>
            <div class="form-grid">
                <label>Enabled</label><span><input type="checkbox" id="set-emailEnabled" ${s.emailEnabled ? 'checked' : ''}></span>
                <label>Server</label><input type="text" id="set-smtpHost" value="${esc(s.smtpHost)}" placeholder="smtp.example.com">
                <label>Port</label><input type="number" id="set-smtpPort" value="${s.smtpPort}">
                <label>Security</label><select id="set-smtpMode">
                    <option value="starttls" ${s.smtpMode === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
                    <option value="tls" ${s.smtpMode === 'tls' ? 'selected' : ''}>Implicit TLS (465)</option>
                    <option value="none" ${s.smtpMode === 'none' ? 'selected' : ''}>None (25)</option></select>
                <label>Username</label><input type="text" id="set-smtpUser" value="${esc(s.smtpUser)}" autocomplete="off">
                <label>Password</label><input type="password" id="set-smtpPass" placeholder="${s.smtpPassSet ? '(saved - leave blank to keep)' : ''}" autocomplete="new-password">
                <label>Allow self-signed</label><span><input type="checkbox" id="set-smtpAllowSelfSigned" ${s.smtpAllowSelfSigned ? 'checked' : ''}></span>
                <label>From</label><input type="text" id="set-smtpFrom" value="${esc(s.smtpFrom)}" placeholder="alertcanvas@example.com">
                <label>To</label><input type="text" id="set-smtpTo" value="${esc(s.smtpTo)}" placeholder="you@example.com, oncall@example.com">
            </div>
            <div class="form-actions">
                <button class="btn-primary" id="save-email">Save</button>
                <button id="test-email">Send test email</button><span id="email-msg"></span>
            </div>
            ${s.credentialEncryption ? '<div class="section-note">SMTP password is encrypted at rest (ALERTCANVAS_SECRET is set).</div>'
                : '<div class="section-note">Set ALERTCANVAS_SECRET in the environment to encrypt the stored SMTP password.</div>'}
        </div>

        <div class="panel">
            <h2>Syslog</h2>
            <div class="form-grid">
                <label>Enabled</label><span><input type="checkbox" id="set-syslogEnabled" ${s.syslogEnabled ? 'checked' : ''}></span>
                <label>Server</label><input type="text" id="set-syslogHost" value="${esc(s.syslogHost)}" placeholder="syslogcanvas host or any syslog server">
                <label>UDP port</label><input type="number" id="set-syslogPort" value="${s.syslogPort}">
                <label>Facility</label><input type="number" id="set-syslogFacility" value="${s.syslogFacility}" min="0" max="23" title="16 = local0">
                <label>Severity: crit</label><input type="number" id="set-syslogSevCrit" value="${s.syslogSevCrit}" min="0" max="7">
                <label>Severity: warn</label><input type="number" id="set-syslogSevWarn" value="${s.syslogSevWarn}" min="0" max="7">
                <label>Severity: clear</label><input type="number" id="set-syslogSevClear" value="${s.syslogSevClear}" min="0" max="7">
            </div>
            <div class="form-actions">
                <button class="btn-primary" id="save-syslog">Save</button>
                <button id="test-syslog">Send test message</button><span id="syslog-msg"></span>
            </div>
        </div>

        <div class="panel">
            <h2>Verbiage</h2>
            <div class="section-note">Templates for notifications. Variables:</div>
            <div class="tmpl-vars">{{label}} {{host}} {{metric}} {{kind}} {{code}} {{value}} {{unit}} {{threshold}} {{severity}} {{event}} {{time}} {{duration}}</div>
            <div class="form-grid" style="max-width:none">
                <label>Raise subject</label><input type="text" id="set-tmplSubjectRaise" value="${esc(s.tmplSubjectRaise)}">
                <label class="full">Raise body</label>
                <textarea class="full" id="set-tmplBodyRaise" rows="4">${esc(s.tmplBodyRaise)}</textarea>
                <label>Clear subject</label><input type="text" id="set-tmplSubjectClear" value="${esc(s.tmplSubjectClear)}">
                <label class="full">Clear body</label>
                <textarea class="full" id="set-tmplBodyClear" rows="4">${esc(s.tmplBodyClear)}</textarea>
                <label>Syslog raise</label><input type="text" id="set-tmplSyslogRaise" value="${esc(s.tmplSyslogRaise)}">
                <label>Syslog clear</label><input type="text" id="set-tmplSyslogClear" value="${esc(s.tmplSyslogClear)}">
            </div>
            <div class="form-actions"><button class="btn-primary" id="save-tmpl">Save</button><span id="tmpl-msg"></span></div>
        </div>

        <div class="panel">
            <h2>Security and data</h2>
            <div class="form-grid">
                <label>Current password</label><input type="password" id="pw-cur" autocomplete="current-password">
                <label>New password</label><input type="password" id="pw-new" autocomplete="new-password">
            </div>
            <div class="form-actions"><button id="pw-save">Change password</button><span id="pw-msg"></span></div>
            <div class="form-grid" style="margin-top:14px">
                <label>History retention (days)</label><input type="number" id="set-retentionDays" value="${s.retentionDays}" min="1">
            </div>
            <div class="form-actions"><button class="btn-primary" id="save-data">Save</button><span id="data-msg"></span></div>
            <div class="section-note">Data directory: ${esc(s.dataDir)}</div>
        </div>`;

        const $ = (id) => document.getElementById(id);
        const flash = (id, ok, msg) => {
            const el = $(id);
            el.className = ok ? 'ok-text' : 'error-text';
            el.textContent = msg;
            if (ok) setTimeout(() => { el.textContent = ''; }, 2500);
        };
        const save = async (msgId, body, after) => {
            try {
                await api('PATCH', '/api/settings', body);
                flash(msgId, true, 'Saved.');
                if (after) after();
            } catch (e) { flash(msgId, false, e.message); }
        };

        $('save-scan').addEventListener('click', () => save('scan-msg', {
            statusFile: $('set-statusFile').value,
            scanIntervalS: $('set-scanIntervalS').value,
            raiseScans: $('set-raiseScans').value,
            clearScans: $('set-clearScans').value,
            staleAfterS: $('set-staleAfterS').value,
            missingScansToClear: $('set-missingScansToClear').value,
            renotifyIntervalS: $('set-renotifyIntervalS').value
        }));

        $('save-th').addEventListener('click', () => {
            const thresholds = {};
            for (const [kind] of KIND_INFO) {
                thresholds[kind] = {
                    warn: numOrNull($main.querySelector(`[data-th="${kind}.warn"]`)),
                    crit: numOrNull($main.querySelector(`[data-th="${kind}.crit"]`))
                };
            }
            save('th-msg', { thresholds });
        });

        $('save-if').addEventListener('click', () => {
            const lv = (key) => ({
                warn: numOrNull($main.querySelector(`[data-if="${key}.warn"]`)),
                crit: numOrNull($main.querySelector(`[data-if="${key}.crit"]`))
            });
            save('if-msg', {
                ifRules: {
                    down: { enabled: $('if-down-en').checked, severity: $('if-down-sev').value },
                    errors: lv('errors'), discards: lv('discards'), util: lv('util')
                },
                deviceDown: { enabled: $('dev-down-en').checked, severity: $('dev-down-sev').value }
            });
        });

        // --- overrides ---
        for (const cb of $main.querySelectorAll('[data-ov-en]')) {
            cb.addEventListener('change', async () => {
                try { await api('PATCH', `/api/overrides/${cb.dataset.ovEn}`, { enabled: cb.checked }); }
                catch (e) { flash('ov-msg', false, e.message); cb.checked = !cb.checked; }
            });
        }
        for (const btn of $main.querySelectorAll('[data-ov-del]')) {
            btn.addEventListener('click', async () => {
                try { await api('DELETE', `/api/overrides/${btn.dataset.ovDel}`); renderSettings(); }
                catch (e) { flash('ov-msg', false, e.message); }
            });
        }

        const ovSrc = $('ov-src'), ovExtra = $('ov-extra');
        ovSrc.addEventListener('change', () => {
            const [type, , kind] = ovSrc.value.split('|');
            const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
            ovExtra.innerHTML = '';
            if (!type) { for (const id of ['ov-warn', 'ov-crit', 'ov-sev', 'ov-note', 'ov-add']) show(id, false); return; }
            if (type === 'i') {
                ovExtra.innerHTML = `<select id="ov-if-kind">
                    <option value="if-down">link down</option><option value="if-errors">errors</option>
                    <option value="if-discards">discards</option><option value="if-util">utilization</option></select>`;
                $('ov-if-kind').addEventListener('change', updateOvInputs);
            } else if (type === 'hk') {
                ovExtra.innerHTML = `<input type="text" id="ov-host" placeholder="host" style="width:130px">
                    <select id="ov-hk-kind">${KIND_INFO.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}
                        <option value="device-down">device down</option></select>`;
                $('ov-hk-kind').addEventListener('change', updateOvInputs);
            }
            updateOvInputs();
            show('ov-note', true); show('ov-add', true);
        });
        function ovKind() {
            const [type, , kind] = ovSrc.value.split('|');
            if (type === 'm') return kind;
            if (type === 'i') return $('ov-if-kind').value;
            if (type === 'hk') return $('ov-hk-kind').value;
            return null;
        }
        function updateOvInputs() {
            const kind = ovKind();
            const isBool = kind === 'if-down' || kind === 'device-down';
            $('ov-warn').style.display = isBool ? 'none' : '';
            $('ov-crit').style.display = isBool ? 'none' : '';
            $('ov-sev').style.display = isBool ? '' : 'none';
        }
        $('ov-add').addEventListener('click', async () => {
            const [type, code] = ovSrc.value.split('|');
            const kind = ovKind();
            const body = {
                scope: type === 'hk' || kind === 'device-down' ? 'host-kind' : 'code',
                code: type === 'hk' ? null : code,
                host: type === 'hk' ? $('ov-host').value : null,
                kind,
                warn: $('ov-warn').value.trim() === '' ? null : Number($('ov-warn').value),
                crit: $('ov-crit').value.trim() === '' ? null : Number($('ov-crit').value),
                severity: $('ov-sev').value,
                note: $('ov-note').value
            };
            try { await api('POST', '/api/overrides', body); renderSettings(); }
            catch (e) { flash('ov-msg', false, e.message); }
        });

        // --- email ---
        const emailBody = () => ({
            emailEnabled: $('set-emailEnabled').checked,
            smtpHost: $('set-smtpHost').value,
            smtpPort: $('set-smtpPort').value,
            smtpMode: $('set-smtpMode').value,
            smtpUser: $('set-smtpUser').value,
            smtpAllowSelfSigned: $('set-smtpAllowSelfSigned').checked,
            smtpFrom: $('set-smtpFrom').value,
            smtpTo: $('set-smtpTo').value,
            ...($('set-smtpPass').value !== '' ? { smtpPass: $('set-smtpPass').value } : {})
        });
        $('save-email').addEventListener('click', () => save('email-msg', emailBody()));
        $('test-email').addEventListener('click', async () => {
            flash('email-msg', true, 'Sending...');
            try {
                const r = await api('POST', '/api/test/email', {
                    host: $('set-smtpHost').value, port: $('set-smtpPort').value,
                    mode: $('set-smtpMode').value, user: $('set-smtpUser').value,
                    ...($('set-smtpPass').value !== '' ? { pass: $('set-smtpPass').value } : {}),
                    from: $('set-smtpFrom').value, to: $('set-smtpTo').value,
                    allowSelfSigned: $('set-smtpAllowSelfSigned').checked
                });
                flash('email-msg', r.ok, r.ok ? `Sent: ${r.detail}` : r.detail);
            } catch (e) { flash('email-msg', false, e.message); }
        });

        // --- syslog ---
        $('save-syslog').addEventListener('click', () => save('syslog-msg', {
            syslogEnabled: $('set-syslogEnabled').checked,
            syslogHost: $('set-syslogHost').value,
            syslogPort: $('set-syslogPort').value,
            syslogFacility: $('set-syslogFacility').value,
            syslogSevCrit: $('set-syslogSevCrit').value,
            syslogSevWarn: $('set-syslogSevWarn').value,
            syslogSevClear: $('set-syslogSevClear').value
        }));
        $('test-syslog').addEventListener('click', async () => {
            try {
                const r = await api('POST', '/api/test/syslog', {
                    host: $('set-syslogHost').value, port: $('set-syslogPort').value,
                    facility: $('set-syslogFacility').value
                });
                flash('syslog-msg', r.ok, r.ok ? `Sent to ${r.detail}` : r.detail);
            } catch (e) { flash('syslog-msg', false, e.message); }
        });

        // --- verbiage ---
        $('save-tmpl').addEventListener('click', () => save('tmpl-msg', {
            tmplSubjectRaise: $('set-tmplSubjectRaise').value,
            tmplBodyRaise: $('set-tmplBodyRaise').value,
            tmplSubjectClear: $('set-tmplSubjectClear').value,
            tmplBodyClear: $('set-tmplBodyClear').value,
            tmplSyslogRaise: $('set-tmplSyslogRaise').value,
            tmplSyslogClear: $('set-tmplSyslogClear').value
        }));

        // --- security & data ---
        $('pw-save').addEventListener('click', async () => {
            try {
                await api('POST', '/api/settings/password', { current: $('pw-cur').value, next: $('pw-new').value });
                flash('pw-msg', true, 'Password changed.');
                $('pw-cur').value = $('pw-new').value = '';
            } catch (e) { flash('pw-msg', false, e.message); }
        });
        $('save-data').addEventListener('click', () => save('data-msg', { retentionDays: $('set-retentionDays').value }));
    }

    route();
})();
