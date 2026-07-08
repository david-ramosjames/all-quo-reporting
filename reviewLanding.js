const fs = require('fs');
const path = require('path');

/**
 * Review Landing Page — a simple, branded, mobile-first page whose only goal is
 * to convert a happy client into a public Google review.
 *
 * V1 design principles: Google reviews only, no code required to edit the copy.
 *
 * Content is editable **without code** in two ways:
 *   1. Edit `review-landing.json` (the five required fields + a couple of
 *      decorative ones), or
 *   2. Set env vars, which override the file at render time (handy on hosts
 *      like Railway where the filesystem is ephemeral):
 *        REVIEW_PAGE_HEADLINE, REVIEW_PAGE_BODY, REVIEW_PAGE_BUTTON_TEXT,
 *        REVIEW_GOOGLE_URL, REVIEW_PAGE_FOOTER,
 *        REVIEW_PAGE_STARS, REVIEW_PAGE_BUTTON_SUBTEXT, REVIEW_PAGE_ACCENT
 */

const CONFIG_PATH = path.join(__dirname, 'review-landing.json');

const DEFAULT_CONFIG = {
  stars: '⭐⭐⭐⭐⭐',
  headline: 'Thank you for choosing Ramos James.',
  body: 'Your review helps other people who have been injured find an attorney they can trust.',
  buttonText: 'Leave a Google Review',
  buttonSubtext: '(about 60 seconds)',
  googleReviewUrl: '',
  footer: 'Need help with anything else?\nText us anytime.',
  accentColor: '#1a3d7c',
};

/** The subset a non-developer is meant to edit (drives the editor form). */
const EDITABLE_FIELDS = [
  { key: 'headline', label: 'Headline', type: 'text' },
  { key: 'body', label: 'Body copy', type: 'textarea' },
  { key: 'buttonText', label: 'Button text', type: 'text' },
  { key: 'googleReviewUrl', label: 'Google Review URL', type: 'url' },
  { key: 'footer', label: 'Footer text', type: 'textarea' },
];

const ENV_OVERRIDES = {
  stars: 'REVIEW_PAGE_STARS',
  headline: 'REVIEW_PAGE_HEADLINE',
  body: 'REVIEW_PAGE_BODY',
  buttonText: 'REVIEW_PAGE_BUTTON_TEXT',
  buttonSubtext: 'REVIEW_PAGE_BUTTON_SUBTEXT',
  googleReviewUrl: 'REVIEW_GOOGLE_URL',
  footer: 'REVIEW_PAGE_FOOTER',
  accentColor: 'REVIEW_PAGE_ACCENT',
};

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Effective config: defaults ← JSON file ← env var overrides.
 */
function loadReviewLandingConfig() {
  const fileCfg = readConfigFile();
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    const v = process.env[envName];
    if (v != null && String(v).trim() !== '') cfg[key] = v;
  }
  return cfg;
}

/**
 * Persists edited copy back to `review-landing.json`. Only known keys are
 * written; unknown input is ignored.
 * @returns {{ ok: boolean, config?: object, error?: string }}
 */
function saveReviewLandingConfig(patch) {
  const current = { ...DEFAULT_CONFIG, ...readConfigFile() };
  const allowed = new Set([...Object.keys(DEFAULT_CONFIG)]);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (allowed.has(k) && typeof v === 'string') next[k] = v;
  }
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ok: true, config: next };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Preserve author line breaks in copy fields. */
function nl2br(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br/>');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/**
 * Renders the public, mobile-first landing page from config.
 */
function renderReviewLandingPage(configOverride) {
  const cfg = configOverride || loadReviewLandingConfig();
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(cfg.accentColor || '').trim())
    ? cfg.accentColor.trim()
    : DEFAULT_CONFIG.accentColor;

  const urlRaw = String(cfg.googleReviewUrl || '').trim();
  const hasUrl = /^https?:\/\//i.test(urlRaw);
  const btnHref = hasUrl ? escapeAttr(urlRaw) : '#';
  const disabledNote = hasUrl
    ? ''
    : '<p class="config-note">Set the Google Review URL to activate the button.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="robots" content="noindex"/>
  <title>${escapeHtml(cfg.headline)}</title>
  <style>
    :root {
      --accent: ${accent};
      --ink: #16202e;
      --muted: #5b6675;
      --bg: #f4f6fb;
      --card: #ffffff;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 18px calc(24px + env(safe-area-inset-bottom));
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: var(--card);
      width: 100%;
      max-width: 30rem;
      border-radius: 20px;
      padding: 40px 26px 32px;
      box-shadow: 0 12px 40px rgba(16, 32, 55, 0.12);
      text-align: center;
    }
    .stars { font-size: 30px; letter-spacing: 3px; line-height: 1; margin-bottom: 20px; }
    h1 {
      font-size: 26px;
      line-height: 1.25;
      margin: 0 0 16px;
      color: var(--ink);
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .body {
      font-size: 17px;
      color: var(--muted);
      margin: 0 auto 28px;
      max-width: 26rem;
    }
    .cta {
      display: block;
      width: 100%;
      background: var(--accent);
      color: #fff;
      text-decoration: none;
      font-size: 18px;
      font-weight: 650;
      padding: 17px 20px;
      border-radius: 14px;
      box-shadow: 0 6px 18px rgba(26, 61, 124, 0.28);
      transition: transform 0.06s ease, filter 0.15s ease;
    }
    .cta:active { transform: translateY(1px); }
    .cta:hover { filter: brightness(1.06); }
    .cta[aria-disabled="true"] { opacity: 0.5; pointer-events: none; box-shadow: none; }
    .subtext { font-size: 14px; color: var(--muted); margin: 12px 0 0; }
    .footer {
      margin-top: 30px;
      padding-top: 22px;
      border-top: 1px solid #e7ebf3;
      font-size: 15px;
      color: var(--muted);
    }
    .config-note {
      margin: 14px 0 0;
      font-size: 13px;
      color: #b4560a;
      background: #fff6ea;
      border: 1px solid #f3d6ac;
      border-radius: 8px;
      padding: 8px 10px;
    }
    @media (max-width: 380px) {
      .card { padding: 32px 20px 26px; }
      h1 { font-size: 23px; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="stars" aria-hidden="true">${escapeHtml(cfg.stars || DEFAULT_CONFIG.stars)}</div>
    <h1>${nl2br(cfg.headline)}</h1>
    <p class="body">${nl2br(cfg.body)}</p>
    <a class="cta" href="${btnHref}"${hasUrl ? '' : ' aria-disabled="true"'} rel="noopener">${escapeHtml(cfg.buttonText)}</a>
    ${cfg.buttonSubtext ? `<p class="subtext">${escapeHtml(cfg.buttonSubtext)}</p>` : ''}
    ${disabledNote}
    <div class="footer">${nl2br(cfg.footer)}</div>
  </main>
</body>
</html>`;
}

/**
 * Token-gated editor form so the copy can be updated without touching code.
 */
function renderReviewLandingEditor(message) {
  const cfg = { ...DEFAULT_CONFIG, ...readConfigFile() };
  const msg = message ? `<p class="msg">${escapeHtml(message)}</p>` : '';
  const fields = EDITABLE_FIELDS.map((f) => {
    const val = cfg[f.key] != null ? cfg[f.key] : '';
    const input =
      f.type === 'textarea'
        ? `<textarea name="${f.key}" rows="3">${escapeHtml(val)}</textarea>`
        : `<input type="${f.type === 'url' ? 'url' : 'text'}" name="${f.key}" value="${escapeAttr(val)}"/>`;
    return `<div class="field"><label>${escapeHtml(f.label)}</label>${input}</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>Review landing page — edit copy</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7ecf3; }
    body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; }
    .card { background: #1a2332; border-radius: 10px; padding: 1.25rem; margin-top: 1rem; }
    label { display: block; font-size: 0.85rem; color: #9aa8bc; margin-bottom: 0.35rem; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 0.5rem 0.65rem; border-radius: 6px; border: 1px solid #334155; background: #0f1419; color: inherit; font: inherit; }
    .field { margin-top: 0.85rem; }
    button { margin-top: 1rem; padding: 0.6rem 1.1rem; border-radius: 6px; border: none; background: #2563eb; color: #fff; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .msg { color: #34d399; font-size: 0.9rem; }
    .hint { font-size: 0.8rem; color: #7d8da3; margin-top: 1rem; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <h1>Review landing page — edit copy</h1>
  ${msg}
  <div class="card">
    <form method="POST" action="/review/edit">
      <div class="field">
        <label>Admin token (ADMIN_TRIGGER_TOKEN)</label>
        <input type="password" name="token" autocomplete="current-password" placeholder="Paste token"/>
      </div>
      ${fields}
      <button type="submit">Save copy</button>
    </form>
    <p class="hint">Changes take effect immediately at <a href="/review">/review</a>. On hosts with an ephemeral filesystem, also set the matching REVIEW_PAGE_* env vars so edits survive a redeploy.</p>
  </div>
</body>
</html>`;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  EDITABLE_FIELDS,
  loadReviewLandingConfig,
  saveReviewLandingConfig,
  renderReviewLandingPage,
  renderReviewLandingEditor,
};
