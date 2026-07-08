const http = require('http');
const { URL } = require('url');
const {
  renderReviewLandingPage,
  renderReviewLandingEditor,
} = require('./reviewLanding');
const reviewAuth = require('./reviewAuth');
const { renderFaqPage } = require('./faqPage');
const firmStore = require('./firmStore');
const reviewRequests = require('./reviewRequests');
const { renderAnalyticsPage } = require('./analyticsPage');
const quoSend = require('./quoSend');
const slackEvents = require('./slackEvents');

/**
 * @typedef {'daily' | 'weekly' | 'monthly' | 'missed' | 'review'} JobId
 */

const JOB_IDS = ['daily', 'weekly', 'monthly', 'missed', 'review'];

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const params = new URLSearchParams(raw);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
    });
    req.on('error', reject);
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function redirectTo(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** Lightweight, privacy-preserving request metadata for a tracked event. */
function trackingMeta(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.socket?.remoteAddress || '';
  return {
    userAgent: req.headers['user-agent'] || '',
    ipHash: reviewRequests.hashIp(ip),
    referrer: req.headers['referer'] || req.headers['referrer'] || '',
  };
}

/** Public base URL for building client-facing links (branded domain preferred). */
function publicBaseUrl(req, firm) {
  const dom = firm && firm.review_domain ? String(firm.review_domain).trim() : '';
  if (dom) return `https://${dom.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const env = (process.env.REVIEW_PUBLIC_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Real destination for a click route, from the firm's effective config. */
function clickDestination(action, cfg) {
  if (action === 'google') {
    const u = String(cfg.googleReviewUrl || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }
  if (action === 'text') {
    const t = quoSend.toE164(cfg.textNumber);
    return t ? `sms:${t}` : '';
  }
  if (action === 'call') {
    const t = quoSend.toE164(cfg.callNumber);
    return t ? `tel:${t}` : '';
  }
  return '';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildIndexHtml(message, email) {
  const msg = message ? `<p class="msg">${escapeHtml(message)}</p>` : '';
  const signedInLabel = email ? `Signed in as ${escapeHtml(email)}` : 'Signed in';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Quo reports — manual trigger</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7ecf3; }
    body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    .card { background: #1a2332; border-radius: 10px; padding: 1.25rem; margin-top: 1rem; }
    label { display: block; font-size: 0.85rem; color: #9aa8bc; margin-bottom: 0.35rem; }
    input[type="password"], input[type="number"], select { width: 100%; box-sizing: border-box; padding: 0.5rem 0.65rem; border-radius: 6px; border: 1px solid #334155; background: #0f1419; color: inherit; }
    .field { margin-top: 0.85rem; }
    .row { display: flex; gap: 0.6rem; }
    .row > div { flex: 1; }
    .jobs { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1rem; }
    button { padding: 0.55rem 1rem; border-radius: 6px; border: none; font-size: 0.95rem; cursor: pointer; text-align: left; background: #2563eb; color: #fff; }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.secondary { background: #334155; }
    button.secondary:hover { background: #475569; }
    .hint { font-size: 0.8rem; color: #7d8da3; margin-top: 1rem; }
    .msg { color: #fbbf24; font-size: 0.9rem; }
    #status { margin-top: 1rem; font-size: 0.9rem; white-space: pre-wrap; background: #0f1419; padding: 0.75rem; border-radius: 6px; border: 1px solid #334155; min-height: 2.5rem; }
    code { font-size: 0.85em; background: #0f1419; padding: 0.1em 0.35em; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Quo reports — manual trigger</h1>
  ${msg}
  <div class="card">
    <div class="field">
      <div class="row" style="align-items:center">
        <div style="font-size:.85rem;color:#9aa8bc">${signedInLabel}</div>
        <div style="flex:0 0 auto"><a href="/review/auth/logout" style="color:#60a5fa;font-size:.85rem">Log out</a></div>
      </div>
    </div>
    <div class="field">
      <label for="weekly-days">Sentiment time frame (trailing days)</label>
      <div class="row">
        <div>
          <select id="weekly-days">
            <option value="1">1 day</option>
            <option value="3">3 days</option>
            <option value="7" selected>7 days (default)</option>
            <option value="14">14 days</option>
            <option value="30">30 days</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div>
          <input type="number" id="weekly-days-custom" min="1" max="180" placeholder="Custom days (1–180)" style="display:none"/>
        </div>
      </div>
    </div>
    <div class="field">
      <label><input type="checkbox" id="weekly-only-latest"/> Only update <code>All Latest Sentiment</code> (skip email + Negative Sentiment + weekly upsert)</label>
    </div>
    <div class="jobs">
      <button type="button" data-job="daily">Run daily lead report + CSV</button>
      <button type="button" data-job="weekly">Run client sentiment (uses selected time frame · summaries + SMS)</button>
      <button type="button" data-job="monthly">Run monthly client newsletter ideas (30 days · summaries)</button>
      <button type="button" data-job="missed">Run missed client call report (trailing 24h · clients only)</button>
      <button type="button" data-job="review">Run Review Intelligence (trailing 24h · Google review candidates → Slack)</button>
    </div>
    <p class="hint">Review landing page: <a href="/review" style="color:#60a5fa">/review</a> · edit copy at <a href="/review/edit" style="color:#60a5fa">/review/edit</a> · what does this all do? <a href="/faq" style="color:#60a5fa">/faq</a></p>
    <p class="hint">Jobs run in the background so the browser does not time out. Only one job at a time.</p>
    <div id="status"></div>
  </div>
  <script>
(function () {
  var statusEl = document.getElementById('status');
  var pollTimer = null;

  function setStatus(t) { statusEl.textContent = t; }

  function clearPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    try {
      var r = await fetch('/api/status', { credentials: 'same-origin' });
      var j = await r.json();
      if (j.running) {
        setStatus('Running: ' + j.running + '…');
        return;
      }
      clearPoll();
      if (j.lastError) {
        setStatus('Failed: ' + j.lastError);
        return;
      }
      if (j.lastFinished) {
        setStatus('Finished: ' + j.lastFinished + (j.lastMessage ? ('\\n' + j.lastMessage) : ''));
        return;
      }
      setStatus('Idle.');
    } catch (e) {
      setStatus('Status error: ' + e.message);
    }
  }

  var daysSel = document.getElementById('weekly-days');
  var daysCustom = document.getElementById('weekly-days-custom');
  daysSel.addEventListener('change', function () {
    daysCustom.style.display = daysSel.value === 'custom' ? '' : 'none';
  });

  function selectedDays() {
    if (daysSel.value === 'custom') {
      var n = parseInt(daysCustom.value, 10);
      if (!isFinite(n) || n < 1) return null;
      return Math.min(180, n);
    }
    return parseInt(daysSel.value, 10);
  }

  async function runJob(job) {
    var options = {};
    if (job === 'weekly') {
      var days = selectedDays();
      if (!days) { setStatus('Enter a custom day count (1–180).'); return; }
      options.days = days;
      options.onlyLatest = document.getElementById('weekly-only-latest').checked;
    }
    clearPoll();
    setStatus('Starting…');
    try {
      var r = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ job: job, options: options }),
      });
      if (r.status === 401) { setStatus('Your session expired — reload and sign in again.'); return; }
      var j = await r.json().catch(function () { return {}; });
      if (r.status === 409) { setStatus(j.error || 'A job is already running.'); return; }
      if (r.status === 401) { setStatus(j.error || 'Invalid token.'); return; }
      if (r.status === 503) { setStatus(j.error || 'Trigger UI disabled.'); return; }
      if (!r.ok) { setStatus('Error: ' + (j.error || r.status)); return; }
      setStatus('Accepted — running ' + job + '…');
      pollTimer = setInterval(poll, 2000);
      poll();
    } catch (e) {
      setStatus('Request failed: ' + e.message);
    }
  }

  document.querySelectorAll('button[data-job]').forEach(function (btn) {
    btn.addEventListener('click', function () { runJob(btn.getAttribute('data-job')); });
  });
})();
  </script>
</body>
</html>`;
}

/** Simple locked page shown when Google sign-in isn't configured yet. */
function buildLockedHtml(what) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex"/>
<title>Locked</title><style>:root{font-family:system-ui,sans-serif}body{background:#0f1419;color:#e7ecf3;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:1rem}.card{background:#1a2332;border-radius:12px;padding:1.6rem;max-width:26rem}code{background:#0f1419;padding:.1em .35em;border-radius:4px;font-size:.85em}</style></head>
<body><div class="card"><h2 style="margin-top:0">${escapeHtml(what)} is locked</h2>
<p>Google sign-in isn’t configured yet. Set <code>GOOGLE_OAUTH_CLIENT_ID</code>, <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, and <code>REVIEW_ADMIN_EMAILS</code> (and/or <code>REVIEW_ADMIN_DOMAIN</code>) to enable access.</p>
<p style="color:#7d8da3;font-size:.85rem">The public review page <a href="/review" style="color:#60a5fa">/review</a> and <code>/health</code> stay open. Scheduled jobs keep running regardless.</p></div></body></html>`;
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {{ daily: (options?: object) => Promise<unknown>, weekly: (options?: { days?: number, onlyLatest?: boolean }) => Promise<unknown>, monthly: (options?: object) => Promise<unknown>, missed: (options?: object) => Promise<unknown>, review: (options?: object) => Promise<unknown> }} opts.runners
 */
function startManualTriggerServer(opts) {
  const { port, runners } = opts;

  const state = {
    /** @type {JobId | null} */
    running: null,
    /** @type {JobId | null} */
    lastFinished: null,
    lastMessage: '',
    lastError: '',
    startedAt: null,
    finishedAt: null,
  };

  async function runInBackground(job, options) {
    state.running = job;
    state.lastError = '';
    state.lastMessage = '';
    state.lastFinished = null;
    state.startedAt = new Date().toISOString();
    const fn = runners[job];
    try {
      const result = await fn(options || {});
      state.lastFinished = job;
      state.finishedAt = new Date().toISOString();
      if (result && typeof result === 'object' && result.csvFilename) {
        state.lastMessage = 'CSV: ' + result.csvFilename;
      } else {
        state.lastMessage = 'OK';
      }
    } catch (err) {
      state.lastError = err.message || String(err);
      state.finishedAt = new Date().toISOString();
      console.error(`[manual trigger] ${job} failed:`, err);
    } finally {
      state.running = null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }

      // Slack Events API — approval-to-send (signature-verified, no session).
      if (req.method === 'POST' && path === '/slack/events') {
        const raw = await readRawBody(req);
        if (!slackEvents.isEnabled()) {
          sendJson(res, 200, { ok: true }); // ack so Slack doesn't retry
          return;
        }
        if (!slackEvents.verifySignature(raw, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'])) {
          sendJson(res, 401, { error: 'bad signature' });
          return;
        }
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: 'bad json' });
          return;
        }
        const result = slackEvents.handleBody(body);
        sendJson(res, 200, result.challenge ? { challenge: result.challenge } : { ok: true });
        return;
      }

      // FAQ / overview of everything this server does — gated like the dashboard.
      if (req.method === 'GET' && (path === '/faq' || path === '/about')) {
        if (!reviewAuth.isAuthEnabled()) {
          sendHtml(res, 200, buildLockedHtml('The FAQ'));
          return;
        }
        if (!reviewAuth.getSession(req)) {
          reviewAuth.sendGate(res, reviewAuth.renderAuthGate, req, 200, '', path);
          return;
        }
        sendHtml(res, 200, renderFaqPage());
        return;
      }

      // Public, branded review landing page (mobile-first). No auth.
      // Resolves firm branding by Host (custom domain), personalizes via ?name=.
      if (req.method === 'GET' && path === '/review') {
        const firstName =
          url.searchParams.get('name') ||
          url.searchParams.get('first') ||
          url.searchParams.get('client_first_name') ||
          url.searchParams.get('fn') ||
          '';
        const firm = await firmStore.getFirmByHost(req.headers.host);
        const cfg = firmStore.landingConfigForFirm(firm);
        sendHtml(res, 200, renderReviewLandingPage(cfg, { firstName }));
        return;
      }

      // Public trackable review link:  /r/:token  (and click routes below).
      // No case number or client name in the URL — only the opaque token.
      const rMatch = path.match(/^\/r\/([A-Za-z0-9_-]{4,64})(?:\/(google|text|call))?$/);
      if (req.method === 'GET' && rMatch) {
        const token = rMatch[1];
        const action = rMatch[2];
        const meta = trackingMeta(req);
        try {
          if (!action) {
            // Page view: render personalized page, record page_opened.
            const request = await reviewRequests.getByToken(token);
            const firm = request
              ? (await firmStore.getFirmById(request.firm_id)) || (await firmStore.getFirmByHost(req.headers.host))
              : await firmStore.getFirmByHost(req.headers.host);
            const cfg = firmStore.landingConfigForFirm(firm);
            if (request) {
              reviewRequests.recordEvent(token, 'page_opened', meta).catch(() => {});
              sendHtml(res, 200, renderReviewLandingPage(cfg, {
                trackingBase: `/r/${token}`,
                firstName: request.client_first_name || '',
              }));
            } else {
              // Invalid/unknown token → default, non-personalized page. No error shown.
              sendHtml(res, 200, renderReviewLandingPage(cfg, {}));
            }
            return;
          }

          // Click route: record then redirect to the real destination.
          const eventType =
            action === 'google' ? 'google_clicked' : action === 'text' ? 'text_clicked' : 'call_clicked';
          const request = await reviewRequests.recordEvent(token, eventType, meta).catch(() => null);
          const firm = request
            ? (await firmStore.getFirmById(request.firm_id)) || (await firmStore.getDefaultFirm())
            : await firmStore.getFirmByHost(req.headers.host);
          const cfg = firmStore.landingConfigForFirm(firm);
          const dest = clickDestination(action, cfg);
          redirectTo(res, dest || '/review');
          return;
        } catch {
          // Never surface internal errors to the client.
          redirectTo(res, '/review');
          return;
        }
      }

      // Google sign-in flow for the editor (only meaningful when auth is enabled).
      const authOn = reviewAuth.isAuthEnabled();

      if (req.method === 'GET' && path === '/review/auth/login') {
        if (!authOn) return redirectTo(res, '/review/edit');
        reviewAuth.startLogin(req, res, url.searchParams.get('next'));
        return;
      }
      if (req.method === 'GET' && path === '/review/auth/callback') {
        if (!authOn) return redirectTo(res, '/review/edit');
        await reviewAuth.handleCallback(req, res, url, reviewAuth.renderAuthGate);
        return;
      }
      if (req.method === 'GET' && path === '/review/auth/logout') {
        reviewAuth.handleLogout(req, res);
        return;
      }

      // Editor to change the landing-page copy without code — gated by Google sign-in.
      if (req.method === 'GET' && path === '/review/edit') {
        if (!authOn) {
          sendHtml(res, 200, buildLockedHtml('The review editor'));
          return;
        }
        const session = reviewAuth.getSession(req);
        if (!session) {
          reviewAuth.sendGate(res, reviewAuth.renderAuthGate, req, 200, '', '/review/edit');
          return;
        }
        const cfg = firmStore.landingConfigForFirm(await firmStore.getDefaultFirm());
        sendHtml(res, 200, renderReviewLandingEditor('', { authMode: 'google', email: session.email, config: cfg }));
        return;
      }

      if (req.method === 'POST' && path === '/review/edit') {
        if (!authOn) {
          sendHtml(res, 503, buildLockedHtml('Saving'));
          return;
        }
        const session = reviewAuth.getSession(req);
        if (!session) {
          reviewAuth.sendGate(res, reviewAuth.renderAuthGate, req, 401, 'Your session expired — sign in again.', '/review/edit');
          return;
        }
        let form;
        try {
          form = await parseFormBody(req);
        } catch {
          sendHtml(res, 400, renderReviewLandingEditor('Could not read form.', { authMode: 'google', email: session.email }));
          return;
        }
        const { token: _t, ...patch } = form; // unknown keys are ignored downstream
        const result = await firmStore.saveDefaultFirmPageSettings(patch);
        const cfg = firmStore.landingConfigForFirm(await firmStore.getDefaultFirm());
        const okMsg = result.storage === 'file'
          ? 'Saved to local file (set DATABASE_URL or a review sheet to persist across redeploys). View it at /review.'
          : `Saved to ${result.storage} (persists across redeploys). View it at /review.`;
        sendHtml(
          res,
          result.ok ? 200 : 500,
          renderReviewLandingEditor(
            result.ok ? okMsg : `Save failed: ${result.error || 'unknown error'}`,
            { authMode: 'google', email: session.email, config: cfg }
          )
        );
        return;
      }

      // Review-link analytics dashboard — gated by the same Google sign-in.
      if (req.method === 'GET' && path === '/review/analytics') {
        if (!authOn) {
          sendHtml(res, 200, buildLockedHtml('Review analytics'));
          return;
        }
        if (!reviewAuth.getSession(req)) {
          reviewAuth.sendGate(res, reviewAuth.renderAuthGate, req, 200, '', '/review/analytics');
          return;
        }
        const firm = await firmStore.getDefaultFirm();
        const [stats, requests] = await Promise.all([
          reviewRequests.aggregate(),
          reviewRequests.listRequests(),
        ]);
        sendHtml(res, 200, renderAnalyticsPage({
          stats,
          requests,
          publicBase: publicBaseUrl(req, firm),
          configured: reviewRequests.isConfigured(),
          sendConfigured: quoSend.isConfigured(),
        }));
        return;
      }

      // Manually send a review link by SMS (staff-approved send).
      if (req.method === 'POST' && path === '/review/analytics/send') {
        if (!authOn || !reviewAuth.getSession(req)) {
          sendJson(res, authOn ? 401 : 503, { error: authOn ? 'Sign in required.' : 'Locked.' });
          return;
        }
        let form;
        try {
          form = await parseFormBody(req);
        } catch {
          sendJson(res, 400, { error: 'Bad form.' });
          return;
        }
        try {
          const requests = await reviewRequests.listRequests();
          const reqRec = requests.find((r) => r.id === form.id || r.token === form.id);
          if (!reqRec) {
            sendJson(res, 404, { error: 'Request not found.' });
            return;
          }
          if (!quoSend.isConfigured()) {
            sendJson(res, 503, { error: 'Quo send not configured (QUO_API_KEY + QUO_SEND_FROM).' });
            return;
          }
          const firm = (await firmStore.getFirmById(reqRec.firm_id)) || (await firmStore.getDefaultFirm());
          const link = `${publicBaseUrl(req, firm)}/r/${reqRec.token}`;
          const text = quoSend.buildReviewSmsText({
            firstName: reqRec.client_first_name,
            firmName: firm.firm_name,
            link,
          });
          await quoSend.sendSms({ to: reqRec.client_phone, content: text });
          await reviewRequests.markSent(reqRec.id);
          sendJson(res, 200, { ok: true, sentTo: reqRec.client_phone, link });
        } catch (err) {
          sendJson(res, 502, { error: err.message });
        }
        return;
      }

      // Manual-trigger dashboard — gated by the same Google sign-in.
      if (req.method === 'GET' && path === '/') {
        if (!authOn) {
          sendHtml(res, 200, buildLockedHtml('The manual-trigger dashboard'));
          return;
        }
        const session = reviewAuth.getSession(req);
        if (!session) {
          reviewAuth.sendGate(res, reviewAuth.renderAuthGate, req, 200, '', '/');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buildIndexHtml('', session.email));
        return;
      }

      if (req.method === 'GET' && path === '/api/status') {
        if (!authOn || !reviewAuth.getSession(req)) {
          sendJson(res, authOn ? 401 : 503, { error: authOn ? 'Sign in required.' : 'Google sign-in not configured.' });
          return;
        }
        sendJson(res, 200, {
          running: state.running,
          lastFinished: state.lastFinished,
          lastMessage: state.lastMessage,
          lastError: state.lastError,
          startedAt: state.startedAt,
          finishedAt: state.finishedAt,
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/trigger') {
        if (!authOn) {
          sendJson(res, 503, { error: 'Google sign-in not configured; manual triggers are disabled.' });
          return;
        }
        if (!reviewAuth.getSession(req)) {
          sendJson(res, 401, { error: 'Sign in required.' });
          return;
        }
        let body;
        try {
          body = await parseJsonBody(req);
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const job = body.job;
        const rawOptions = body.options && typeof body.options === 'object' ? body.options : {};
        if (!JOB_IDS.includes(job)) {
          sendJson(res, 400, { error: `job must be one of: ${JOB_IDS.join(', ')}` });
          return;
        }
        if (state.running) {
          sendJson(res, 409, { error: `Already running: ${state.running}` });
          return;
        }
        const options = {};
        if (job === 'weekly') {
          const days = parseInt(rawOptions.days, 10);
          if (!Number.isFinite(days) || days < 1 || days > 180) {
            sendJson(res, 400, { error: 'options.days must be an integer between 1 and 180' });
            return;
          }
          options.days = days;
          options.onlyLatest = Boolean(rawOptions.onlyLatest);
        }
        setImmediate(() => {
          runInBackground(job, options).catch((e) => console.error('[manual trigger] unhandled', e));
        });
        sendJson(res, 202, { accepted: true, job, options });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      console.error('[manualTriggers]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Server error');
    }
  });

  server.listen(port, () => {
    const authOn = reviewAuth.isAuthEnabled();
    console.log(
      `\nManual trigger UI: http://127.0.0.1:${port}/  (auth: ${
        authOn ? 'Google sign-in' : `LOCKED — ${reviewAuth.authDisabledReason()}`
      })`
    );
    console.log(`Review page: http://127.0.0.1:${port}/review  (public)`);
    console.log(`Health check: http://127.0.0.1:${port}/health\n`);
  });

  return server;
}

module.exports = { startManualTriggerServer };
