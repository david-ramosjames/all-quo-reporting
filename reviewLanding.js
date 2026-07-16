const fs = require('fs');
const path = require('path');

/**
 * Review Landing Page — a branded, mobile-first page whose one goal is to
 * convert a happy Ramos James client into a public Google review, while giving
 * anyone with an unresolved issue an obvious (but clearly secondary) way to
 * reach the firm instead of leaving a negative public review.
 *
 * Design: an extension of RamosJames.com — deep navy gradient, pink accent,
 * bright-blue CTA, logo, optional Laura note, and a support section.
 *
 * V1 principles: Google reviews only, one primary action, no review-gating,
 * and fully editable without code.
 *
 * Content is editable in three ways (later wins at render time):
 *   1. `review-landing.json` (or the file at REVIEW_LANDING_CONFIG_PATH),
 *   2. the token-gated admin editor at /review/edit, which writes that file,
 *   3. env-var overrides (persist across redeploys on ephemeral hosts).
 *
 * For durable edits on Railway, mount a volume and point
 * REVIEW_LANDING_CONFIG_PATH at a file on it; the editor then persists there.
 */

const CONFIG_PATH =
  (process.env.REVIEW_LANDING_CONFIG_PATH || '').trim() ||
  path.join(__dirname, 'review-landing.json');

const DEFAULT_CONFIG = {
  // Branding
  logoUrl: '',
  brandColor: '#0A1C40', // deep navy
  accentColor: '#F5218B', // pink
  ctaColor: '#45C7F0', // bright blue CTA
  backgroundStyle: 'gradient', // gradient | solid
  backgroundColor: '#0A1C40',
  showAvailable247: true,
  available247Text: 'Available 24/7',
  // Main content
  headline: 'Thank you for choosing Ramos James.',
  body:
    'Most people find us during one of the most stressful moments of their lives. Your review helps injured Texans feel confident they’re choosing a law firm they can trust.',
  buttonText: 'Leave a Google Review',
  googleReviewUrl: '',
  // Additional review platforms — a button appears for each one that has a URL.
  facebookReviewUrl: '',
  appleReviewUrl: '',
  yelpReviewUrl: '',
  // Button order (comma-separated). The FIRST configured one is the primary —
  // shown in the button colour with the helper text as its subtitle.
  reviewButtonOrder: 'google,facebook,apple,yelp',
  helperText: 'Takes about 60 seconds',
  // Laura section
  showLaura: true,
  lauraImageUrl: '',
  lauraQuote:
    'It was an honor to represent you. If our team made a difference during your case, we’d truly appreciate you sharing your experience.',
  lauraAttribution: '— Laura Ramos',
  // Support section
  helpHeadline: 'Still have a question or concern?',
  helpBody:
    'If there’s anything we can do to make your experience better, please contact us directly.',
  textLabel: 'Text Us',
  textNumber: '+15128723341',
  callLabel: 'Call Us',
  callNumber: '+15128723341',
  // Footer
  footer: 'Ramos James Law, PLLC · Austin, TX',
  // The SMS body sent to a client with their review link. Tokens: {first} {firm} {link}
  smsTemplate:
    'Hi {first}, thank you for trusting {firm}. If we made a difference, a quick Google review would mean a lot: {link}',
};

/**
 * Field schema — drives both the editor form and save-time validation.
 * type ∈ text | textarea | url | color | image | tel | bool | select
 */
const FIELD_DEFS = [
  // Branding
  { key: 'logoUrl', label: 'Logo (URL or upload)', type: 'image', group: 'Branding' },
  { key: 'brandColor', label: 'Primary brand color', type: 'color', group: 'Branding' },
  { key: 'accentColor', label: 'Accent color (pink)', type: 'color', group: 'Branding' },
  { key: 'ctaColor', label: 'Google button color', type: 'color', group: 'Branding' },
  {
    key: 'backgroundStyle',
    label: 'Background style',
    type: 'select',
    options: ['gradient', 'solid'],
    group: 'Branding',
  },
  { key: 'backgroundColor', label: 'Background base color', type: 'color', group: 'Branding' },
  { key: 'showAvailable247', label: 'Show “Available 24/7”', type: 'bool', group: 'Branding' },
  { key: 'available247Text', label: '“Available 24/7” text', type: 'text', group: 'Branding' },
  // Main content
  { key: 'headline', label: 'Headline (default copy)', type: 'text', group: 'Main content' },
  { key: 'body', label: 'Body copy', type: 'textarea', group: 'Main content' },
  { key: 'buttonText', label: 'Google review button text', type: 'text', group: 'Main content' },
  { key: 'googleReviewUrl', label: 'Google review URL', type: 'url', group: 'Main content' },
  { key: 'facebookReviewUrl', label: 'Facebook review URL', type: 'url', group: 'Main content' },
  { key: 'appleReviewUrl', label: 'Apple Maps review URL', type: 'url', group: 'Main content' },
  { key: 'yelpReviewUrl', label: 'Yelp review URL', type: 'url', group: 'Main content' },
  { key: 'reviewButtonOrder', label: 'Button order — comma-separated (google, facebook, apple, yelp); first = primary, shown in color', type: 'text', group: 'Main content' },
  { key: 'helperText', label: 'Helper text under button', type: 'text', group: 'Main content' },
  // Laura section
  { key: 'showLaura', label: 'Show Laura section', type: 'bool', group: 'Laura section' },
  { key: 'lauraImageUrl', label: 'Laura image (URL or upload)', type: 'image', group: 'Laura section' },
  { key: 'lauraQuote', label: 'Laura quote', type: 'textarea', group: 'Laura section' },
  { key: 'lauraAttribution', label: 'Laura attribution', type: 'text', group: 'Laura section' },
  // Support section
  { key: 'helpHeadline', label: 'Help section headline', type: 'text', group: 'Support section' },
  { key: 'helpBody', label: 'Help section body copy', type: 'textarea', group: 'Support section' },
  { key: 'textLabel', label: 'Text button label', type: 'text', group: 'Support section' },
  { key: 'textNumber', label: 'Text phone number (SMS)', type: 'tel', group: 'Support section' },
  { key: 'callLabel', label: 'Call button label', type: 'text', group: 'Support section' },
  { key: 'callNumber', label: 'Call phone number', type: 'tel', group: 'Support section' },
  // Footer
  { key: 'footer', label: 'Footer text', type: 'textarea', group: 'Footer' },
  // Text message sent to clients
  {
    key: 'smsTemplate',
    label: 'Review text message — tokens: {first} {firm} {link}',
    type: 'textarea',
    group: 'Text message',
  },
];

const BOOL_KEYS = new Set(FIELD_DEFS.filter((f) => f.type === 'bool').map((f) => f.key));
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/** Env-var overrides for the operationally critical / most-edited fields. */
const ENV_OVERRIDES = {
  logoUrl: 'REVIEW_PAGE_LOGO_URL',
  brandColor: 'REVIEW_PAGE_BRAND_COLOR',
  accentColor: 'REVIEW_PAGE_ACCENT',
  ctaColor: 'REVIEW_PAGE_CTA_COLOR',
  headline: 'REVIEW_PAGE_HEADLINE',
  body: 'REVIEW_PAGE_BODY',
  buttonText: 'REVIEW_PAGE_BUTTON_TEXT',
  googleReviewUrl: 'REVIEW_GOOGLE_URL',
  facebookReviewUrl: 'REVIEW_FACEBOOK_URL',
  appleReviewUrl: 'REVIEW_APPLE_URL',
  yelpReviewUrl: 'REVIEW_YELP_URL',
  helperText: 'REVIEW_PAGE_HELPER',
  lauraImageUrl: 'REVIEW_PAGE_LAURA_IMAGE',
  textNumber: 'REVIEW_PAGE_TEXT_NUMBER',
  callNumber: 'REVIEW_PAGE_CALL_NUMBER',
  footer: 'REVIEW_PAGE_FOOTER',
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

function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(s)) return true;
  if (['false', 'off', '0', 'no', ''].includes(s)) return false;
  return fallback;
}

/** Effective config: defaults ← file ← env var overrides. */
function loadReviewLandingConfig() {
  const fileCfg = readConfigFile();
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of KNOWN_KEYS) {
    if (fileCfg[k] === undefined || fileCfg[k] === null) continue;
    cfg[k] = BOOL_KEYS.has(k) ? coerceBool(fileCfg[k], DEFAULT_CONFIG[k]) : fileCfg[k];
  }
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    const v = process.env[envName];
    if (v != null && String(v).trim() !== '') {
      cfg[key] = BOOL_KEYS.has(key) ? coerceBool(v, cfg[key]) : v;
    }
  }
  return cfg;
}

/**
 * Persists edited copy back to the config file. Only known keys are written;
 * bool keys are coerced; everything else is stored as a trimmed string.
 * @returns {{ ok: boolean, config?: object, error?: string }}
 */
function saveReviewLandingConfig(patch) {
  const current = loadReviewLandingConfigFromFileOnly();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!KNOWN_KEYS.has(k)) continue;
    if (BOOL_KEYS.has(k)) {
      next[k] = coerceBool(v, DEFAULT_CONFIG[k]);
    } else if (typeof v === 'string') {
      next[k] = v;
    }
  }
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ok: true, config: next };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Defaults ← file only (no env), so saving does not bake env overrides into the file. */
function loadReviewLandingConfigFromFileOnly() {
  const fileCfg = readConfigFile();
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of KNOWN_KEYS) {
    if (fileCfg[k] === undefined || fileCfg[k] === null) continue;
    cfg[k] = BOOL_KEYS.has(k) ? coerceBool(fileCfg[k], DEFAULT_CONFIG[k]) : fileCfg[k];
  }
  return cfg;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
function nl2br(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br/>');
}
function hexOk(v) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(v || '').trim());
}
function safeColor(v, fallback) {
  return hexOk(v) ? String(v).trim() : fallback;
}

/** #rrggbb → readable foreground (dark navy or white) using luminance. */
function readableTextColor(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length < 6) return '#ffffff';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0A1C40' : '#ffffff';
}

/** Normalize a phone/number to a tel/sms href value (+1 for US 10-digit). */
function telHref(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\+/.test(s)) return '+' + s.replace(/[^\d]/g, '');
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

function formatPhoneDisplay(raw) {
  const href = telHref(raw);
  const d = href.replace(/^\+/, '');
  const us = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (us.length === 10) return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  return String(raw || '').trim();
}

/** First name from a query param — letters/spaces/’-. only, Title-cased, capped. */
function sanitizeFirstName(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^A-Za-zÀ-ÿ'’\- ]/g, '')
    .slice(0, 40)
    .trim();
  if (!cleaned) return '';
  const first = cleaned.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

const GOOGLE_G_SVG =
  '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style="vertical-align:-4px;margin-right:10px">' +
  '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>' +
  '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
  '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>' +
  '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>' +
  '</svg>';

// Brand marks for the other review platforms, matched to the Google icon's size/style.
const ICON_ATTRS = 'width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-4px;margin-right:10px"';
const FACEBOOK_SVG =
  `<svg ${ICON_ATTRS}><path fill="#1877F2" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`;
const APPLE_SVG =
  `<svg ${ICON_ATTRS}><path fill="#000000" d="M17.05 12.536c-.03-3.017 2.47-4.463 2.582-4.535-1.406-2.056-3.594-2.338-4.373-2.37-1.861-.189-3.635 1.098-4.58 1.098-.944 0-2.401-1.07-3.95-1.042-2.033.03-3.907 1.182-4.951 3.003-2.11 3.663-.54 9.085 1.51 12.06 1.003 1.456 2.198 3.09 3.766 3.032 1.51-.06 2.08-.977 3.905-.977 1.826 0 2.34.977 3.937.947 1.625-.027 2.653-1.485 3.647-2.945 1.148-1.688 1.62-3.323 1.65-3.407-.036-.015-3.166-1.216-3.198-4.864zM14.09 4.36c.834-1.01 1.397-2.416 1.243-3.815-1.202.048-2.657.8-3.518 1.81-.772.895-1.448 2.324-1.267 3.696 1.34.104 2.708-.68 3.542-1.69z"/></svg>`;
const YELP_SVG =
  `<svg ${ICON_ATTRS}><path fill="#D32323" d="M20.16 12.594l-4.995 1.433c-.96.276-1.74-.8-1.176-1.63l2.905-4.308a.792.792 0 0 1 1.062-.222 8.638 8.638 0 0 1 2.906 3.57.79.79 0 0 1-.702 1.157zm-2.352 5.946l-4.215-2.048c-.955-.464-.594-1.913.445-1.825l5.078.375a.786.786 0 0 1 .719.767 8.638 8.638 0 0 1-1.16 4.405.79.79 0 0 1-.867-.673zm-6.577-1.848l.006 5.085a.79.79 0 0 1-.888.79 8.638 8.638 0 0 1-4.19-1.758.79.79 0 0 1 .016-1.24l3.87-3.027c.75-.587 1.836-.037 1.836.148zm-3.9-3.174l-4.87-1.634a.79.79 0 0 1-.5-1.02 8.638 8.638 0 0 1 2.42-3.72.79.79 0 0 1 1.19.147l2.816 4.227c.578.867-.216 2.005-1.056 1.733zm2.99-2.995L7.474 5.09a.79.79 0 0 1 .372-1.17A8.638 8.638 0 0 1 12.32 3.3a.79.79 0 0 1 .78.8l-.16 6.145c-.024.998-1.278 1.404-1.83.593z"/></svg>`;

/**
 * Renders the public, mobile-first landing page.
 * @param {object} [configOverride]
 * @param {{ firstName?: string }} [opts]
 */
function renderReviewLandingPage(configOverride, opts = {}) {
  const cfg = configOverride || loadReviewLandingConfig();

  const brand = safeColor(cfg.brandColor, DEFAULT_CONFIG.brandColor);
  const accent = safeColor(cfg.accentColor, DEFAULT_CONFIG.accentColor);
  const cta = safeColor(cfg.ctaColor, DEFAULT_CONFIG.ctaColor);
  const bgBase = safeColor(cfg.backgroundColor, brand);
  const ctaText = readableTextColor(cta);

  const bg =
    String(cfg.backgroundStyle) === 'solid'
      ? bgBase
      : `radial-gradient(1200px 600px at 50% -10%, ${accent}22 0%, transparent 60%), ` +
        `radial-gradient(900px 500px at 90% 10%, ${accent}18 0%, transparent 55%), ` +
        `linear-gradient(160deg, ${bgBase} 0%, ${shade(bgBase, 18)} 55%, ${shade(bgBase, -8)} 100%)`;

  const firstName = sanitizeFirstName(opts.firstName);
  const headline = firstName ? `Thank you, ${firstName}.` : cfg.headline;

  // Tracking mode: when a token base like "/r/8Ksd92L" is supplied, the buttons
  // point at internal tracking routes (which record the click, then redirect)
  // instead of linking straight to Google / sms: / tel:.
  const trackingBase = opts.trackingBase ? String(opts.trackingBase).replace(/\/+$/, '') : '';
  const tracking = Boolean(trackingBase);

  // Review CTAs: one button per configured platform (Google primary, the others
  // secondary). In tracking mode each points at the internal /r/<token>/<platform>
  // route (records the click, then redirects); otherwise straight to the URL.
  const PLATFORM_META = {
    google: { urlKey: 'googleReviewUrl', label: cfg.buttonText || 'Leave a Google Review', icon: GOOGLE_G_SVG },
    facebook: { urlKey: 'facebookReviewUrl', label: 'Review us on Facebook', icon: FACEBOOK_SVG },
    apple: { urlKey: 'appleReviewUrl', label: 'Review us on Apple Maps', icon: APPLE_SVG },
    yelp: { urlKey: 'yelpReviewUrl', label: 'Review us on Yelp', icon: YELP_SVG },
  };
  // Admin-controlled order; the first configured platform is the primary button.
  const seenKeys = new Set();
  const orderedKeys = String(cfg.reviewButtonOrder || 'google,facebook,apple,yelp')
    .split(',').map((s) => s.trim().toLowerCase())
    .filter((k) => PLATFORM_META[k] && !seenKeys.has(k) && seenKeys.add(k));
  const configuredKeys = orderedKeys.filter(
    (k) => /^https?:\/\//i.test(String(cfg[PLATFORM_META[k].urlKey] || '').trim())
  );
  const helperSub = String(cfg.helperText || '').trim();
  const reviewButtons = configuredKeys.map((k, i) => {
    const p = PLATFORM_META[k];
    const raw = String(cfg[p.urlKey] || '').trim();
    const href = tracking ? `${escapeAttr(trackingBase)}/${k}` : escapeAttr(raw);
    if (i === 0) {
      // Primary: coloured, larger, with the helper text as a subtitle line.
      const sub = helperSub ? `<span class="cta-sub">${escapeHtml(helperSub)}</span>` : '';
      return `<a class="cta has-sub" href="${href}" rel="noopener"><span class="cta-label">${p.icon}${escapeHtml(p.label)}</span>${sub}</a>`;
    }
    return `<a class="cta secondary" href="${href}" rel="noopener">${p.icon}${escapeHtml(p.label)}</a>`;
  }).join('');
  const hasAnyPlatform = configuredKeys.length > 0;
  const ctaBlock = hasAnyPlatform
    ? `<div class="cta-group">${reviewButtons}</div>`
    : `<a class="cta" href="#" aria-disabled="true" rel="noopener">${GOOGLE_G_SVG}${escapeHtml(cfg.buttonText)}</a>`;
  const disabledNote = hasAnyPlatform
    ? ''
    : '<p class="config-note">Set at least one review URL (Google / Facebook / Apple / Yelp) in the admin to activate.</p>';

  const logo = String(cfg.logoUrl || '').trim();
  const logoBlock = logo
    ? `<img class="logo-img" src="${escapeAttr(logo)}" alt="Ramos James Law"/>`
    : `<div class="logo-word"><span class="logo-mark">RJ</span><span class="logo-name">RAMOS JAMES LAW, PLLC</span></div>`;

  const available247 = coerceBool(cfg.showAvailable247, true)
    ? `<div class="avail">${escapeHtml(cfg.available247Text || 'Available 24/7')}</div>`
    : '';

  const showLaura = coerceBool(cfg.showLaura, true);
  const lauraImg = String(cfg.lauraImageUrl || '').trim();
  // Laura sits high on the page (just under the headline, where the body used to
  // be), so no leading divider here.
  const lauraBlock = showLaura
    ? `<section class="laura">
        ${lauraImg ? `<img class="laura-img" src="${escapeAttr(lauraImg)}" alt="Laura Ramos"/>` : ''}
        <p class="laura-quote">${nl2br(cfg.lauraQuote)}</p>
        <p class="laura-attr">${escapeHtml(cfg.lauraAttribution)}</p>
      </section>`
    : '';

  // The body copy moves down beneath the support section, with a divider above it.
  const bottomBody = String(cfg.body || '').trim()
    ? `<div class="divider"></div><p class="body">${nl2br(cfg.body)}</p>`
    : '';

  const textHref = telHref(cfg.textNumber);
  const callHref = telHref(cfg.callNumber);
  const textTarget = tracking ? `${escapeAttr(trackingBase)}/text` : textHref ? `sms:${escapeAttr(textHref)}` : '';
  const callTarget = tracking ? `${escapeAttr(trackingBase)}/call` : callHref ? `tel:${escapeAttr(callHref)}` : '';
  const supportButtons = [
    textHref
      ? `<a class="support-btn" href="${textTarget}">${supportIcon('text')}${escapeHtml(cfg.textLabel || 'Text Us')}</a>`
      : '',
    callHref
      ? `<a class="support-btn" href="${callTarget}">${supportIcon('call')}${escapeHtml(cfg.callLabel || 'Call Us')}</a>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const helpBlock =
    cfg.helpHeadline || cfg.helpBody || supportButtons
      ? `<div class="divider"></div>
        <section class="help">
          <h2 class="help-h">${escapeHtml(cfg.helpHeadline)}</h2>
          <p class="help-b">${nl2br(cfg.helpBody)}</p>
          <div class="support-row">${supportButtons}</div>
        </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <meta name="robots" content="noindex"/>
  <title>${escapeHtml(headline)}</title>
  <style>
    :root {
      --brand: ${brand};
      --accent: ${accent};
      --cta: ${cta};
      --cta-text: ${ctaText};
      --ink: #10203f;
      --muted: #5b6a86;
      --card: #ffffff;
      --gold: #F6B60B;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: ${bg};
      background-attachment: fixed;
      color: var(--ink);
      min-height: 100vh; min-height: 100dvh;
      display: flex; flex-direction: column; align-items: center;
      padding: 28px 18px calc(28px + env(safe-area-inset-bottom));
      -webkit-font-smoothing: antialiased;
    }
    .header { text-align: center; margin: 8px 0 22px; color: #fff; }
    .logo-img { max-height: 62px; max-width: 276px; width: auto; }
    .logo-word { display: inline-flex; flex-direction: column; align-items: center; gap: 6px; }
    .logo-mark {
      font-family: Georgia, "Times New Roman", serif; font-size: 39px; font-weight: 700;
      letter-spacing: 1px; line-height: 1; color: #fff;
      border: 2px solid rgba(255,255,255,.55); border-radius: 8px; padding: 7px 14px;
    }
    .logo-name { font-family: Georgia, serif; font-size: 14.5px; letter-spacing: 3px; color: #eaf0ff; }
    .avail { margin-top: 12px; font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--accent); }
    .card {
      background: var(--card); width: 100%; max-width: 30rem; border-radius: 24px;
      padding: 38px 26px 30px; text-align: center;
      box-shadow: 0 24px 60px rgba(4, 12, 30, 0.45);
    }
    .stars { color: var(--gold); font-size: 30px; letter-spacing: 5px; line-height: 1; margin-bottom: 18px; text-shadow: 0 1px 0 rgba(0,0,0,.06); }
    h1 { font-size: 27px; line-height: 1.22; margin: 0 0 14px; font-weight: 750; letter-spacing: -0.01em; color: var(--ink); }
    .body { font-size: 16.5px; line-height: 1.55; color: var(--muted); margin: 0 auto 26px; max-width: 27rem; }
    .cta {
      display: flex; align-items: center; justify-content: center; width: 100%;
      background: var(--cta); color: var(--cta-text); text-decoration: none;
      font-size: 18px; font-weight: 700; padding: 17px 20px; border-radius: 14px;
      box-shadow: 0 10px 24px ${shade(cta, -6)}66; transition: transform .06s ease, filter .15s ease;
    }
    .cta:active { transform: translateY(1px); }
    .cta:hover { filter: brightness(1.05); }
    .cta[aria-disabled="true"] { opacity: .5; pointer-events: none; box-shadow: none; }
    .cta-group { display: flex; flex-direction: column; gap: 12px; }
    .cta.has-sub { flex-direction: column; gap: 3px; padding-top: 15px; padding-bottom: 15px; }
    .cta .cta-label { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
    .cta .cta-sub { font-size: 12.5px; font-weight: 500; opacity: .9; }
    .cta.secondary { background: transparent; color: var(--ink); box-shadow: none;
      border: 1.5px solid ${shade(cta, -6)}55; font-size: 16px; padding: 14px 20px; }
    .cta.secondary:hover { filter: none; background: ${shade(cta, 40)}14; }
    .helper { font-size: 13.5px; color: var(--muted); margin: 12px 0 0; }
    .config-note { margin: 12px 0 0; font-size: 13px; color: #b4560a; background: #fff6ea; border: 1px solid #f3d6ac; border-radius: 8px; padding: 8px 10px; }
    .laura { margin: 2px 0 4px; }
    .laura-img { width: 76px; height: 76px; border-radius: 50%; object-fit: cover; border: 3px solid #eef2fb; margin-bottom: 12px; }
    .laura-quote { font-size: 15px; line-height: 1.55; font-style: italic; color: #3c4a66; margin: 0 auto 8px; max-width: 26rem; }
    .laura-attr { font-size: 14px; font-weight: 700; color: var(--accent); margin: 0; }
    .divider { height: 1px; background: #e7ecf6; margin: 26px 0 22px; }
    .help { background: #f5f8fd; border: 1px solid #e7edf7; border-radius: 16px; padding: 20px 18px; }
    .help-h { font-size: 16px; font-weight: 700; color: var(--ink); margin: 0 0 6px; }
    .help-b { font-size: 14.5px; line-height: 1.5; color: var(--muted); margin: 0 0 16px; }
    .support-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .support-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      flex: 1 1 40%; min-width: 130px;
      background: #fff; color: var(--ink); text-decoration: none;
      border: 1.5px solid ${accent}; border-radius: 12px; padding: 12px 16px;
      font-size: 15px; font-weight: 650; transition: background .15s ease;
    }
    .support-btn:hover { background: ${accent}0f; }
    .support-btn svg { width: 17px; height: 17px; }
    .footer { color: #b8c4e0; font-size: 12.5px; text-align: center; margin: 22px 0 4px; line-height: 1.5; }
    @media (max-width: 380px) {
      .card { padding: 30px 20px 24px; }
      h1 { font-size: 24px; }
      .support-btn { flex-basis: 100%; }
    }
  </style>
</head>
<body>
  <header class="header">
    ${logoBlock}
    ${available247}
  </header>
  <main class="card">
    <div class="stars" aria-hidden="true">★★★★★</div>
    <h1>${nl2br(headline)}</h1>
    ${lauraBlock}
    ${ctaBlock}
    ${disabledNote}
    ${helpBlock}
    ${bottomBody}
  </main>
  <footer class="footer">${nl2br(cfg.footer)}</footer>
</body>
</html>`;
}

function supportIcon(kind) {
  if (kind === 'text') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 0 1 21 11.5z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';
}

/** Lighten (positive) or darken (negative) a hex color by percent. */
function shade(hex, percent) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length < 6) return hex;
  const num = parseInt(h.slice(0, 6), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.max(0, Math.min(255, (num >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// ── Admin editor ──────────────────────────────────────────────────────────────

function renderReviewLandingEditor(message, opts = {}) {
  const cfg = opts.config && typeof opts.config === 'object'
    ? { ...DEFAULT_CONFIG, ...opts.config }
    : loadReviewLandingConfigFromFileOnly();
  const authMode = opts.authMode === 'google' ? 'google' : 'token';
  const msg = message
    ? `<p class="msg ${/fail|invalid|disabled|not set/i.test(message) ? 'err' : 'ok'}">${escapeHtml(message)}</p>`
    : '';

  // Firm selector — each firm has its own review-page branding.
  const firms = Array.isArray(opts.firms) ? opts.firms : [];
  const firmId = opts.firmId || '';
  const firmSelector = firms.length > 1
    ? `<div class="field" style="max-width:22rem"><label>Editing which firm's page</label>
        <select onchange="if(this.value)location.href='/review/edit?firm='+encodeURIComponent(this.value)">
          ${firms.map((f) => `<option value="${escapeAttr(f.id)}"${f.id === firmId ? ' selected' : ''}>${escapeHtml(f.firm_name || f.id)}</option>`).join('')}
        </select></div>`
    : '';

  const groups = [];
  const seen = new Set();
  for (const f of FIELD_DEFS) {
    if (!seen.has(f.group)) {
      seen.add(f.group);
      groups.push(f.group);
    }
  }

  const sections = groups
    .map((group) => {
      const fields = FIELD_DEFS.filter((f) => f.group === group)
        .map((f) => renderEditorField(f, cfg[f.key]))
        .join('\n');
      return `<fieldset><legend>${escapeHtml(group)}</legend>${fields}</fieldset>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex"/>
  <title>Review page — admin editor</title>
  <style>
    :root { font-family: system-ui, sans-serif; background: #0f1419; color: #e7ecf3; }
    body { max-width: 44rem; margin: 2rem auto; padding: 0 1rem 4rem; line-height: 1.5; }
    h1 { font-size: 1.3rem; }
    a { color: #60a5fa; }
    fieldset { border: 1px solid #263247; border-radius: 10px; margin: 1.1rem 0 0; padding: 0.4rem 1rem 1rem; background: #131c2b; }
    legend { padding: 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: 1px; color: #7fa9e6; }
    .field { margin-top: .85rem; }
    label { display: block; font-size: .82rem; color: #9aa8bc; margin-bottom: .35rem; }
    input[type=text], input[type=url], input[type=tel], textarea, select {
      width: 100%; box-sizing: border-box; padding: .5rem .65rem; border-radius: 6px;
      border: 1px solid #334155; background: #0f1419; color: inherit; font: inherit;
    }
    textarea { min-height: 4.2rem; resize: vertical; }
    input[type=color] { width: 3rem; height: 2rem; padding: 0; border: 1px solid #334155; border-radius: 6px; background: #0f1419; vertical-align: middle; }
    .inline { display: flex; align-items: center; gap: .6rem; }
    .check { display: flex; align-items: center; gap: .5rem; }
    .check input { width: 1.05rem; height: 1.05rem; }
    .img-row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    .img-row input[type=text] { flex: 1 1 16rem; }
    .thumb { max-height: 48px; max-width: 120px; border-radius: 6px; border: 1px solid #334155; display: none; }
    .thumb.show { display: inline-block; }
    .bar { position: sticky; top: 0; background: #0f1419; padding: .8rem 0; z-index: 5; display: flex; gap: .8rem; align-items: center; }
    button { padding: .6rem 1.15rem; border-radius: 6px; border: none; background: #2563eb; color: #fff; font-size: .95rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .tokenbox { margin-left: auto; }
    .tokenbox input { width: 14rem; }
    .msg { font-size: .9rem; padding: .5rem .7rem; border-radius: 6px; }
    .msg.ok { color: #34d399; background: #0d2a20; }
    .msg.err { color: #f87171; background: #2a1414; }
    .hint { font-size: .8rem; color: #7d8da3; margin-top: 1.2rem; }
  </style>
</head>
<body>
  <h1>Review page — admin editor</h1>
  <p><a href="/review" target="_blank">Open live page ↗</a> · <a href="/review/firms">Manage firms</a></p>
  ${firmSelector}
  ${msg}
  <form method="POST" action="/review/edit">
    <input type="hidden" name="firmId" value="${escapeAttr(firmId)}"/>
    <div class="bar">
      <button type="submit">Save changes</button>
      <div class="tokenbox">
        ${
          authMode === 'google'
            ? `<span style="font-size:.85rem;color:#9aa8bc">Signed in as ${escapeHtml(opts.email || '')} · <a href="/review/auth/logout">Log out</a></span>`
            : `<input type="password" name="token" autocomplete="current-password" placeholder="Admin token" required/>`
        }
      </div>
    </div>
    ${sections}
    <p class="hint">Changes apply immediately at <a href="/review">/review</a>. On an ephemeral host, either set the matching <code>REVIEW_PAGE_*</code> env vars or point <code>REVIEW_LANDING_CONFIG_PATH</code> at a file on a persistent volume so edits survive a redeploy. Uploaded images are embedded directly in the page (keep them small — under ~300&nbsp;KB).</p>
  </form>
  <script>
  document.querySelectorAll('[data-upload-for]').forEach(function (input) {
    input.addEventListener('change', function () {
      var target = document.querySelector('[name="' + input.getAttribute('data-upload-for') + '"]');
      var thumb = document.querySelector('[data-thumb-for="' + input.getAttribute('data-upload-for') + '"]');
      var file = input.files && input.files[0];
      if (!file || !target) return;
      var reader = new FileReader();
      reader.onload = function () {
        target.value = reader.result;
        if (thumb) { thumb.src = reader.result; thumb.classList.add('show'); }
      };
      reader.readAsDataURL(file);
    });
  });
  document.querySelectorAll('[data-thumb-for]').forEach(function (thumb) {
    var name = thumb.getAttribute('data-thumb-for');
    var target = document.querySelector('[name="' + name + '"]');
    if (target && target.value) { thumb.src = target.value; thumb.classList.add('show'); }
  });
  </script>
</body>
</html>`;
}

function renderEditorField(f, value) {
  const v = value == null ? '' : value;
  const id = `f_${f.key}`;
  if (f.type === 'bool') {
    const checked = coerceBool(v, false) ? ' checked' : '';
    return `<div class="field check">
      <input type="hidden" name="${f.key}" value="false"/>
      <input type="checkbox" id="${id}" name="${f.key}" value="true"${checked}/>
      <label for="${id}" style="margin:0">${escapeHtml(f.label)}</label>
    </div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>
      <textarea id="${id}" name="${f.key}">${escapeHtml(v)}</textarea></div>`;
  }
  if (f.type === 'color') {
    const color = hexOk(v) ? v : DEFAULT_CONFIG[f.key] || '#000000';
    return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>
      <div class="inline">
        <input type="color" id="${id}" value="${escapeAttr(color)}" oninput="this.nextElementSibling.value=this.value"/>
        <input type="text" name="${f.key}" value="${escapeAttr(v)}" style="max-width:9rem" oninput="this.previousElementSibling.value=/^#[0-9a-fA-F]{3,8}$/.test(this.value)?this.value:this.previousElementSibling.value"/>
      </div></div>`;
  }
  if (f.type === 'select') {
    const opts = (f.options || [])
      .map((o) => `<option value="${escapeAttr(o)}"${String(v) === o ? ' selected' : ''}>${escapeHtml(o)}</option>`)
      .join('');
    return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>
      <select id="${id}" name="${f.key}">${opts}</select></div>`;
  }
  if (f.type === 'image') {
    return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>
      <div class="img-row">
        <input type="text" id="${id}" name="${f.key}" value="${escapeAttr(v)}" placeholder="https://… or upload"/>
        <input type="file" accept="image/*" data-upload-for="${f.key}"/>
        <img class="thumb" data-thumb-for="${f.key}" alt=""/>
      </div></div>`;
  }
  const inputType = f.type === 'url' ? 'url' : f.type === 'tel' ? 'tel' : 'text';
  return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>
    <input type="${inputType}" id="${id}" name="${f.key}" value="${escapeAttr(v)}"/></div>`;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  FIELD_DEFS,
  loadReviewLandingConfig,
  saveReviewLandingConfig,
  renderReviewLandingPage,
  renderReviewLandingEditor,
};
