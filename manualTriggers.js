const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

/**
 * @typedef {'daily' | 'weekly' | 'monthly'} JobId
 */

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    return crypto.timingSafeEqual(
      crypto.createHash('sha256').update(ba).digest(),
      crypto.createHash('sha256').update(bb).digest()
    ) && false;
  }
  return crypto.timingSafeEqual(ba, bb);
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

function buildIndexHtml(message) {
  const msg = message ? `<p class="msg">${escapeHtml(message)}</p>` : '';
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
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.5rem 0.65rem; border-radius: 6px; border: 1px solid #334155; background: #0f1419; color: inherit; }
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
    <label for="token">Trigger token (<code>ADMIN_TRIGGER_TOKEN</code>)</label>
    <input type="password" id="token" autocomplete="current-password" placeholder="Paste token from Railway / .env"/>
    <div class="jobs">
      <button type="button" data-job="daily">Run daily lead report + CSV</button>
      <button type="button" data-job="weekly">Run weekly client sentiment (7 days · summaries + SMS)</button>
      <button type="button" data-job="monthly">Run monthly client newsletter ideas (30 days · summaries)</button>
    </div>
    <p class="hint">Jobs run in the background so the browser does not time out. Only one job at a time.</p>
    <div id="status"></div>
  </div>
  <script>
(function () {
  var tokenEl = document.getElementById('token');
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

  async function runJob(job) {
    var token = (tokenEl.value || '').trim();
    if (!token) { setStatus('Enter the trigger token first.'); return; }
    clearPoll();
    setStatus('Starting…');
    try {
      var r = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: job, token: token }),
      });
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

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.adminToken]
 * @param {{ daily: () => Promise<unknown>, weekly: () => Promise<unknown>, monthly: () => Promise<unknown> }} opts.runners
 */
function startManualTriggerServer(opts) {
  const { port, adminToken, runners } = opts;
  const tokenConfigured = Boolean(adminToken && String(adminToken).trim());

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

  async function runInBackground(job) {
    state.running = job;
    state.lastError = '';
    state.lastMessage = '';
    state.lastFinished = null;
    state.startedAt = new Date().toISOString();
    const fn = runners[job];
    try {
      const result = await fn();
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

      if (req.method === 'GET' && path === '/') {
        const html = buildIndexHtml(
          tokenConfigured
            ? ''
            : 'Set ADMIN_TRIGGER_TOKEN in Railway to enable triggers (health still works at /health).'
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && path === '/api/status') {
        sendJson(res, 200, {
          running: state.running,
          lastFinished: state.lastFinished,
          lastMessage: state.lastMessage,
          lastError: state.lastError,
          startedAt: state.startedAt,
          finishedAt: state.finishedAt,
          tokenConfigured,
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/trigger') {
        if (!tokenConfigured) {
          sendJson(res, 503, {
            error: 'ADMIN_TRIGGER_TOKEN is not set; manual triggers are disabled.',
          });
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
        const token = body.token;
        if (!['daily', 'weekly', 'monthly'].includes(job)) {
          sendJson(res, 400, { error: 'job must be daily, weekly, or monthly' });
          return;
        }
        if (!timingSafeEqualString(token, adminToken)) {
          sendJson(res, 401, { error: 'Invalid token' });
          return;
        }
        if (state.running) {
          sendJson(res, 409, { error: `Already running: ${state.running}` });
          return;
        }
        setImmediate(() => {
          runInBackground(job).catch((e) => console.error('[manual trigger] unhandled', e));
        });
        sendJson(res, 202, { accepted: true, job });
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
    console.log(
      `\nManual trigger UI: http://127.0.0.1:${port}/  (same as localhost — use this in the browser; token: ${
        tokenConfigured ? 'required' : 'not configured'
      })`
    );
    console.log(`Health check: http://127.0.0.1:${port}/health\n`);
  });

  return server;
}

module.exports = { startManualTriggerServer };
