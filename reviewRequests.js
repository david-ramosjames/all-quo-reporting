const crypto = require('crypto');
const { DateTime } = require('luxon');
const db = require('./reviewDb');

/**
 * review_requests + review_request_events — trackable review links and their
 * analytics. A request carries a short URL-safe token (no case number / client
 * name in the URL) that resolves to a firm + optional client personalization,
 * and per-request counters for opens and Google/Text/Call clicks. Each tracked
 * action also appends a lightweight event row (hashed IP only — never raw).
 */

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

const REQUESTS_TAB = process.env.GOOGLE_REVIEW_REQUESTS_TAB || 'review_requests';
const EVENTS_TAB = process.env.GOOGLE_REVIEW_EVENTS_TAB || 'review_request_events';

const REQUEST_HEADER = [
  'id',
  'token',
  'firm_id',
  'case_id',
  'client_id',
  'client_first_name',
  'client_name',
  'client_phone',
  'status',
  'source',
  'review_opportunity_id',
  'sent_at',
  'opened_at',
  'last_opened_at',
  'open_count',
  'google_clicked_at',
  'last_google_clicked_at',
  'google_click_count',
  'text_clicked_at',
  'last_text_clicked_at',
  'text_click_count',
  'call_clicked_at',
  'last_call_clicked_at',
  'call_click_count',
  'created_at',
  'updated_at',
];

const EVENT_HEADER = [
  'id',
  'review_request_id',
  'event_type',
  'user_agent',
  'ip_hash',
  'referrer',
  'created_at',
];

const EVENT_TYPES = new Set(['page_opened', 'google_clicked', 'text_clicked', 'call_clicked']);

/** event_type → { count, firstAt, lastAt } columns on the request row. */
const EVENT_FIELD_MAP = {
  page_opened: { count: 'open_count', firstAt: 'opened_at', lastAt: 'last_opened_at' },
  google_clicked: { count: 'google_click_count', firstAt: 'google_clicked_at', lastAt: 'last_google_clicked_at' },
  text_clicked: { count: 'text_click_count', firstAt: 'text_clicked_at', lastAt: 'last_text_clicked_at' },
  call_clicked: { count: 'call_click_count', firstAt: 'call_clicked_at', lastAt: 'last_call_clicked_at' },
};

const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TOKEN_LEN = Math.min(24, Math.max(8, parseInt(process.env.REVIEW_TOKEN_LENGTH || '10', 10) || 10));

const isConfigured = db.isConfigured;

function nowIso() {
  return DateTime.now().setZone(TIMEZONE).toISO();
}

function genToken(len = TOKEN_LEN) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return s;
}

/** Hash an IP with a salt so we never store the raw address. */
function hashIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  const salt = process.env.REVIEW_IP_HASH_SALT || 'rj-review-salt';
  return crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex').slice(0, 32);
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

async function allRequests(force = false) {
  if (!isConfigured()) return [];
  try {
    return await db.readObjects(REQUESTS_TAB, REQUEST_HEADER, { force });
  } catch {
    return [];
  }
}

async function getByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const rows = await allRequests();
  return rows.find((r) => r.token === t) || null;
}

async function findByOpportunityId(opportunityId) {
  const oid = String(opportunityId || '').trim();
  if (!oid) return null;
  const rows = await allRequests();
  return rows.find((r) => r.review_opportunity_id === oid) || null;
}

/**
 * Creates a review request with a unique token. If reviewOpportunityId is given
 * and one already exists, the existing request is returned (idempotent per
 * opportunity). Returns the record (with token) or null when the store is off.
 */
async function createReviewRequest(input = {}) {
  if (!isConfigured()) return null;

  if (input.reviewOpportunityId) {
    const existing = await findByOpportunityId(input.reviewOpportunityId);
    if (existing) return existing;
  }

  const rows = await allRequests(true);
  const taken = new Set(rows.map((r) => r.token));
  let token = genToken();
  let guard = 0;
  while (taken.has(token) && guard++ < 20) token = genToken();

  const now = nowIso();
  const rec = {
    id: crypto.randomUUID(),
    token,
    firm_id: input.firmId || '',
    case_id: input.caseId || '',
    client_id: input.clientId || '',
    client_first_name: input.clientFirstName || '',
    client_name: input.clientName || '',
    client_phone: input.clientPhone || '',
    status: input.status || 'created',
    source: input.source || 'review_intelligence',
    review_opportunity_id: input.reviewOpportunityId || '',
    sent_at: input.sentAt || '',
    opened_at: '',
    last_opened_at: '',
    open_count: 0,
    google_clicked_at: '',
    last_google_clicked_at: '',
    google_click_count: 0,
    text_clicked_at: '',
    last_text_clicked_at: '',
    text_click_count: 0,
    call_clicked_at: '',
    last_call_clicked_at: '',
    call_click_count: 0,
    created_at: now,
    updated_at: now,
  };
  await db.appendObject(REQUESTS_TAB, REQUEST_HEADER, rec);
  return rec;
}

/**
 * Records a tracked event for a token: appends an event row and increments the
 * matching counter/timestamps on the request row. Returns the (updated) request
 * so the caller can redirect, or null if the token is unknown.
 */
async function recordEvent(token, eventType, meta = {}) {
  if (!EVENT_TYPES.has(eventType)) return null;
  const req = await getByToken(token);
  if (!req) return null;
  if (!isConfigured()) return req;

  const now = nowIso();
  const map = EVENT_FIELD_MAP[eventType];

  const updated = { ...req };
  updated[map.count] = toInt(req[map.count]) + 1;
  if (!req[map.firstAt]) updated[map.firstAt] = now;
  updated[map.lastAt] = now;
  updated.updated_at = now;
  if (eventType === 'page_opened' && (req.status === 'created' || req.status === 'sent')) {
    updated.status = 'opened';
  } else if (eventType === 'google_clicked') {
    updated.status = 'google_clicked';
  }

  try {
    if (req._row) await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, req._row, updated);
    await db.appendObject(EVENTS_TAB, EVENT_HEADER, {
      id: crypto.randomUUID(),
      review_request_id: req.id,
      event_type: eventType,
      user_agent: String(meta.userAgent || '').slice(0, 400),
      ip_hash: meta.ipHash || '',
      referrer: String(meta.referrer || '').slice(0, 400),
      created_at: now,
    });
  } catch {
    /* best-effort tracking — never block the redirect */
  }
  return updated;
}

/** Marks a request as sent (sets sent_at + status). */
async function markSent(id, sentAtIso) {
  if (!isConfigured()) return false;
  const rows = await allRequests(true);
  const req = rows.find((r) => r.id === id || r.token === id);
  if (!req || !req._row) return false;
  const now = sentAtIso || nowIso();
  await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, req._row, {
    ...req,
    status: 'sent',
    sent_at: req.sent_at || now,
    updated_at: nowIso(),
  });
  return true;
}

async function listRequests() {
  const rows = await allRequests(true);
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Aggregate totals + rates for the analytics dashboard. */
async function aggregate() {
  const rows = await allRequests(true);
  const sum = (k) => rows.reduce((s, r) => s + toInt(r[k]), 0);
  const totalOpens = sum('open_count');
  const googleClicks = sum('google_click_count');
  const textClicks = sum('text_click_count');
  const callClicks = sum('call_click_count');
  const uniqueOpens = rows.filter((r) => toInt(r.open_count) > 0).length;
  const totalSent = rows.filter((r) => r.sent_at || r.status === 'sent' || r.status === 'opened' || r.status === 'google_clicked').length;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    totalRequests: rows.length,
    totalSent,
    totalOpens,
    uniqueOpens,
    googleClicks,
    textClicks,
    callClicks,
    googleCtr: pct(googleClicks, totalOpens),
    supportClickRate: pct(textClicks + callClicks, totalOpens),
  };
}

module.exports = {
  REQUEST_HEADER,
  EVENT_HEADER,
  EVENT_TYPES,
  isConfigured,
  genToken,
  hashIp,
  createReviewRequest,
  getByToken,
  findByOpportunityId,
  recordEvent,
  markSent,
  listRequests,
  aggregate,
};
