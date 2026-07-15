const crypto = require('crypto');
const { DateTime } = require('luxon');
const db = require('./reviewDb');
const pg = require('./pgStore');

/**
 * review_requests + review_request_events — trackable review links and their
 * analytics. A request carries a short URL-safe token (no case number / client
 * name in the URL) and per-request counters for opens and Google/Text/Call
 * clicks. It also records which Slack message announced it, so a ✅ reaction /
 * reply on that message can approve the text send.
 *
 * Backend: Postgres when DATABASE_URL is set (atomic counters), otherwise the
 * Google Sheets tables, otherwise a no-op. Each tracked action appends a
 * lightweight event row (hashed IP only — never raw).
 */

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

const REQUESTS_TAB = process.env.GOOGLE_REVIEW_REQUESTS_TAB || 'review_requests';
const EVENTS_TAB = process.env.GOOGLE_REVIEW_EVENTS_TAB || 'review_request_events';

const REQUEST_HEADER = [
  'id', 'token', 'firm_id', 'case_id', 'client_id', 'client_first_name', 'client_name',
  'client_phone', 'status', 'source', 'review_opportunity_id',
  'slack_channel', 'slack_message_ts', 'approved_at', 'approved_by',
  'sent_at', 'opened_at', 'last_opened_at', 'open_count',
  'google_clicked_at', 'last_google_clicked_at', 'google_click_count',
  'facebook_clicked_at', 'last_facebook_clicked_at', 'facebook_click_count',
  'apple_clicked_at', 'last_apple_clicked_at', 'apple_click_count',
  'yelp_clicked_at', 'last_yelp_clicked_at', 'yelp_click_count',
  'text_clicked_at', 'last_text_clicked_at', 'text_click_count',
  'call_clicked_at', 'last_call_clicked_at', 'call_click_count',
  'review_destination', 'created_at', 'updated_at',
];

const EVENT_HEADER = ['id', 'review_request_id', 'event_type', 'user_agent', 'ip_hash', 'referrer', 'created_at'];

const EVENT_TYPES = new Set([
  'page_opened', 'google_clicked', 'facebook_clicked', 'apple_clicked', 'yelp_clicked', 'text_clicked', 'call_clicked',
]);

const EVENT_FIELD_MAP = {
  page_opened: { count: 'open_count', firstAt: 'opened_at', lastAt: 'last_opened_at' },
  google_clicked: { count: 'google_click_count', firstAt: 'google_clicked_at', lastAt: 'last_google_clicked_at' },
  facebook_clicked: { count: 'facebook_click_count', firstAt: 'facebook_clicked_at', lastAt: 'last_facebook_clicked_at' },
  apple_clicked: { count: 'apple_click_count', firstAt: 'apple_clicked_at', lastAt: 'last_apple_clicked_at' },
  yelp_clicked: { count: 'yelp_click_count', firstAt: 'yelp_clicked_at', lastAt: 'last_yelp_clicked_at' },
  text_clicked: { count: 'text_click_count', firstAt: 'text_clicked_at', lastAt: 'last_text_clicked_at' },
  call_clicked: { count: 'call_click_count', firstAt: 'call_clicked_at', lastAt: 'last_call_clicked_at' },
};

/** Review-link click event types (a subset of EVENT_TYPES). */
const CLICK_EVENT_TYPES = new Set(['google_clicked', 'facebook_clicked', 'apple_clicked', 'yelp_clicked']);

const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TOKEN_LEN = Math.min(24, Math.max(8, parseInt(process.env.REVIEW_TOKEN_LENGTH || '10', 10) || 10));

/** Any backend available? */
function isConfigured() {
  return pg.isEnabled() || db.isConfigured();
}

function nowIso() {
  return DateTime.now().setZone(TIMEZONE).toISO();
}

function genToken(len = TOKEN_LEN) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return s;
}

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

function newRecord(input, token) {
  const now = nowIso();
  return {
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
    slack_channel: '',
    slack_message_ts: '',
    approved_at: '',
    approved_by: '',
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
}

// ── Sheets helpers ────────────────────────────────────────────────────────────

async function sheetAll(force = false) {
  if (!db.isConfigured()) return [];
  try {
    return await db.readObjects(REQUESTS_TAB, REQUEST_HEADER, { force });
  } catch {
    return [];
  }
}

// ── Public API (Postgres first, Sheets fallback) ──────────────────────────────

async function createReviewRequest(input = {}) {
  if (pg.isEnabled()) {
    if (input.reviewOpportunityId) {
      const existing = await pg.findByOpportunityId(input.reviewOpportunityId);
      if (existing) return existing;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const rec = newRecord(input, genToken());
      try {
        await pg.createRequest(rec);
        return rec;
      } catch (err) {
        if (err && err.code === '23505') continue; // token collision → retry
        throw err;
      }
    }
    throw new Error('Could not generate a unique token.');
  }

  if (!db.isConfigured()) return null;
  if (input.reviewOpportunityId) {
    const existing = await findByOpportunityId(input.reviewOpportunityId);
    if (existing) return existing;
  }
  const rows = await sheetAll(true);
  const taken = new Set(rows.map((r) => r.token));
  let token = genToken();
  let guard = 0;
  while (taken.has(token) && guard++ < 20) token = genToken();
  const rec = newRecord(input, token);
  await db.appendObject(REQUESTS_TAB, REQUEST_HEADER, rec);
  return rec;
}

async function getByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (pg.isEnabled()) return pg.getByToken(t);
  const rows = await sheetAll();
  return rows.find((r) => r.token === t) || null;
}

async function findByOpportunityId(oid) {
  const id = String(oid || '').trim();
  if (!id) return null;
  if (pg.isEnabled()) return pg.findByOpportunityId(id);
  const rows = await sheetAll();
  return rows.find((r) => r.review_opportunity_id === id) || null;
}

async function getBySlackMessage(channel, ts) {
  if (!ts) return null;
  if (pg.isEnabled()) return pg.getBySlackMessage(channel, ts);
  const rows = await sheetAll();
  return rows.find((r) => r.slack_message_ts === ts && (!channel || r.slack_channel === channel)) || null;
}

async function setSlackMessage(id, channel, ts) {
  if (pg.isEnabled()) {
    await pg.setSlackMessage(id, channel, ts);
    return true;
  }
  if (!db.isConfigured()) return false;
  const rows = await sheetAll(true);
  const r = rows.find((x) => x.id === id || x.token === id);
  if (!r || !r._row) return false;
  await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, r._row, {
    ...r,
    slack_channel: channel,
    slack_message_ts: ts,
    updated_at: nowIso(),
  });
  return true;
}

async function recordEvent(token, eventType, meta = {}) {
  if (!EVENT_TYPES.has(eventType)) return null;
  if (pg.isEnabled()) {
    try {
      return await pg.recordEvent(token, eventType, meta);
    } catch {
      return getByToken(token);
    }
  }

  const req = await getByToken(token);
  if (!req) return null;
  if (!db.isConfigured()) return req;

  const now = nowIso();
  const map = EVENT_FIELD_MAP[eventType];
  const updated = { ...req };
  updated[map.count] = toInt(req[map.count]) + 1;
  if (!req[map.firstAt]) updated[map.firstAt] = now;
  updated[map.lastAt] = now;
  updated.updated_at = now;
  if (eventType === 'page_opened' && ['created', 'sent', 'approved'].includes(req.status)) updated.status = 'opened';
  else if (CLICK_EVENT_TYPES.has(eventType)) updated.status = eventType;

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
    /* best-effort */
  }
  return updated;
}

/** Atomically claim a request for sending (returns null if already sent or cancelled). */
async function approveForSend(idOrToken, approvedBy) {
  if (pg.isEnabled()) return pg.approveForSend(idOrToken, approvedBy);
  if (!db.isConfigured()) return null;
  const rows = await sheetAll(true);
  const r = rows.find((x) => x.id === idOrToken || x.token === idOrToken);
  if (!r || !r._row || r.sent_at || r.status === 'cancelled') return null;
  const now = nowIso();
  await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, r._row, {
    ...r,
    status: 'approved',
    approved_at: r.approved_at || now,
    approved_by: r.approved_by || approvedBy || '',
    updated_at: now,
  });
  return { ...r, status: 'approved' };
}

/**
 * Cancel an un-sent request so it can no longer be triggered — from the
 * dashboard Send button or a Slack approval. Returns null if it's already been
 * sent, already cancelled, or not found.
 */
async function cancelRequest(idOrToken) {
  if (pg.isEnabled()) return pg.cancelRequest(idOrToken);
  if (!db.isConfigured()) return null;
  const rows = await sheetAll(true);
  const r = rows.find((x) => x.id === idOrToken || x.token === idOrToken);
  if (!r || !r._row || r.sent_at || r.status === 'cancelled') return null;
  const now = nowIso();
  await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, r._row, {
    ...r,
    status: 'cancelled',
    updated_at: now,
  });
  return { ...r, status: 'cancelled' };
}

async function markSent(idOrToken, destination) {
  if (pg.isEnabled()) return Boolean(await pg.markSent(idOrToken, destination));
  if (!db.isConfigured()) return false;
  const rows = await sheetAll(true);
  const r = rows.find((x) => x.id === idOrToken || x.token === idOrToken);
  if (!r || !r._row) return false;
  const now = nowIso();
  await db.updateObjectRow(REQUESTS_TAB, REQUEST_HEADER, r._row, {
    ...r,
    status: 'sent',
    sent_at: r.sent_at || now,
    review_destination: destination || r.review_destination || '',
    updated_at: now,
  });
  return true;
}

async function listRequests() {
  if (pg.isEnabled()) return pg.listRequests();
  const rows = await sheetAll(true);
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function aggregate() {
  if (pg.isEnabled()) return pg.aggregate();
  const rows = await sheetAll(true);
  const sum = (k) => rows.reduce((s, r) => s + toInt(r[k]), 0);
  const totalOpens = sum('open_count');
  const googleClicks = sum('google_click_count');
  const textClicks = sum('text_click_count');
  const callClicks = sum('call_click_count');
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    totalRequests: rows.length,
    totalSent: rows.filter((r) => r.sent_at || ['sent', 'opened', 'google_clicked'].includes(r.status)).length,
    totalOpens,
    uniqueOpens: rows.filter((r) => toInt(r.open_count) > 0).length,
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
  getBySlackMessage,
  setSlackMessage,
  recordEvent,
  approveForSend,
  cancelRequest,
  markSent,
  listRequests,
  aggregate,
};
