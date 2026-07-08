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

function renderAnalyticsPage({ stats, requests, publicBase, configured, sendConfigured }) {
  const base = String(publicBase || '').replace(/\/+$/, '');

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
      const canSend = sendConfigured && r.client_phone;
      const sendCell = canSend
        ? `<button class="send" data-id="${esc(r.id)}">Send</button>`
        : r.client_phone
          ? '<span class="muted">—</span>'
          : '<span class="muted">no #</span>';
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
    button.send { background:var(--cta); color:#062033; border:none; border-radius:7px; padding:.35rem .7rem; font-weight:650; cursor:pointer; font-size:.82rem; }
    button.send:hover { filter:brightness(1.06); }
    button.send:disabled { opacity:.5; cursor:default; }
    footer { color:var(--muted); font-size:.8rem; margin-top:1.6rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Review link analytics</h1>
    <div class="nav">
      <a href="/">Manual triggers</a><a href="/review/edit">Edit review page</a><a href="/faq">FAQ</a><a href="/review" target="_blank">Review page ↗</a>
    </div>
    ${notice}
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
  </script>
</body>
</html>`;
}

module.exports = { renderAnalyticsPage };
