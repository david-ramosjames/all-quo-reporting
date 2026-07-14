/**
 * Admin analytics for trackable review links (gated). Shows totals and rates
 * plus a per-request breakdown, and — when Quo sending is configured — a manual
 * "Send" button so staff can text an approved link.
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('en-US', {
    timeZone: process.env.TIMEZONE || 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function tile(label, value, hint) {
  return `<div class="tile"><div class="tv">${esc(value)}</div><div class="tl">${esc(label)}</div>${
    hint ? `<div class="th">${esc(hint)}</div>` : ''
  }</div>`;
}

function renderAnalyticsPage({ stats, requests, publicBase, configured, sendConfigured, smsTemplate }) {
  const base = String(publicBase || '').replace(/\/+$/, '');

  const oneOff = sendConfigured
    ? `<details class="oneoff">
        <summary>One-off / test text</summary>
        <p class="muted" style="margin:.4rem 0 .8rem">Send any message to any number (e.g. a test to your own phone). Uses the Quo sending line.</p>
        <div class="of-row">
          <input type="tel" id="of-to" placeholder="Phone e.g. (512) 555-1234"/>
        </div>
        <textarea id="of-msg" rows="3" placeholder="Message text">${esc(smsTemplate || '')}</textarea>
        <div class="of-actions"><button id="of-send">Send text</button><span id="of-status" class="muted"></span></div>
      </details>`
    : `<p class="notice">To send texts (approvals and one-offs), set <code>QUO_API_KEY</code> and <code>QUO_SEND_FROM</code>.</p>`;

  const tiles = [
    tile('Requests created', stats.totalRequests),
    tile('Sent', stats.totalSent),
    tile('Page opens', stats.totalOpens),
    tile('Unique opens', stats.uniqueOpens),
    tile('Google clicks', stats.googleClicks),
    tile('Text clicks', stats.textClicks),
    tile('Call clicks', stats.callClicks),
    tile('Google CTR', `${stats.googleCtr}%`, 'google clicks / opens'),
    tile('Support click rate', `${stats.supportClickRate}%`, '(text+call) / opens'),
  ].join('');

  const rows = (requests || [])
    .map((r) => {
      const link = `${base}/r/${r.token}`;
      const isSent = Boolean(r.sent_at);
      const isCancelled = r.status === 'cancelled';
      let sendCell;
      if (isCancelled) {
        sendCell = '<span class="muted">Cancelled</span>';
      } else if (!r.client_phone) {
        sendCell = '<span class="muted">no #</span>';
      } else if (!sendConfigured) {
        sendCell = '<span class="muted">—</span>';
      } else {
        // Open (un-sent) requests get a Cancel button so they can no longer be
        // triggered here or via a Slack approval.
        const sendBtn = `<button class="send" data-id="${esc(r.id)}">Send</button>`;
        const cancelBtn = isSent ? '' : `<button class="cancel" data-id="${esc(r.id)}">Cancel</button>`;
        sendCell = `<div class="act">${sendBtn}${cancelBtn}</div>`;
      }
      return `<tr>
        <td>${esc(r.client_name || r.client_first_name || '—')}</td>
        <td>${esc(r.case_id || '—')}</td>
        <td><span class="status s-${esc(r.status || '')}">${esc(r.status || '—')}</span></td>
        <td class="num">${esc(r.open_count || '0')}</td>
        <td class="num">${esc(r.google_click_count || '0')}</td>
        <td class="num">${esc(r.text_click_count || '0')}</td>
        <td class="num">${esc(r.call_click_count || '0')}</td>
        <td class="nowrap">${shortTime(r.last_opened_at)}</td>
        <td class="nowrap">${shortTime(r.last_google_clicked_at)}</td>
        <td class="nowrap">${shortTime(r.sent_at)}</td>
        <td><a class="lnk" href="${esc(link)}" target="_blank" rel="noopener">/r/${esc(r.token)}</a></td>
        <td>${sendCell}</td>
      </tr>`;
    })
    .join('');

  const notice = configured
    ? ''
    : `<p class="notice">Analytics storage isn’t configured yet — set <code>GOOGLE_REVIEW_SHEET_ID</code> (or <code>GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID</code>) plus Google OAuth to record and show review-link data.</p>`;

  const emptyRow = `<tr><td colspan="12" class="muted" style="text-align:center;padding:1.5rem">No review requests yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>Review link analytics</title>
  <style>
    :root { --bg:#0A1C40; --ink:#eaf0fb; --muted:#8fa0c4; --accent:#F5218B; --cta:#45C7F0; --card:#132445; --line:#22375f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background:linear-gradient(160deg,#0A1C40,#0e2350 60%,#091634); color:var(--ink); min-height:100vh; }
    .wrap { max-width:74rem; margin:0 auto; padding:1.8rem 1.1rem 4rem; }
    h1 { font-size:1.4rem; margin:0 0 .2rem; }
    .nav { margin:0 0 1.4rem; font-size:.9rem; }
    .nav a { color:var(--cta); text-decoration:none; margin-right:1rem; }
    .notice { background:#3a2a12; border:1px solid #6b4e1e; color:#f0d9a8; padding:.7rem .9rem; border-radius:10px; font-size:.9rem; }
    .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.7rem; margin:0 0 1.6rem; }
    .tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:.9rem 1rem; }
    .tv { font-size:1.5rem; font-weight:700; }
    .tl { color:var(--muted); font-size:.8rem; margin-top:.15rem; }
    .th { color:#6d7ea6; font-size:.72rem; margin-top:.1rem; }
    .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; }
    table { border-collapse:collapse; width:100%; min-width:60rem; font-size:.86rem; }
    th, td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--line); vertical-align:middle; }
    th { background:#0e2350; color:var(--muted); font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.03em; }
    td.num { text-align:center; }
    td.nowrap { white-space:nowrap; color:var(--muted); }
    .muted { color:#6d7ea6; }
    .lnk { color:var(--cta); text-decoration:none; }
    .status { font-size:.72rem; padding:.15rem .45rem; border-radius:20px; background:#1c2f52; color:#bcd; text-transform:capitalize; }
    .s-google_clicked { background:#123a24; color:#8ff0b6; }
    .s-opened { background:#123049; color:#9fd0f5; }
    .s-sent { background:#2a2350; color:#c3b6f0; }
    .s-cancelled { background:#3a1c22; color:#f0a8b4; }
    .act { display:flex; gap:.4rem; align-items:center; }
    button.send { background:var(--cta); color:#062033; border:none; border-radius:7px; padding:.35rem .7rem; font-weight:650; cursor:pointer; font-size:.82rem; }
    button.send:hover { filter:brightness(1.06); }
    button.send:disabled { opacity:.5; cursor:default; }
    button.cancel { background:transparent; color:#f0a8b4; border:1px solid #6b3340; border-radius:7px; padding:.35rem .7rem; font-weight:650; cursor:pointer; font-size:.82rem; }
    button.cancel:hover { background:#3a1c22; }
    button.cancel:disabled { opacity:.5; cursor:default; }
    footer { color:var(--muted); font-size:.8rem; margin-top:1.6rem; }
    .oneoff { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:.4rem 1rem 1rem; margin:0 0 1.4rem; }
    .oneoff summary { cursor:pointer; font-weight:650; padding:.7rem 0; }
    .oneoff input, .oneoff textarea { width:100%; box-sizing:border-box; padding:.55rem .7rem; border-radius:8px; border:1px solid var(--line); background:#0e2350; color:var(--ink); font:inherit; }
    .of-row { margin-bottom:.6rem; } .of-row input { max-width:20rem; }
    .of-actions { display:flex; align-items:center; gap:.8rem; margin-top:.7rem; }
    .oneoff button { background:var(--cta); color:#062033; border:none; border-radius:8px; padding:.5rem 1rem; font-weight:650; cursor:pointer; }
    .oneoff button:disabled { opacity:.5; cursor:default; }
    .runbar { display:flex; align-items:center; gap:.8rem; margin:0 0 1.4rem; }
    #run-review { background:#123a24; color:#8ff0b6; border:1px solid #1e6b3e; border-radius:8px; padding:.5rem .9rem; font-weight:650; cursor:pointer; }
    #run-review:hover { filter:brightness(1.1); } #run-review:disabled { opacity:.5; cursor:default; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Review link analytics</h1>
    <div class="nav">
      <a href="/">Manual triggers</a><a href="/review/firms">Firms</a><a href="/review/edit">Edit review page</a><a href="/faq">FAQ</a><a href="/review" target="_blank">Review page ↗</a>
    </div>
    <div class="runbar">
      <button id="run-review">▶ Run review job now (test)</button>
      <span id="run-status" class="muted"></span>
    </div>
    ${notice}
    ${oneOff}
    <div class="tiles">${tiles}</div>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th>Client</th><th>Case</th><th>Status</th><th>Opens</th><th>Google</th><th>Text</th><th>Call</th>
          <th>Last open</th><th>Last Google</th><th>Sent</th><th>Link</th><th>Send</th>
        </tr></thead>
        <tbody>${rows || emptyRow}</tbody>
      </table>
    </div>
    <footer>Google CTR = Google clicks ÷ opens · Support click rate = (text + call clicks) ÷ opens. Links use the token only — no case numbers or names in the URL.</footer>
  </div>
  <script>
    (function () {
      var rb = document.getElementById('run-review');
      var rs = document.getElementById('run-status');
      if (!rb) return;
      var timer = null;
      function poll() {
        fetch('/api/status', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.running) { rs.textContent = 'Running ' + j.running + '… (watch Slack + logs)'; return; }
          clearInterval(timer); timer = null; rb.disabled = false;
          if (j.lastError) rs.textContent = 'Failed: ' + j.lastError;
          else if (j.lastFinished) { rs.textContent = 'Finished: ' + j.lastFinished + '. Reload to see new requests.'; }
          else rs.textContent = 'Idle.';
        }).catch(function (e) { rs.textContent = 'Status error: ' + e.message; });
      }
      rb.addEventListener('click', async function () {
        if (!confirm('Run the Review Intelligence job now? It scores the last 24h and posts to Slack.')) return;
        rb.disabled = true; rs.textContent = 'Starting…';
        try {
          var r = await fetch('/api/trigger', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: 'review' }) });
          var j = await r.json().catch(function () { return {}; });
          if (r.status === 409) { rs.textContent = j.error || 'A job is already running.'; rb.disabled = false; return; }
          if (!r.ok) { rs.textContent = 'Error: ' + (j.error || r.status); rb.disabled = false; return; }
          rs.textContent = 'Started — running…';
          timer = setInterval(poll, 2000); poll();
        } catch (e) { rs.textContent = 'Failed: ' + e.message; rb.disabled = false; }
      });
    })();
    (function () {
      var btn = document.getElementById('of-send');
      if (!btn) return;
      btn.addEventListener('click', async function () {
        var to = (document.getElementById('of-to').value || '').trim();
        var msg = (document.getElementById('of-msg').value || '').trim();
        var status = document.getElementById('of-status');
        if (!to || !msg) { status.textContent = 'Enter a number and a message.'; return; }
        if (!confirm('Send this text to ' + to + '?')) return;
        btn.disabled = true; status.textContent = 'Sending…';
        try {
          var body = new URLSearchParams({ to: to, message: msg });
          var r = await fetch('/review/send-oneoff', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
          var j = await r.json().catch(function(){return {};});
          status.textContent = (r.ok && j.ok) ? ('Sent to ' + j.sentTo) : ('Failed: ' + (j.error || r.status));
        } catch (e) { status.textContent = 'Failed: ' + e.message; }
        btn.disabled = false;
      });
    })();
    document.querySelectorAll('button.send').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Text this review link to the client now?')) return;
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          var body = new URLSearchParams({ id: btn.getAttribute('data-id') });
          var r = await fetch('/review/analytics/send', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
          var j = await r.json().catch(function(){return {};});
          if (r.ok && j.ok) { btn.textContent = 'Sent ✓'; }
          else { alert(j.error || 'Send failed'); btn.disabled = false; btn.textContent = 'Send'; }
        } catch (e) { alert('Send failed: ' + e.message); btn.disabled = false; btn.textContent = 'Send'; }
      });
    });
    document.querySelectorAll('button.cancel').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!confirm('Cancel this review send? It can no longer be texted — not from here and not from a Slack approval.')) return;
        btn.disabled = true; btn.textContent = 'Cancelling…';
        try {
          var body = new URLSearchParams({ id: btn.getAttribute('data-id') });
          var r = await fetch('/review/analytics/cancel', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
          var j = await r.json().catch(function(){return {};});
          if (r.ok && j.ok) {
            var cell = btn.closest('td');
            if (cell) cell.innerHTML = '<span class="muted">Cancelled</span>';
            var row = btn.closest('tr');
            var badge = row ? row.querySelector('.status') : null;
            if (badge) { badge.textContent = 'cancelled'; badge.className = 'status s-cancelled'; }
          } else { alert(j.error || 'Cancel failed'); btn.disabled = false; btn.textContent = 'Cancel'; }
        } catch (e) { alert('Cancel failed: ' + e.message); btn.disabled = false; btn.textContent = 'Cancel'; }
      });
    });
  </script>
</body>
</html>`;
}

module.exports = { renderAnalyticsPage };
