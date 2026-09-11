const { Pool } = require('pg');

/**
 * Postgres backend for the review system (firm_settings, review_requests,
 * review_request_events). Enabled whenever DATABASE_URL is set — e.g. a Railway
 * Postgres plugin. More robust than Sheets for concurrent click counters
 * (atomic increments) and growing analytics data.
 *
 * When DATABASE_URL is not set, isEnabled() is false and callers fall back to
 * the Google Sheets backend, so nothing here is required to run the app.
 */

let pool = null;
let schemaReady = null;

function isEnabled() {
  return Boolean((process.env.DATABASE_URL || '').trim());
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString || '');
  const sslDisabled = ['0', 'false', 'disable'].includes(
    String(process.env.PG_SSL || '').trim().toLowerCase()
  );
  pool = new Pool({
    connectionString,
    ssl: local || sslDisabled ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.PG_POOL_MAX || '5', 10) || 5,
  });
  return pool;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS firm_settings (
  id text PRIMARY KEY,
  firm_name text,
  review_domain text,
  google_review_url text,
  call_phone_number text,
  text_phone_number text,
  review_page_settings_json text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
-- Per-firm reporting config (added incrementally; ADD COLUMN IF NOT EXISTS is a
-- safe self-migration on existing databases).
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS quo_api_key text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS quo_phone_numbers text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS quo_send_from text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS email_from text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS report_email_to text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS missed_calls_email_to text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS weekly_email_to text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS monthly_email_to text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS slack_bot_token text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS slack_channel text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS review_slack_channel text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_range text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS case_roster_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS case_roster_range text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS weekly_sentiment_sheet_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS weekly_sentiment_range text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS negative_sentiment_sheet_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS negative_sentiment_range text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS latest_sentiment_sheet_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS latest_sentiment_range text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS review_sheet_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS review_opportunities_sheet_id text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS facebook_review_url text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS apple_review_url text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS yelp_review_url text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_name_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_phone_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_status_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS sheets_consult_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS case_roster_case_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS case_roster_attorney_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS case_roster_paralegal_col text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_email_to text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_exclude_inboxes text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_include_users text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_missed_goal text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_transfer_inboxes text;
ALTER TABLE firm_settings ADD COLUMN IF NOT EXISTS stats_ignore_incoming_inboxes text;
CREATE TABLE IF NOT EXISTS review_requests (
  id uuid PRIMARY KEY,
  token text UNIQUE NOT NULL,
  firm_id text,
  case_id text,
  client_id text,
  client_first_name text,
  client_name text,
  client_phone text,
  status text DEFAULT 'created',
  source text,
  review_opportunity_id text,
  slack_channel text,
  slack_message_ts text,
  approved_at timestamptz,
  approved_by text,
  sent_at timestamptz,
  opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer DEFAULT 0,
  google_clicked_at timestamptz,
  last_google_clicked_at timestamptz,
  google_click_count integer DEFAULT 0,
  text_clicked_at timestamptz,
  last_text_clicked_at timestamptz,
  text_click_count integer DEFAULT 0,
  call_clicked_at timestamptz,
  last_call_clicked_at timestamptz,
  call_click_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
-- Per-platform review-link click tracking + which destination was sent
-- (self-migration for existing databases; new columns only).
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS facebook_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS last_facebook_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS facebook_click_count integer DEFAULT 0;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS apple_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS last_apple_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS apple_click_count integer DEFAULT 0;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS yelp_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS last_yelp_clicked_at timestamptz;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS yelp_click_count integer DEFAULT 0;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS review_destination text;
CREATE INDEX IF NOT EXISTS idx_review_requests_token ON review_requests (token);
CREATE INDEX IF NOT EXISTS idx_review_requests_slackts ON review_requests (slack_message_ts);
CREATE INDEX IF NOT EXISTS idx_review_requests_opp ON review_requests (review_opportunity_id);

-- Quo webhook ledger: one row per (call, line). Later events (answered /
-- forwarded / completed) merge into the same row so Yesterday Call Stats can
-- read a complete day without paging /v1/calls.
CREATE TABLE IF NOT EXISTS quo_calls (
  call_id text NOT NULL,
  phone_number_id text NOT NULL DEFAULT '',
  firm_id text,
  org_id text,
  conversation_id text,
  direction text,
  status text,
  user_id text,
  answered_by text,
  initiated_by text,
  duration_sec integer,
  created_at timestamptz,
  answered_at timestamptz,
  completed_at timestamptz,
  forwarded_from text,
  forwarded_to text,
  ai_handled boolean DEFAULT false,
  has_voicemail boolean DEFAULT false,
  participants jsonb,
  line_name text,
  last_event_type text,
  payload_json jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (call_id, phone_number_id)
);
CREATE INDEX IF NOT EXISTS idx_quo_calls_created ON quo_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_quo_calls_phone_created ON quo_calls (phone_number_id, created_at);

CREATE TABLE IF NOT EXISTS quo_messages (
  message_id text PRIMARY KEY,
  phone_number_id text,
  firm_id text,
  direction text,
  status text,
  user_id text,
  created_at timestamptz,
  payload_json jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quo_messages_created ON quo_messages (created_at);

CREATE TABLE IF NOT EXISTS quo_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_type text,
  received_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quo_webhook_endpoints (
  id text PRIMARY KEY,
  url text,
  signing_key text,
  events text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_request_events (
  id uuid PRIMARY KEY,
  review_request_id uuid,
  event_type text,
  user_agent text,
  ip_hash text,
  referrer text,
  created_at timestamptz DEFAULT now()
);
`;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(CREATE_SQL).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

/** Normalize a row: Date → ISO string, null → '' (parity with the Sheets backend). */
function mapRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v == null) out[k] = '';
    else out[k] = v;
  }
  return out;
}

// ── firm_settings ─────────────────────────────────────────────────────────────

async function loadFirms() {
  const { rows } = await query('SELECT * FROM firm_settings ORDER BY created_at ASC');
  return rows.map(mapRow);
}

/**
 * Columns an upsert may set, beyond id/created_at/updated_at. On UPDATE we
 * COALESCE(EXCLUDED, existing) so the contract is:
 *   undefined/null → keep the stored value (used to preserve secrets left blank)
 *   '' → clear the field
 *   value → set it
 */
const FIRM_UPSERT_COLUMNS = [
  'firm_name', 'review_domain', 'google_review_url', 'call_phone_number',
  'text_phone_number', 'review_page_settings_json',
  'quo_api_key', 'quo_phone_numbers', 'quo_send_from',
  'email_from', 'report_email_to', 'missed_calls_email_to', 'weekly_email_to', 'monthly_email_to',
  'slack_bot_token', 'slack_channel', 'review_slack_channel',
  'sheets_id', 'sheets_range', 'case_roster_id', 'case_roster_range',
  'weekly_sentiment_sheet_id', 'weekly_sentiment_range',
  'negative_sentiment_sheet_id', 'negative_sentiment_range',
  'latest_sentiment_sheet_id', 'latest_sentiment_range',
  'review_sheet_id', 'review_opportunities_sheet_id',
  'facebook_review_url', 'apple_review_url', 'yelp_review_url',
  'sheets_name_col', 'sheets_phone_col', 'sheets_status_col', 'sheets_consult_col',
  'case_roster_case_col', 'case_roster_attorney_col', 'case_roster_paralegal_col',
  'active',
  'stats_email_to', 'stats_exclude_inboxes', 'stats_include_users', 'stats_missed_goal',
  'stats_transfer_inboxes', 'stats_ignore_incoming_inboxes',
];

async function upsertFirm(f) {
  // id = $1, created_at = $2, then one param per FIRM_UPSERT_COLUMNS.
  const cols = FIRM_UPSERT_COLUMNS;
  const values = [f.id, f.created_at || null, ...cols.map((c) => (f[c] === undefined ? null : f[c]))];
  const insertCols = ['id', 'created_at', ...cols, 'updated_at'];
  const insertPlaceholders = ['$1', 'COALESCE($2, now())', ...cols.map((_, i) => `$${i + 3}`), 'now()'];
  const updates = cols.map((c) => `${c}=COALESCE(EXCLUDED.${c}, firm_settings.${c})`).concat('updated_at=now()');
  await query(
    `INSERT INTO firm_settings (${insertCols.join(', ')})
     VALUES (${insertPlaceholders.join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}`,
    values
  );
  return true;
}

async function deleteFirm(id) {
  const { rowCount } = await query('DELETE FROM firm_settings WHERE id=$1', [String(id)]);
  return rowCount > 0;
}

// ── review_requests ─────────────────────────────────────────────────────────

async function createRequest(rec) {
  await query(
    `INSERT INTO review_requests
       (id, token, firm_id, case_id, client_id, client_first_name, client_name,
        client_phone, status, source, review_opportunity_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      rec.id,
      rec.token,
      rec.firm_id || '',
      rec.case_id || '',
      rec.client_id || '',
      rec.client_first_name || '',
      rec.client_name || '',
      rec.client_phone || '',
      rec.status || 'created',
      rec.source || '',
      rec.review_opportunity_id || '',
      rec.sent_at || null,
    ]
  );
}

async function getByToken(token) {
  const { rows } = await query('SELECT * FROM review_requests WHERE token=$1 LIMIT 1', [token]);
  return rows[0] ? mapRow(rows[0]) : null;
}

async function findByOpportunityId(oid) {
  const { rows } = await query(
    'SELECT * FROM review_requests WHERE review_opportunity_id=$1 ORDER BY created_at ASC LIMIT 1',
    [oid]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function getBySlackMessage(channel, ts) {
  const { rows } = await query(
    'SELECT * FROM review_requests WHERE slack_channel=$1 AND slack_message_ts=$2 LIMIT 1',
    [channel, ts]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function setSlackMessage(id, channel, ts) {
  await query('UPDATE review_requests SET slack_channel=$2, slack_message_ts=$3, updated_at=now() WHERE id=$1', [
    id,
    channel,
    ts,
  ]);
}

const EVENT_COLS = {
  page_opened: ['open_count', 'opened_at', 'last_opened_at'],
  google_clicked: ['google_click_count', 'google_clicked_at', 'last_google_clicked_at'],
  facebook_clicked: ['facebook_click_count', 'facebook_clicked_at', 'last_facebook_clicked_at'],
  apple_clicked: ['apple_click_count', 'apple_clicked_at', 'last_apple_clicked_at'],
  yelp_clicked: ['yelp_click_count', 'yelp_clicked_at', 'last_yelp_clicked_at'],
  text_clicked: ['text_click_count', 'text_clicked_at', 'last_text_clicked_at'],
  call_clicked: ['call_click_count', 'call_clicked_at', 'last_call_clicked_at'],
};

async function recordEvent(token, eventType, meta = {}) {
  const cols = EVENT_COLS[eventType];
  if (!cols) return null;
  const [countCol, firstCol, lastCol] = cols;
  const { rows } = await query(
    `UPDATE review_requests SET
       ${countCol} = ${countCol} + 1,
       ${firstCol} = COALESCE(${firstCol}, now()),
       ${lastCol} = now(),
       status = CASE
         WHEN $2 = 'page_opened' AND status IN ('created','sent','approved') THEN 'opened'
         WHEN $2 IN ('google_clicked','facebook_clicked','apple_clicked','yelp_clicked') THEN $2
         ELSE status END,
       updated_at = now()
     WHERE token = $1
     RETURNING *`,
    [token, eventType]
  );
  if (!rows[0]) return null;
  await query(
    `INSERT INTO review_request_events (id, review_request_id, event_type, user_agent, ip_hash, referrer)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [rows[0].id, eventType, String(meta.userAgent || '').slice(0, 400), meta.ipHash || '', String(meta.referrer || '').slice(0, 400)]
  ).catch(() => {});
  return mapRow(rows[0]);
}

/** Atomically claim the request for sending (only if not already sent or cancelled). */
async function approveForSend(idOrToken, approvedBy) {
  const { rows } = await query(
    `UPDATE review_requests
       SET status='approved', approved_at=COALESCE(approved_at, now()), approved_by=COALESCE(approved_by,$2), updated_at=now()
     WHERE (id::text=$1 OR token=$1) AND sent_at IS NULL AND status <> 'cancelled'
     RETURNING *`,
    [String(idOrToken), approvedBy || '']
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Cancel an un-sent request so it can no longer be triggered (dashboard or Slack). */
async function cancelRequest(idOrToken) {
  const { rows } = await query(
    `UPDATE review_requests
       SET status='cancelled', updated_at=now()
     WHERE (id::text=$1 OR token=$1) AND sent_at IS NULL AND status <> 'cancelled'
     RETURNING *`,
    [String(idOrToken)]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function markSent(idOrToken, destination) {
  const { rows } = await query(
    `UPDATE review_requests
       SET status='sent', sent_at=COALESCE(sent_at, now()),
           review_destination=COALESCE($2, review_destination), updated_at=now()
     WHERE id::text=$1 OR token=$1
     RETURNING *`,
    [String(idOrToken), destination || null]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function listRequests() {
  const { rows } = await query('SELECT * FROM review_requests ORDER BY created_at DESC');
  return rows.map(mapRow);
}

async function aggregate() {
  const { rows } = await query(`
    SELECT
      count(*)::int AS total_requests,
      count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS total_sent,
      COALESCE(sum(open_count),0)::int AS total_opens,
      count(*) FILTER (WHERE open_count > 0)::int AS unique_opens,
      COALESCE(sum(google_click_count),0)::int AS google_clicks,
      COALESCE(sum(text_click_count),0)::int AS text_clicks,
      COALESCE(sum(call_click_count),0)::int AS call_clicks
    FROM review_requests`);
  const r = rows[0] || {};
  const opens = Number(r.total_opens) || 0;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  const g = Number(r.google_clicks) || 0;
  const t = Number(r.text_clicks) || 0;
  const c = Number(r.call_clicks) || 0;
  return {
    totalRequests: Number(r.total_requests) || 0,
    totalSent: Number(r.total_sent) || 0,
    totalOpens: opens,
    uniqueOpens: Number(r.unique_opens) || 0,
    googleClicks: g,
    textClicks: t,
    callClicks: c,
    googleCtr: pct(g, opens),
    supportClickRate: pct(t + c, opens),
  };
}

function emptyToNull(v) {
  if (v === undefined || v === null || v === '') return null;
  return v;
}

async function recordWebhookDelivery(deliveryId, eventType) {
  if (!deliveryId) return false;
  const { rowCount } = await query(
    `INSERT INTO quo_webhook_deliveries (delivery_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [deliveryId, eventType || '']
  );
  return rowCount > 0;
}

async function upsertQuoCall(row) {
  const callId = String(row.call_id || '').trim();
  if (!callId) return false;
  const phoneNumberId = String(row.phone_number_id || '');
  await query(
    `INSERT INTO quo_calls (
       call_id, phone_number_id, firm_id, org_id, conversation_id, direction, status,
       user_id, answered_by, initiated_by, duration_sec, created_at, answered_at, completed_at,
       forwarded_from, forwarded_to, ai_handled, has_voicemail, participants, line_name,
       last_event_type, payload_json, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22::jsonb,now()
     )
     ON CONFLICT (call_id, phone_number_id) DO UPDATE SET
       firm_id = COALESCE(NULLIF(EXCLUDED.firm_id, ''), quo_calls.firm_id),
       org_id = COALESCE(NULLIF(EXCLUDED.org_id, ''), quo_calls.org_id),
       conversation_id = COALESCE(NULLIF(EXCLUDED.conversation_id, ''), quo_calls.conversation_id),
       direction = COALESCE(NULLIF(EXCLUDED.direction, ''), quo_calls.direction),
       status = COALESCE(NULLIF(EXCLUDED.status, ''), quo_calls.status),
       user_id = COALESCE(NULLIF(EXCLUDED.user_id, ''), quo_calls.user_id),
       answered_by = COALESCE(NULLIF(EXCLUDED.answered_by, ''), quo_calls.answered_by),
       initiated_by = COALESCE(NULLIF(EXCLUDED.initiated_by, ''), quo_calls.initiated_by),
       duration_sec = COALESCE(EXCLUDED.duration_sec, quo_calls.duration_sec),
       created_at = COALESCE(EXCLUDED.created_at, quo_calls.created_at),
       answered_at = COALESCE(EXCLUDED.answered_at, quo_calls.answered_at),
       completed_at = COALESCE(EXCLUDED.completed_at, quo_calls.completed_at),
       forwarded_from = COALESCE(NULLIF(EXCLUDED.forwarded_from, ''), quo_calls.forwarded_from),
       forwarded_to = COALESCE(NULLIF(EXCLUDED.forwarded_to, ''), quo_calls.forwarded_to),
       ai_handled = quo_calls.ai_handled OR EXCLUDED.ai_handled,
       has_voicemail = quo_calls.has_voicemail OR EXCLUDED.has_voicemail,
       participants = COALESCE(EXCLUDED.participants, quo_calls.participants),
       line_name = COALESCE(NULLIF(EXCLUDED.line_name, ''), quo_calls.line_name),
       last_event_type = COALESCE(NULLIF(EXCLUDED.last_event_type, ''), quo_calls.last_event_type),
       payload_json = COALESCE(EXCLUDED.payload_json, quo_calls.payload_json),
       updated_at = now()`,
    [
      callId,
      phoneNumberId,
      emptyToNull(row.firm_id),
      emptyToNull(row.org_id),
      emptyToNull(row.conversation_id),
      emptyToNull(row.direction),
      emptyToNull(row.status),
      emptyToNull(row.user_id),
      emptyToNull(row.answered_by),
      emptyToNull(row.initiated_by),
      row.duration_sec == null || row.duration_sec === '' ? null : Number(row.duration_sec),
      emptyToNull(row.created_at),
      emptyToNull(row.answered_at),
      emptyToNull(row.completed_at),
      emptyToNull(row.forwarded_from),
      emptyToNull(row.forwarded_to),
      Boolean(row.ai_handled),
      Boolean(row.has_voicemail),
      row.participants == null ? null : JSON.stringify(row.participants),
      emptyToNull(row.line_name),
      emptyToNull(row.last_event_type),
      row.payload_json == null ? null : JSON.stringify(row.payload_json),
    ]
  );
  return true;
}

async function upsertQuoMessage(row) {
  const messageId = String(row.message_id || '').trim();
  if (!messageId) return false;
  await query(
    `INSERT INTO quo_messages (
       message_id, phone_number_id, firm_id, direction, status, user_id, created_at, payload_json, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
     ON CONFLICT (message_id) DO UPDATE SET
       phone_number_id = COALESCE(NULLIF(EXCLUDED.phone_number_id, ''), quo_messages.phone_number_id),
       direction = COALESCE(NULLIF(EXCLUDED.direction, ''), quo_messages.direction),
       status = COALESCE(NULLIF(EXCLUDED.status, ''), quo_messages.status),
       user_id = COALESCE(NULLIF(EXCLUDED.user_id, ''), quo_messages.user_id),
       created_at = COALESCE(EXCLUDED.created_at, quo_messages.created_at),
       payload_json = COALESCE(EXCLUDED.payload_json, quo_messages.payload_json),
       updated_at = now()`,
    [
      messageId,
      emptyToNull(row.phone_number_id),
      emptyToNull(row.firm_id),
      emptyToNull(row.direction),
      emptyToNull(row.status),
      emptyToNull(row.user_id),
      emptyToNull(row.created_at),
      row.payload_json == null ? null : JSON.stringify(row.payload_json),
    ]
  );
  return true;
}

async function listQuoCallsInWindow(createdAfter, createdBefore) {
  const { rows } = await query(
    `SELECT * FROM quo_calls
     WHERE created_at >= $1 AND created_at < $2
     ORDER BY created_at ASC`,
    [createdAfter, createdBefore]
  );
  return rows;
}

async function listQuoMessagesInWindow(createdAfter, createdBefore) {
  const { rows } = await query(
    `SELECT * FROM quo_messages
     WHERE created_at >= $1 AND created_at < $2
     ORDER BY created_at ASC`,
    [createdAfter, createdBefore]
  );
  return rows;
}

async function saveWebhookEndpoint(ep) {
  if (!ep?.id) return false;
  await query(
    `INSERT INTO quo_webhook_endpoints (id, url, signing_key, events, created_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (id) DO UPDATE SET
       url = EXCLUDED.url,
       signing_key = COALESCE(NULLIF(EXCLUDED.signing_key, ''), quo_webhook_endpoints.signing_key),
       events = COALESCE(EXCLUDED.events, quo_webhook_endpoints.events)`,
    [ep.id, ep.url || '', ep.signing_key || '', ep.events || '']
  );
  return true;
}

async function listWebhookSigningKeys() {
  const { rows } = await query('SELECT signing_key FROM quo_webhook_endpoints WHERE signing_key IS NOT NULL AND signing_key <> \'\'');
  return rows.map((r) => r.signing_key).filter(Boolean);
}

async function findWebhookEndpointByUrl(url) {
  if (!url) return null;
  const { rows } = await query('SELECT * FROM quo_webhook_endpoints WHERE url=$1 LIMIT 1', [url]);
  return rows[0] || null;
}

async function countQuoCalls() {
  const { rows } = await query('SELECT count(*)::int AS n FROM quo_calls');
  return Number(rows[0]?.n) || 0;
}

module.exports = {
  isEnabled,
  ensureSchema,
  query,
  loadFirms,
  upsertFirm,
  deleteFirm,
  createRequest,
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
  recordWebhookDelivery,
  upsertQuoCall,
  upsertQuoMessage,
  listQuoCallsInWindow,
  listQuoMessagesInWindow,
  saveWebhookEndpoint,
  listWebhookSigningKeys,
  findWebhookEndpointByUrl,
  countQuoCalls,
};
