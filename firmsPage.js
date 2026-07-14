/**
 * Firm management admin UI — list + editor for per-firm reporting config.
 *
 * Each firm carries its own Quo API key, phone lines, report recipients, Slack
 * channels, and Google Sheet IDs; the scheduled jobs run once per active firm
 * using this config (see firmStore.reportConfigForFirm + report.runForAllFirms).
 * Secrets (Quo key, Slack token) are write-only in the form: they render masked
 * and a blank submission preserves the stored value.
 *
 * Rendering is self-contained (no external assets) so it drops into the same
 * Google-gated admin server as the review editor.
 */

const SECRET_KEYS = new Set(['quo_api_key', 'slack_bot_token']);
const BOOL_KEYS = new Set(['active']);

/**
 * Editor schema. `type`: text | secret | bool | textarea. DB column names are
 * the field keys, so a parsed form maps straight onto a firm-row patch.
 */
const FIRM_FIELDS = [
  { key: 'firm_name', label: 'Firm name', type: 'text', group: 'Firm', placeholder: 'Ramos James Law, PLLC' },
  { key: 'active', label: 'Active (included in scheduled jobs)', type: 'bool', group: 'Firm' },

  { key: 'quo_api_key', label: 'Quo / OpenPhone API key', type: 'secret', group: 'Quo',
    help: 'Reads calls/SMS and sends review texts. Firms can share one key.' },
  { key: 'quo_phone_numbers', label: 'Quo phone lines', type: 'text', group: 'Quo',
    help: 'Comma-separated line names, E.164 numbers, or PN ids. Blank = all lines in this key’s workspace. When firms share a key, list this firm’s lines here.' },
  { key: 'quo_send_from', label: 'SMS send-from line', type: 'text', group: 'Quo',
    help: 'E.164 (+15125005266) or a PN id. Used for review-link texts.' },

  { key: 'email_from', label: 'From address (EMAIL_FROM)', type: 'text', group: 'Email',
    help: 'The address reports are sent from. Optional — falls back to the global EMAIL_FROM.' },
  { key: 'report_email_to', label: 'Default report recipients', type: 'text', group: 'Email',
    help: 'Comma-separated. Used for the daily lead report, and as the fallback for the per-report lists below.' },
  { key: 'missed_calls_email_to', label: 'Missed-call report recipients', type: 'text', group: 'Email',
    help: 'Optional. Falls back to the default recipients.' },
  { key: 'weekly_email_to', label: 'Weekly sentiment recipients', type: 'text', group: 'Email',
    help: 'Optional. Falls back to the default recipients.' },
  { key: 'monthly_email_to', label: 'Monthly newsletter recipients', type: 'text', group: 'Email',
    help: 'Optional. Falls back to the default recipients.' },

  { key: 'slack_bot_token', label: 'Slack bot token', type: 'secret', group: 'Slack',
    help: 'Optional. Falls back to the global token. Set only if this firm posts to a different Slack workspace.' },
  { key: 'slack_channel', label: 'Lead-calls Slack channel', type: 'text', group: 'Slack', placeholder: 'lead-calls' },
  { key: 'review_slack_channel', label: 'Review Slack channel', type: 'text', group: 'Slack', placeholder: 'review-opportunities' },

  { key: 'sheets_id', label: 'Lead pipeline sheet ID', type: 'text', group: 'Google Sheets' },
  { key: 'sheets_range', label: 'Lead pipeline range', type: 'text', group: 'Google Sheets', placeholder: 'blank = first tab, or e.g. Master View!A:ZZ' },
  { key: 'case_roster_id', label: 'Case roster sheet ID', type: 'text', group: 'Google Sheets' },
  { key: 'case_roster_range', label: 'Case roster range', type: 'text', group: 'Google Sheets' },
  { key: 'weekly_sentiment_sheet_id', label: 'Weekly sentiment sheet ID', type: 'text', group: 'Google Sheets' },
  { key: 'weekly_sentiment_range', label: 'Weekly sentiment range', type: 'text', group: 'Google Sheets' },
  { key: 'negative_sentiment_sheet_id', label: 'Negative sentiment sheet ID', type: 'text', group: 'Google Sheets' },
  { key: 'negative_sentiment_range', label: 'Negative sentiment range', type: 'text', group: 'Google Sheets' },
  { key: 'latest_sentiment_sheet_id', label: 'All-latest sentiment sheet ID', type: 'text', group: 'Google Sheets' },
  { key: 'latest_sentiment_range', label: 'All-latest sentiment range', type: 'text', group: 'Google Sheets' },

  { key: 'review_domain', label: 'Branded review domain', type: 'text', group: 'Review', placeholder: 'reviews.example.com' },
  { key: 'google_review_url', label: 'Google review URL', type: 'text', group: 'Review' },
  { key: 'review_sheet_id', label: 'Review store sheet ID', type: 'text', group: 'Review',
    help: 'Only used when Postgres is off; review data is otherwise firm-scoped in the DB.' },
  { key: 'review_opportunities_sheet_id', label: 'Review opportunities sheet ID', type: 'text', group: 'Review' },
];

const EDITABLE_KEYS = FIRM_FIELDS.map((f) => f.key);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isFirmActive(f) {
  return f && f.active !== false && String(f.active).toLowerCase() !== 'false';
}

/**
 * Build a firm-row patch from a parsed form body. Secrets left blank are omitted
 * (so the COALESCE upsert preserves them); other fields pass through (empty =
 * clear). Booleans are coerced from the hidden-input + checkbox convention.
 */
function parseFirmForm(form) {
  const patch = {};
  for (const f of FIRM_FIELDS) {
    const raw = form[f.key];
    if (BOOL_KEYS.has(f.key)) {
      // Checkbox posts 'true' when checked; a hidden 'false' precedes it.
      const val = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      patch[f.key] = String(val).toLowerCase() === 'true';
      continue;
    }
    const val = (raw == null ? '' : String(raw)).trim();
    if (SECRET_KEYS.has(f.key) && val === '') continue; // keep existing secret
    patch[f.key] = val;
  }
  return patch;
}

const STYLE = `
  :root { --bg:#0A1C40; --ink:#eaf0fb; --muted:#8fa0c4; --accent:#F5218B; --cta:#45C7F0; --card:#132445; --line:#22375f; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:linear-gradient(160deg,#0A1C40,#0e2350 60%,#091634); color:var(--ink); min-height:100vh; }
  .wrap { max-width:64rem; margin:0 auto; padding:1.8rem 1.1rem 4rem; }
  h1 { font-size:1.4rem; margin:0 0 .2rem; }
  .nav { margin:0 0 1.4rem; font-size:.9rem; } .nav a { color:var(--cta); text-decoration:none; margin-right:1rem; }
  .msg { padding:.7rem .9rem; border-radius:10px; font-size:.9rem; margin:0 0 1rem; }
  .msg.ok { background:#123a24; color:#8ff0b6; border:1px solid #1e6b3e; }
  .msg.err { background:#3a1c22; color:#f0a8b4; border:1px solid #6b3340; }
  .notice { background:#3a2a12; border:1px solid #6b4e1e; color:#f0d9a8; padding:.7rem .9rem; border-radius:10px; font-size:.9rem; margin:0 0 1rem; }
  table { border-collapse:collapse; width:100%; font-size:.88rem; }
  .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; }
  th, td { text-align:left; padding:.6rem .7rem; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { background:#0e2350; color:var(--muted); font-weight:600; font-size:.74rem; text-transform:uppercase; letter-spacing:.03em; }
  .pill { font-size:.7rem; padding:.15rem .5rem; border-radius:20px; }
  .pill.on { background:#123a24; color:#8ff0b6; } .pill.off { background:#3a1c22; color:#f0a8b4; }
  .yes { color:#8ff0b6; } .no { color:#6d7ea6; }
  a.btn, button.btn { display:inline-block; background:var(--cta); color:#062033; border:none; border-radius:7px;
    padding:.4rem .8rem; font-weight:650; cursor:pointer; font-size:.82rem; text-decoration:none; }
  a.btn.ghost, button.btn.ghost { background:transparent; color:var(--cta); border:1px solid var(--line); }
  button.btn.danger { background:transparent; color:#f0a8b4; border:1px solid #6b3340; }
  .topbar { display:flex; align-items:center; justify-content:space-between; margin:0 0 1.2rem; gap:1rem; flex-wrap:wrap; }
  fieldset { border:1px solid var(--line); border-radius:12px; margin:0 0 1.2rem; padding:.5rem 1rem 1rem; background:var(--card); }
  legend { padding:0 .5rem; color:var(--cta); font-weight:650; font-size:.9rem; }
  .field { margin:.7rem 0; } .field label { display:block; font-size:.82rem; margin-bottom:.25rem; color:#cdd8ef; }
  .field input[type=text], .field input[type=password] { width:100%; padding:.5rem .7rem; border-radius:8px;
    border:1px solid var(--line); background:#0e2350; color:var(--ink); font:inherit; }
  .field .help { color:#6d7ea6; font-size:.74rem; margin-top:.25rem; }
  .field.bool label { display:inline-flex; align-items:center; gap:.5rem; cursor:pointer; }
  .actions { display:flex; gap:.7rem; align-items:center; position:sticky; bottom:0; background:#0b1c3ecc;
    backdrop-filter:blur(4px); padding:.8rem 0; border-top:1px solid var(--line); }
  .rowacts { display:flex; gap:.4rem; flex-wrap:wrap; }
  code { background:#0e2350; padding:.05rem .35rem; border-radius:5px; }
`;

function page(title, inner) {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/><title>${esc(title)}</title>
  <style>${STYLE}</style>
</head><body><div class="wrap">${inner}</div></body></html>`;
}

function renderFirmsListPage(firms, opts = {}) {
  const { email, message, isError, dbEnabled } = opts;
  const rows = (firms || []).map((f) => {
    const active = isFirmActive(f);
    const has = (k) => (f[k] && String(f[k]).trim() ? '<span class="yes">✓</span>' : '<span class="no">—</span>');
    return `<tr>
      <td><strong>${esc(f.firm_name || f.id)}</strong><br><code>${esc(f.id)}</code></td>
      <td><span class="pill ${active ? 'on' : 'off'}">${active ? 'active' : 'off'}</span></td>
      <td>${has('quo_api_key')}</td>
      <td>${esc(f.quo_phone_numbers || '—')}</td>
      <td>${esc(f.report_email_to || '—')}</td>
      <td>${esc(f.review_slack_channel || '—')}</td>
      <td class="rowacts">
        <a class="btn ghost" href="/review/firms/edit?id=${encodeURIComponent(f.id)}">Edit</a>
        <button class="btn ghost" data-run="daily" data-firm="${esc(f.id)}">Run daily</button>
        <button class="btn ghost" data-run="review" data-firm="${esc(f.id)}">Run review</button>
        <button class="btn danger" data-del="${esc(f.id)}" data-name="${esc(f.firm_name || f.id)}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  const dbWarn = dbEnabled ? '' :
    `<p class="notice">Managing firms requires a Postgres database (<code>DATABASE_URL</code>). Without it, the jobs still run once from the environment variables (single firm).</p>`;
  const msg = message ? `<p class="msg ${isError ? 'err' : 'ok'}">${esc(message)}</p>` : '';

  return page('Firms', `
    <h1>Firms</h1>
    <div class="nav"><a href="/">Manual triggers</a><a href="/review/analytics">Analytics</a><a href="/review/edit">Review page</a><a href="/faq">FAQ</a></div>
    ${msg}${dbWarn}
    <div class="topbar">
      <div class="muted">${esc((firms || []).length)} firm(s)${email ? ` · signed in as ${esc(email)}` : ''}</div>
      <a class="btn" href="/review/firms/edit?id=new">+ Add firm</a>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Firm</th><th>Status</th><th>Quo key</th><th>Phone lines</th><th>Report email</th><th>Review channel</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:1.4rem;color:#6d7ea6">No firms yet — add one.</td></tr>'}</tbody>
    </table></div>
    <script>
      document.querySelectorAll('button[data-del]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Delete firm "' + b.getAttribute('data-name') + '"? Its stored config is removed. This cannot be undone.')) return;
          b.disabled = true;
          var body = new URLSearchParams({ id: b.getAttribute('data-del') });
          var r = await fetch('/review/firms/delete', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
          if (r.ok) { location.reload(); } else { var j = await r.json().catch(function(){return {};}); alert(j.error || 'Delete failed'); b.disabled = false; }
        });
      });
      document.querySelectorAll('button[data-run]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var job = b.getAttribute('data-run'); var firmId = b.getAttribute('data-firm');
          if (!confirm('Run the ' + job + ' job now for this firm?')) return;
          b.disabled = true; var t = b.textContent; b.textContent = 'Starting…';
          var r = await fetch('/api/trigger', { method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify({ job: job, options: { firmId: firmId } }) });
          var j = await r.json().catch(function(){return {};});
          if (r.ok) { b.textContent = 'Started ✓'; setTimeout(function(){ b.textContent = t; b.disabled = false; }, 3000); }
          else { alert(j.error || 'Failed'); b.textContent = t; b.disabled = false; }
        });
      });
    </script>
  `);
}

function renderFirmField(f, value) {
  const help = f.help ? `<div class="help">${esc(f.help)}</div>` : '';
  if (f.type === 'bool') {
    const checked = value ? ' checked' : '';
    return `<div class="field bool">
      <input type="hidden" name="${f.key}" value="false"/>
      <label><input type="checkbox" name="${f.key}" value="true"${checked}/> ${esc(f.label)}</label>${help}
    </div>`;
  }
  if (f.type === 'secret') {
    const isSet = value && String(value).trim();
    const ph = isSet ? '•••••••• (set — leave blank to keep)' : (f.placeholder || '');
    return `<div class="field">
      <label>${esc(f.label)}</label>
      <input type="password" name="${f.key}" autocomplete="new-password" placeholder="${esc(ph)}"/>${help}
    </div>`;
  }
  return `<div class="field">
    <label>${esc(f.label)}</label>
    <input type="text" name="${f.key}" value="${esc(value)}" placeholder="${esc(f.placeholder || '')}"/>${help}
  </div>`;
}

function renderFirmEditorPage(firm, opts = {}) {
  const { email, message, isError } = opts;
  const isNew = !firm || !firm.id;
  const groups = [];
  for (const f of FIRM_FIELDS) if (!groups.includes(f.group)) groups.push(f.group);

  const fieldsets = groups.map((g) => {
    const inner = FIRM_FIELDS.filter((f) => f.group === g)
      .map((f) => {
        // Secrets never echo their value; they only show the "is set" state.
        const raw = firm ? firm[f.key] : (f.key === 'active' ? true : '');
        const value = SECRET_KEYS.has(f.key) ? raw : (raw == null ? (f.key === 'active' && isNew ? true : '') : raw);
        return renderFirmField(f, value);
      }).join('');
    return `<fieldset><legend>${esc(g)}</legend>${inner}</fieldset>`;
  }).join('');

  const msg = message ? `<p class="msg ${isError ? 'err' : 'ok'}">${esc(message)}</p>` : '';
  const title = isNew ? 'Add firm' : `Edit ${firm.firm_name || firm.id}`;

  return page(title, `
    <h1>${esc(title)}</h1>
    <div class="nav"><a href="/review/firms">← Firms</a>${email ? `<span class="muted">${esc(email)}</span>` : ''}</div>
    ${msg}
    <form method="POST" action="/review/firms/save">
      ${isNew ? '' : `<input type="hidden" name="id" value="${esc(firm.id)}"/>`}
      ${fieldsets}
      <div class="actions">
        <button class="btn" type="submit">${isNew ? 'Create firm' : 'Save changes'}</button>
        <a class="btn ghost" href="/review/firms">Cancel</a>
      </div>
    </form>
  `);
}

module.exports = {
  FIRM_FIELDS,
  EDITABLE_KEYS,
  parseFirmForm,
  renderFirmsListPage,
  renderFirmEditorPage,
};
