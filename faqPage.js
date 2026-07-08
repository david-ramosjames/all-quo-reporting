/**
 * A plain-English overview of what this server does — the scheduled reports,
 * Review Intelligence, the review landing page, manual triggers, and how access
 * works. Served publicly at /faq (and /about) as a team reference. Contains no
 * secrets or client data; the actual controls and data are all gated.
 */

const COMPANY_NAME = process.env.COMPANY_NAME || 'Ramos James Law, PLLC';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turn a 5-field cron into a short human phrase (best-effort for the common cases). */
function cronPhrase(cron) {
  const map = {
    '0 7 * * *': 'Daily · 7:00 AM',
    '0 18 * * *': 'Daily · 6:00 PM',
    '0 20 * * 5': 'Weekly · Fridays 8:00 PM',
    '0 1 1 * *': 'Monthly · 1st at 1:00 AM',
  };
  return map[String(cron || '').trim()] || `Cron: ${esc(cron)}`;
}

function sched(envName, def) {
  return (process.env[envName] || def).trim();
}

const JOBS = [
  {
    name: 'Daily Intake &amp; Lead Report',
    when: () => cronPhrase(sched('CRON_SCHEDULE', '0 7 * * *')),
    what:
      'Pulls yesterday’s Quo calls, the #lead-calls Slack channel, and the lead pipeline sheet; the AI writes an intake &amp; lead-quality briefing. Emailed with the day’s call CSV attached.',
    out: 'Email + CSV',
  },
  {
    name: 'Weekly Client Sentiment',
    when: () => cronPhrase(sched('WEEKLY_SENTIMENT_CRON', '0 20 * * 5')),
    what:
      'Reads the trailing 7 days of client calls + SMS and scores each active client’s overall sentiment, flagging negative/at-risk clients (and bad-review risk). Logged to Google Sheets.',
    out: 'Email + Sheets',
  },
  {
    name: 'Monthly Newsletter Insights',
    when: () => cronPhrase(sched('MONTHLY_INSIGHTS_CRON', '0 1 1 * *')),
    what:
      'Mines the trailing 30 days of call summaries for common questions, misconceptions, and themes, then drafts a newsletter/FAQ content brief.',
    out: 'Email',
  },
  {
    name: 'Missed Client Call Report',
    when: () => cronPhrase(sched('MISSED_CLIENT_CALLS_CRON', '0 7 * * *')),
    what:
      'Finds client phone numbers whose most recent call in the last 24h was a missed / Sona-handled call that never connected to a person and hasn’t been returned, so staff can call them back.',
    out: 'Email',
  },
  {
    name: 'Review Intelligence',
    when: () => cronPhrase(sched('REVIEW_INTELLIGENCE_CRON', '0 18 * * *')),
    what:
      'Evaluates the last 24h of client communications, scores each active client 0–100 as a Google-review candidate (only happy, resolved clients — never anyone showing frustration), and posts the best picks to Slack.',
    out: 'Slack + Sheets',
  },
];

const FAQ = [
  {
    q: 'What is this server?',
    a: `An internal automation worker for ${esc(
      COMPANY_NAME
    )}. It reads client communications from Quo (phone calls + SMS), the #lead-calls Slack channel, and Google Sheets, then uses AI to produce daily/weekly/monthly reports and — new in V1 — to spot clients who are great candidates for a Google review. It also hosts the branded review page clients see.`,
  },
  {
    q: 'How does Review Intelligence decide who to recommend?',
    a: 'Every evening it looks at each client who communicated in the last 24 hours and evaluates their whole recent journey — not a single message. It first reuses the existing sentiment analysis as a gate (anyone negative or at risk of a bad review is dropped), then an AI “decision engine” scores the rest 0–100 on positive signals (gratitude, relief, settlement reached/distributed, case closed) and disqualifies anyone with frustration, confusion, complaints, or poor communication. Qualified clients are saved to the review_opportunities table and the highest-confidence ones are posted to Slack.',
  },
  {
    q: 'Does it automatically send review requests to clients?',
    a: 'No. V1 only identifies the right clients and recommends them in Slack for a human to review. Nobody is contacted automatically — that’s intentional for this version.',
  },
  {
    q: 'What is the review landing page?',
    a: 'A branded, mobile-first page (at /review) that a happy client opens to leave a Google review in about a minute. It has one primary action (Leave a Google Review) plus a clearly secondary “Text / Call us” support section for anyone who still needs help. It can be personalized per client, e.g. /review?name=Maria.',
  },
  {
    q: 'How do I edit the review page copy?',
    a: 'Open the admin editor at /review/edit (sign in with Google). You can change the logo, colors, all copy, the Google review link, the Laura note, the support buttons/numbers, and show/hide sections — no code required.',
  },
  {
    q: 'How do I run a report right now instead of waiting?',
    a: 'Use the manual-trigger dashboard at / (sign in with Google) and click the job you want. It runs in the background and posts status. The scheduled runs keep happening on their own regardless.',
  },
  {
    q: 'Who can access the admin pages?',
    a: 'The dashboard (/) and the review editor (/review/edit) require Google sign-in restricted to an approved list of firm emails (or your Google Workspace domain). The public review page (/review) and the health check (/health) are open to anyone with the link.',
  },
];

function renderFaqPage() {
  const linkCards = [
    { href: '/', title: 'Manual triggers', sub: 'Run a report now', lock: true },
    { href: '/review/edit', title: 'Edit review page', sub: 'Change copy &amp; branding', lock: true },
    { href: '/review', title: 'Review page', sub: 'What clients see', lock: false },
    { href: '/health', title: 'Health', sub: 'Uptime check', lock: false },
  ]
    .map(
      (c) => `<a class="linkcard" href="${c.href}">
        <span class="lc-title">${c.title}${c.lock ? ' <span class="lock">🔒</span>' : ''}</span>
        <span class="lc-sub">${c.sub}</span>
      </a>`
    )
    .join('');

  const jobRows = JOBS.map(
    (j) => `<tr>
      <td><strong>${j.name}</strong></td>
      <td class="nowrap">${j.when()}</td>
      <td>${j.what}</td>
      <td class="nowrap">${j.out}</td>
    </tr>`
  ).join('');

  const faqItems = FAQ.map(
    (f) => `<details class="faq">
      <summary>${esc(f.q)}</summary>
      <p>${f.a}</p>
    </details>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>What this server does — ${esc(COMPANY_NAME)}</title>
  <style>
    :root {
      --bg:#0A1C40; --ink:#eaf0fb; --muted:#9fb0d0; --accent:#F5218B; --cta:#45C7F0;
      --card:#132445; --line:#22375f;
    }
    * { box-sizing:border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background:radial-gradient(1000px 500px at 80% -10%, #F5218B14 0%, transparent 60%), linear-gradient(160deg,#0A1C40,#0e2350 60%,#091634);
      color:var(--ink); line-height:1.55; min-height:100vh; }
    .wrap { max-width:56rem; margin:0 auto; padding:2rem 1.1rem 4rem; }
    header h1 { font-size:1.6rem; margin:0 0 .3rem; letter-spacing:-.01em; }
    header p.sub { color:var(--muted); margin:0 0 1.4rem; }
    .links { display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.7rem; margin:0 0 2rem; }
    .linkcard { display:flex; flex-direction:column; gap:.15rem; text-decoration:none; color:var(--ink);
      background:var(--card); border:1px solid var(--line); border-radius:12px; padding:.85rem .95rem; transition:border-color .15s ease, transform .05s ease; }
    .linkcard:hover { border-color:var(--cta); }
    .linkcard:active { transform:translateY(1px); }
    .lc-title { font-weight:650; font-size:.98rem; }
    .lc-sub { color:var(--muted); font-size:.82rem; }
    .lock { font-size:.75rem; }
    h2 { font-size:1.12rem; margin:2rem 0 .8rem; padding-bottom:.4rem; border-bottom:1px solid var(--line); }
    .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; }
    table { border-collapse:collapse; width:100%; min-width:40rem; font-size:.9rem; }
    th, td { text-align:left; padding:.7rem .8rem; border-bottom:1px solid var(--line); vertical-align:top; }
    th { background:#0e2350; color:var(--muted); font-weight:600; font-size:.82rem; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:none; }
    td.nowrap { white-space:nowrap; color:var(--muted); }
    .faq { background:var(--card); border:1px solid var(--line); border-radius:12px; margin:.6rem 0; padding:.2rem .95rem; }
    .faq summary { cursor:pointer; font-weight:600; padding:.7rem 0; list-style:none; }
    .faq summary::-webkit-details-marker { display:none; }
    .faq summary::before { content:"＋"; color:var(--accent); font-weight:700; margin-right:.6rem; }
    .faq[open] summary::before { content:"－"; }
    .faq p { margin:0 0 .9rem; color:#cdd8ef; }
    .note { color:var(--muted); font-size:.85rem; }
    a.inline { color:var(--cta); }
    footer { margin-top:2.5rem; color:var(--muted); font-size:.82rem; border-top:1px solid var(--line); padding-top:1rem; }
    @media (max-width:520px){ header h1{font-size:1.35rem;} }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Quo Reporting &amp; Review Intelligence</h1>
      <p class="sub">Internal automation for ${esc(COMPANY_NAME)} — reports, sentiment, and Google-review candidate detection. All times ${esc(TIMEZONE)}.</p>
    </header>

    <div class="links">${linkCards}</div>

    <h2>Scheduled reports</h2>
    <p class="note">These run automatically on a timer inside the server — no one has to trigger them. 🔒 pages need Google sign-in.</p>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Report</th><th>When</th><th>What it does</th><th>Goes to</th></tr></thead>
        <tbody>${jobRows}</tbody>
      </table>
    </div>

    <h2>Review Intelligence (V1)</h2>
    <p>Each evening the server scores clients who’ve been in touch in the last 24 hours as candidates to ask for a public Google review, saves qualified ones to the <strong>review_opportunities</strong> table, and posts the highest-confidence picks to Slack. Clients open the branded page at <a class="inline" href="/review">/review</a>; the team edits it at <a class="inline" href="/review/edit">/review/edit</a>. It never contacts clients automatically.</p>

    <h2>Questions</h2>
    ${faqItems}

    <footer>
      Manual runs: <a class="inline" href="/">/</a> · Review page: <a class="inline" href="/review">/review</a> · Edit page: <a class="inline" href="/review/edit">/review/edit</a> · Health: <a class="inline" href="/health">/health</a>
    </footer>
  </div>
</body>
</html>`;
}

module.exports = { renderFaqPage };
