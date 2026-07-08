const crypto = require('crypto');
const { google } = require('googleapis');

/**
 * Google sign-in gate for the review-page admin editor (/review/edit).
 *
 * Instead of a shared token, restrict editing to specific Google accounts
 * (an email allowlist and/or a Workspace hosted domain). The public page at
 * /review stays open; only the editor and its POST are gated.
 *
 * IMPORTANT: the OAuth client used here must be a **Web application** client
 * (the Sheets/Gmail one from setup-sheets-auth.js is a Desktop client and will
 * not work for a browser redirect). Create a Web client in Google Cloud
 * Console and add this Authorized redirect URI:
 *     https://<your-domain>/review/auth/callback
 *
 * Config (env):
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET  (Web client; falls
 *       back to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET if you made those Web)
 *   REVIEW_ADMIN_EMAILS   comma-separated allowed emails (case-insensitive)
 *   REVIEW_ADMIN_DOMAIN   optional Workspace domain, e.g. ramosjames.com
 *   REVIEW_AUTH_BASE_URL  optional; else derived from request headers
 *   REVIEW_SESSION_SECRET optional; else a random per-process secret
 *   REVIEW_SESSION_TTL_HOURS  optional session lifetime (default 12)
 */

const SESSION_COOKIE = 'rj_admin';
const STATE_COOKIE = 'rj_oauth_state';
const NEXT_COOKIE = 'rj_oauth_next';

/** Stable per-process fallback secret if REVIEW_SESSION_SECRET isn't set. */
const GENERATED_SECRET = crypto.randomBytes(32).toString('hex');

function clientId() {
  return (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
}
function clientSecret() {
  return (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '').trim();
}
function allowedEmails() {
  return new Set(
    (process.env.REVIEW_ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}
function allowedDomain() {
  return (process.env.REVIEW_ADMIN_DOMAIN || '').trim().toLowerCase();
}
function sessionSecret() {
  return (process.env.REVIEW_SESSION_SECRET || '').trim() || GENERATED_SECRET;
}
function sessionTtlMs() {
  const h = parseFloat(process.env.REVIEW_SESSION_TTL_HOURS || '12');
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600 * 1000;
}

/** Google gating is active when a Web client and an allowlist both exist. */
function isAuthEnabled() {
  const hasAllowlist = allowedEmails().size > 0 || Boolean(allowedDomain());
  return Boolean(clientId() && clientSecret() && hasAllowlist);
}

/** Human-readable reason auth can't turn on (for admin diagnostics). */
function authDisabledReason() {
  if (!clientId() || !clientSecret()) return 'Google Web OAuth client not set (GOOGLE_OAUTH_CLIENT_ID / _SECRET).';
  if (allowedEmails().size === 0 && !allowedDomain())
    return 'No allowlist (set REVIEW_ADMIN_EMAILS and/or REVIEW_ADMIN_DOMAIN).';
  return '';
}

/** Local-path guard for the post-login redirect (blocks open redirects). */
function safeNext(next) {
  const s = String(next || '').trim();
  if (/^\/[^/\\]/.test(s) || s === '/') return s.replace(/[\r\n]/g, '');
  return '/review/edit';
}

function baseUrl(req) {
  const override = (process.env.REVIEW_AUTH_BASE_URL || '').trim();
  if (override) return override.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${baseUrl(req)}/review/auth/callback`;
}

function oauthClient(req) {
  return new google.auth.OAuth2(clientId(), clientSecret(), redirectUri(req));
}

function isSecure(req) {
  return baseUrl(req).startsWith('https://');
}

// ── Cookies ─────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(res, name, value, { maxAgeMs, secure, path = '/' }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  if (maxAgeMs === 0) parts.push('Max-Age=0');
  else if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  appendSetCookie(res, parts.join('; '));
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
}

// ── Signed session token ──────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function sign(payloadStr) {
  return b64url(crypto.createHmac('sha256', sessionSecret()).update(payloadStr).digest());
}
function makeSessionToken(email) {
  const payload = b64url(JSON.stringify({ email, exp: Date.now() + sessionTtlMs() }));
  return `${payload}.${sign(payload)}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
  if (!obj || !obj.email || !obj.exp || Date.now() > obj.exp) return null;
  return { email: obj.email };
}

/** Returns { email } for a valid session cookie, else null. */
function getSession(req) {
  if (!isAuthEnabled()) return null;
  const token = parseCookies(req)[SESSION_COOKIE];
  return verifySessionToken(token);
}

function emailAllowed(email, hd) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  if (allowedEmails().has(e)) return true;
  const dom = allowedDomain();
  if (dom) {
    const emailDom = e.split('@')[1] || '';
    if (emailDom === dom && (!hd || String(hd).toLowerCase() === dom)) return true;
  }
  return false;
}

// ── Flow handlers ─────────────────────────────────────────────────────────────

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function startLogin(req, res, next) {
  const state = b64url(crypto.randomBytes(16));
  setCookie(res, STATE_COOKIE, state, { maxAgeMs: 10 * 60 * 1000, secure: isSecure(req) });
  setCookie(res, NEXT_COOKIE, safeNext(next), { maxAgeMs: 10 * 60 * 1000, secure: isSecure(req) });
  const params = {
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  };
  if (allowedDomain()) params.hd = allowedDomain();
  redirect(res, oauthClient(req).generateAuthUrl(params));
}

async function handleCallback(req, res, url, renderGate) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req);
  const cookieState = cookies[STATE_COOKIE];
  const next = safeNext(cookies[NEXT_COOKIE]);
  // Clear the one-time cookies regardless of outcome.
  setCookie(res, STATE_COOKIE, '', { maxAgeMs: 0, secure: isSecure(req) });
  setCookie(res, NEXT_COOKIE, '', { maxAgeMs: 0, secure: isSecure(req) });

  if (url.searchParams.get('error')) {
    return sendGate(res, renderGate, req, 403, `Sign-in was cancelled (${url.searchParams.get('error')}).`);
  }
  if (!code || !state || !cookieState || state !== cookieState) {
    return sendGate(res, renderGate, req, 400, 'Sign-in expired or invalid. Please try again.');
  }

  try {
    const client = oauthClient(req);
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) return sendGate(res, renderGate, req, 502, 'Google did not return an identity token.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId() });
    const payload = ticket.getPayload() || {};
    const email = payload.email;
    if (!payload.email_verified) return sendGate(res, renderGate, req, 403, 'Your Google email is not verified.');
    if (!emailAllowed(email, payload.hd)) {
      return sendGate(res, renderGate, req, 403, `${email} is not authorized to edit this page.`);
    }
    setCookie(res, SESSION_COOKIE, makeSessionToken(email), {
      maxAgeMs: sessionTtlMs(),
      secure: isSecure(req),
    });
    return redirect(res, next);
  } catch (err) {
    return sendGate(res, renderGate, req, 502, `Sign-in failed: ${err.message}`);
  }
}

function handleLogout(req, res) {
  setCookie(res, SESSION_COOKIE, '', { maxAgeMs: 0, secure: isSecure(req) });
  redirect(res, '/review/edit');
}

function sendGate(res, renderGate, req, status, message, next) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderGate(message, next));
}

/** Minimal "Sign in with Google" gate page. */
function renderAuthGate(message, next) {
  const loginHref = next && next !== '/review/edit'
    ? `/review/auth/login?next=${encodeURIComponent(next)}`
    : '/review/auth/login';
  const msg = message
    ? `<p style="color:#f87171;background:#2a1414;padding:.6rem .8rem;border-radius:8px;font-size:.9rem">${String(message)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>Sign in — review page admin</title>
<style>
  :root { font-family: system-ui, sans-serif; }
  body { background:#0f1419; color:#e7ecf3; display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; padding:1rem; }
  .card { background:#1a2332; border-radius:14px; padding:2rem; max-width:22rem; width:100%; text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 .4rem; }
  p.sub { color:#9aa8bc; font-size:.9rem; margin:0 0 1.3rem; }
  a.btn { display:inline-flex; align-items:center; gap:.6rem; background:#fff; color:#1f2937; text-decoration:none;
    font-weight:600; padding:.7rem 1.2rem; border-radius:8px; font-size:.95rem; }
  a.btn:hover { filter:brightness(.96); }
</style></head>
<body><div class="card">
  <h1>Review page admin</h1>
  <p class="sub">Sign in with an authorized Ramos James Google account to edit the review page.</p>
  ${msg}
  <a class="btn" href="${loginHref}">
    <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/><path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/></svg>
    Sign in with Google
  </a>
</div></body></html>`;
}

module.exports = {
  isAuthEnabled,
  authDisabledReason,
  getSession,
  startLogin,
  handleCallback,
  handleLogout,
  renderAuthGate,
  sendGate,
};
