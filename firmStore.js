const { DateTime } = require('luxon');
const db = require('./reviewDb');
const pg = require('./pgStore');
const {
  DEFAULT_CONFIG,
  loadReviewLandingConfig,
  saveReviewLandingConfig,
} = require('./reviewLanding');

/**
 * firm_settings — per-firm review configuration (branding domain, Google review
 * URL, support phone numbers, and the review-page copy/colors as a JSON blob).
 *
 * V1 has a single firm (Ramos James) but the table is keyed by firm so more
 * firms/domains can be added later. The review page is resolved by Host header,
 * so reviews.ramosjames.com renders this firm's branding.
 *
 * Columns:
 *   id | firm_name | review_domain | google_review_url | call_phone_number |
 *   text_phone_number | review_page_settings_json | created_at | updated_at
 */

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Ramos James Law, PLLC';
const DEFAULT_FIRM_ID = process.env.REVIEW_DEFAULT_FIRM_ID || 'ramos-james';

const HEADER = [
  'id',
  'firm_name',
  'review_domain',
  'google_review_url',
  'call_phone_number',
  'text_phone_number',
  'review_page_settings_json',
  'created_at',
  'updated_at',
];
const TAB = process.env.GOOGLE_FIRM_SETTINGS_TAB || 'firm_settings';

function nowIso() {
  return DateTime.now().setZone(TIMEZONE).toISO();
}

function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

/** Landing-config keys that live in the JSON blob (everything the editor edits). */
const LANDING_KEYS = Object.keys(DEFAULT_CONFIG);

/**
 * Effective landing config for a firm row: file/env defaults ← stored JSON,
 * with the discrete firm columns (Google URL, phone numbers) taking precedence.
 */
function landingConfigForFirm(firm) {
  const base = loadReviewLandingConfig(); // defaults ← review-landing.json ← env
  let stored = {};
  try {
    stored = firm && firm.review_page_settings_json ? JSON.parse(firm.review_page_settings_json) : {};
  } catch {
    stored = {};
  }
  const cfg = { ...base };
  for (const k of LANDING_KEYS) {
    if (stored[k] !== undefined && stored[k] !== null) cfg[k] = stored[k];
  }
  // Firm name for the page's social/link-preview title (not a persisted setting).
  cfg.firmName = (firm && firm.firm_name) || COMPANY_NAME;
  if (firm) {
    if (firm.google_review_url) cfg.googleReviewUrl = firm.google_review_url;
    if (firm.facebook_review_url) cfg.facebookReviewUrl = firm.facebook_review_url;
    if (firm.apple_review_url) cfg.appleReviewUrl = firm.apple_review_url;
    if (firm.yelp_review_url) cfg.yelpReviewUrl = firm.yelp_review_url;
    if (firm.call_phone_number) cfg.callNumber = firm.call_phone_number;
    if (firm.text_phone_number) cfg.textNumber = firm.text_phone_number;
  }
  return cfg;
}

function parseList(v) {
  return String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
}

function isValidEmailAddress(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return false;
  const domain = s.slice(at + 1);
  if (!domain || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false;
  if (!/^[A-Z0-9](?:[A-Z0-9\-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9\-]*[A-Z0-9])?)+$/i.test(domain)) return false;
  return true;
}

/**
 * Pull actual email addresses out of a paste. Invalid tokens (no TLD, `..` in
 * the domain, etc.) are dropped — Gmail rejects the whole send as
 * "Invalid To header" if any To address is malformed.
 */
function parseEmailList(v) {
  const raw = String(v == null ? '' : v);
  const emails = [];
  const seen = new Set();
  const parts = raw.split(/[,;\n\r]+/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const angle = part.match(/<([^>]+)>/);
    const candidate = (angle ? angle[1] : part).trim().replace(/^mailto:/i, '');
    const loose = ((candidate.match(/[A-Z0-9._%+\-]+@[^\s>]+/i) || [])[0] || '').replace(/[.,;:]+$/g, '');
    if (loose && isValidEmailAddress(loose)) {
      const key = loose.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(loose);
      continue;
    }
    if (part.includes('@')) {
      console.warn(`  Skipping invalid email address: ${part}`);
    }
  }
  return emails;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

/** Parse the first non-empty comma-list among the candidates into an array. */
function firstList(...vals) {
  return parseList(firstNonEmpty(...vals));
}

function firstEmailList(...vals) {
  return parseEmailList(firstNonEmpty(...vals));
}

/** Quo dashboard inboxes that stay in the report (everything else is dropped). */
const DEFAULT_STATS_EXCLUDE = 'Extra Number,SA Law Firm,Trucking Chicas,RJL Outbound';
const LEGACY_STATS_EXCLUDE = new Set(
  ['RJL Transfers', 'Extra Number', 'SA Law Firm', 'Trucking Chicas', 'RJL Outbound'].map((s) => s.toLowerCase())
);

function statsExcludeInboxesFrom(firmVal, envVal) {
  const raw = firstNonEmpty(firmVal, envVal);
  if (!raw) return parseList(DEFAULT_STATS_EXCLUDE);
  const list = parseList(raw);
  const lower = list.map((s) => s.toLowerCase());
  // Old canned default kept Transfers off; the Quo dashboard now includes it.
  const isLegacyDefault =
    lower.includes('rjl transfers') &&
    lower.every((s) => LEGACY_STATS_EXCLUDE.has(s)) &&
    lower.length <= LEGACY_STATS_EXCLUDE.size;
  if (isLegacyDefault) return parseList(DEFAULT_STATS_EXCLUDE);
  return list;
}

/** Morning send time from CALL_STATS_CRON (`30 7 * * *` → 7:30), else 7:30. */
function morningTimeFromCron() {
  const parts = String(process.env.CALL_STATS_CRON || '').trim().split(/\s+/);
  if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return `${Number(parts[1])}:${String(Number(parts[0])).padStart(2, '0')}`;
  }
  return '7:30';
}

/**
 * Parse a clock time from settings (`7:30`, `13:00`, `1:00 PM`, `1pm`).
 * @returns {{ hour: number, minute: number } | null}
 */
function parseClockTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2] || '0', 10);
    const ap = m[3].toLowerCase();
    if (hour === 12) hour = 0;
    if (ap === 'pm') hour += 12;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

function clockToHm(clock) {
  if (!clock) return '';
  return `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

function clockLabel(clock) {
  if (!clock) return '';
  return DateTime.fromObject({ hour: clock.hour, minute: clock.minute }).toFormat('h:mm a');
}

function resolveClockTime(raw, fallbackRaw) {
  return parseClockTime(raw) || parseClockTime(fallbackRaw) || { hour: 7, minute: 30 };
}

function parseMissedGoal(raw, fallback = 10) {
  const s = String(raw == null ? '' : raw).replace(/%/g, '').trim();
  if (s === '') return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const CALL_STATS_SLOTS = [
  {
    id: 'morning',
    label: 'Morning (prior day)',
    defaultTime: morningTimeFromCron(),
    emailField: 'statsEmailTo',
    timeField: 'statsMorningTime',
    goalField: 'statsMissedGoal',
    window: 'prior_day',
  },
  {
    id: 'midday',
    label: 'Midday (today so far)',
    defaultTime: '13:00',
    emailField: 'statsMiddayEmailTo',
    timeField: 'statsMiddayTime',
    goalField: 'statsMissedGoalMidday',
    window: 'today_so_far',
  },
  {
    id: 'afternoon',
    label: 'Afternoon (today so far)',
    defaultTime: '17:00',
    emailField: 'statsAfternoonEmailTo',
    timeField: 'statsAfternoonTime',
    goalField: 'statsMissedGoalAfternoon',
    window: 'today_so_far',
  },
];

function callStatsSlot(slotId) {
  return CALL_STATS_SLOTS.find((s) => s.id === slotId) || CALL_STATS_SLOTS[0];
}

function callStatsSlotClock(ctx, slotId) {
  const slot = callStatsSlot(slotId);
  return resolveClockTime(ctx && ctx[slot.timeField], slot.defaultTime);
}

function callStatsSlotRecipients(ctx, slotId) {
  const slot = callStatsSlot(slotId);
  const list = ctx && ctx[slot.emailField];
  return Array.isArray(list) ? list : [];
}

const SLOT_EMAIL_SOURCE = {
  statsEmailTo: ['stats_email_to', 'STATS_EMAIL_TO'],
  statsMiddayEmailTo: ['stats_midday_email_to', 'STATS_MIDDAY_EMAIL_TO'],
  statsAfternoonEmailTo: ['stats_afternoon_email_to', 'STATS_AFTERNOON_EMAIL_TO'],
};

/** Unparsed recipient field for a slot (firm column, then env). */
function callStatsSlotRawRecipientText(firm, slotId) {
  const slot = callStatsSlot(slotId);
  const src = SLOT_EMAIL_SOURCE[slot.emailField];
  if (!src) return '';
  return firstNonEmpty(firm && firm[src[0]], process.env[src[1]]);
}

function callStatsSlotGoal(ctx, slotId) {
  const slot = callStatsSlot(slotId);
  const n = ctx && ctx[slot.goalField];
  if (Number.isFinite(Number(n)) && Number(n) >= 0) return Number(n);
  return Number(ctx && ctx.statsMissedGoal) || 10;
}

/**
 * Normalized per-firm reporting context used by the jobs. Every field falls
 * back to the matching env constant when the firm column is blank, so a
 * single-firm / env-only deployment behaves exactly as it does today. The
 * Google OAuth (refresh token) is shared and read globally — only the target
 * spreadsheet IDs vary per firm.
 */
function reportConfigForFirm(firm) {
  const f = firm || {};
  const env = process.env;
  const missedGoal = parseMissedGoal(firstNonEmpty(f.stats_missed_goal, env.STATS_MISSED_GOAL, '10'));
  return {
    id: f.id || DEFAULT_FIRM_ID,
    firmName: f.firm_name || COMPANY_NAME,
    synthetic: Boolean(f._synthetic),
    quoApiKey: firstNonEmpty(f.quo_api_key, env.QUO_API_KEY),
    quoPhoneNumbers: f.quo_phone_numbers ? parseList(f.quo_phone_numbers) : parseList(env.QUO_PHONE_NUMBERS),
    quoSendFrom: firstNonEmpty(f.quo_send_from, env.QUO_SEND_FROM),
    emailFrom: firstNonEmpty(f.email_from, env.EMAIL_FROM),
    // Default report recipients (also the daily-report list). Per-report-type
    // lists below fall back to this default, then to the env EMAIL_TO.
    emailTo: firstEmailList(f.report_email_to, env.EMAIL_TO),
    weeklyEmailTo: firstEmailList(f.weekly_email_to, f.report_email_to, env.EMAIL_TO),
    monthlyEmailTo: firstEmailList(f.monthly_email_to, f.report_email_to, env.EMAIL_TO),
    missedEmailTo: firstEmailList(f.missed_calls_email_to, env.MISSED_CLIENT_CALLS_EMAIL_TO, f.report_email_to, env.EMAIL_TO),
    slackBotToken: firstNonEmpty(f.slack_bot_token, env.SLACK_BOT_TOKEN),
    slackChannel: firstNonEmpty(f.slack_channel, env.SLACK_CHANNEL, 'lead-calls'),
    reviewSlackChannel: firstNonEmpty(f.review_slack_channel, env.REVIEW_SLACK_CHANNEL, 'review-opportunities'),
    // Yesterday Call Stats email — per-firm columns (set on /review/firms/edit),
    // env fallbacks, then built-in defaults. Recipients do NOT fall back to the
    // default report list (this email goes to a specific audience).
    statsEmailTo: firstEmailList(f.stats_email_to, env.STATS_EMAIL_TO),
    statsMiddayEmailTo: firstEmailList(f.stats_midday_email_to, env.STATS_MIDDAY_EMAIL_TO),
    statsAfternoonEmailTo: firstEmailList(f.stats_afternoon_email_to, env.STATS_AFTERNOON_EMAIL_TO),
    statsMorningTime: firstNonEmpty(f.stats_morning_time, env.STATS_MORNING_TIME, morningTimeFromCron()),
    statsMiddayTime: firstNonEmpty(f.stats_midday_time, env.STATS_MIDDAY_TIME, '1:00 PM'),
    statsAfternoonTime: firstNonEmpty(f.stats_afternoon_time, env.STATS_AFTERNOON_TIME, '5:00 PM'),
    statsMissedGoal: missedGoal,
    statsMissedGoalMidday: parseMissedGoal(firstNonEmpty(f.stats_missed_goal_midday, env.STATS_MISSED_GOAL_MIDDAY), missedGoal),
    statsMissedGoalAfternoon: parseMissedGoal(firstNonEmpty(f.stats_missed_goal_afternoon, env.STATS_MISSED_GOAL_AFTERNOON), missedGoal),
    // Lines dropped entirely. Default matches the Quo dashboard inbox filter
    // (Leads, RJL Main Line, RGV Number, RJL Transfers, Intake).
    statsExcludeInboxes: statsExcludeInboxesFrom(f.stats_exclude_inboxes, env.STATS_EXCLUDE_INBOXES),
    // Optional: lines counted toward who ANSWERED but not toward incoming
    // volume. Empty by default — move a line here (and out of the exclude list)
    // to credit staff for transferred calls without double-counting volume.
    statsTransferInboxes: firstList(f.stats_transfer_inboxes, env.STATS_TRANSFER_INBOXES),
    // Lines that auto-forward every inbound call elsewhere. Quo writes a second
    // record on the forwarding line AND the dashboard unchecks the line, so we
    // omit the whole line (inbound and outbound) from this email.
    statsIgnoreIncomingInboxes: firstList(f.stats_ignore_incoming_inboxes, env.STATS_IGNORE_INCOMING_INBOXES, 'RJL Outbound'),
    statsIncludeUsers: firstList(
      f.stats_include_users,
      env.STATS_INCLUDE_USERS,
      'Jissela Calix,Stephany Guerra,Liz Abad-Cruz,Intake Specialist,Valeria Flores,Valeria Chang'
    ),
    sheets: {
      sheetsId: firstNonEmpty(f.sheets_id, env.GOOGLE_SHEETS_ID),
      sheetsRange: firstNonEmpty(f.sheets_range, env.GOOGLE_SHEETS_RANGE),
      caseRosterId: firstNonEmpty(f.case_roster_id, env.GOOGLE_SHEETS_CASE_ROSTER_ID),
      caseRosterRange: firstNonEmpty(f.case_roster_range, env.GOOGLE_SHEETS_CASE_ROSTER_RANGE),
      weeklySentimentId: firstNonEmpty(f.weekly_sentiment_sheet_id, env.GOOGLE_WEEKLY_SENTIMENT_SHEET_ID),
      weeklySentimentRange: firstNonEmpty(f.weekly_sentiment_range, env.GOOGLE_WEEKLY_SENTIMENT_RANGE),
      negativeSentimentId: firstNonEmpty(f.negative_sentiment_sheet_id, env.GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_SHEET_ID),
      negativeSentimentRange: firstNonEmpty(f.negative_sentiment_range, env.GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_RANGE),
      latestSentimentId: firstNonEmpty(f.latest_sentiment_sheet_id, env.GOOGLE_LATEST_SENTIMENT_SHEET_ID),
      latestSentimentRange: firstNonEmpty(f.latest_sentiment_range, env.GOOGLE_LATEST_SENTIMENT_RANGE),
      reviewSheetId: firstNonEmpty(f.review_sheet_id, env.GOOGLE_REVIEW_SHEET_ID),
      reviewOpportunitiesSheetId: firstNonEmpty(f.review_opportunities_sheet_id, env.GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID),
      // Lead-sheet column layout (spreadsheet letters). Which columns hold the
      // client name/phone/status/consult so the reconciler reads the right cells.
      columns: {
        name: firstNonEmpty(f.sheets_name_col, env.GOOGLE_SHEETS_NAME_COL, 'E'),
        phone: firstNonEmpty(f.sheets_phone_col, env.GOOGLE_SHEETS_PHONE_COL, 'F'),
        status: firstNonEmpty(f.sheets_status_col, env.GOOGLE_SHEETS_STATUS_COL, 'K'),
        consult: firstNonEmpty(f.sheets_consult_col, env.GOOGLE_SHEETS_CONSULT_COL, 'L'),
      },
      rosterColumns: {
        caseNum: firstNonEmpty(f.case_roster_case_col, env.GOOGLE_SHEETS_CASE_ROSTER_CASE_COL, 'A'),
        attorney: firstNonEmpty(f.case_roster_attorney_col, env.GOOGLE_SHEETS_CASE_ROSTER_ATTORNEY_COL, 'C'),
        paralegal: firstNonEmpty(f.case_roster_paralegal_col, env.GOOGLE_SHEETS_CASE_ROSTER_PARALEGAL_COL, 'E'),
      },
    },
  };
}

/** A firm object synthesized from env + file config, used when Sheets isn't set. */
function syntheticDefaultFirm() {
  const cfg = loadReviewLandingConfig();
  return {
    id: DEFAULT_FIRM_ID,
    firm_name: COMPANY_NAME,
    review_domain: (process.env.REVIEW_DOMAIN || '').trim(),
    google_review_url: cfg.googleReviewUrl || '',
    call_phone_number: cfg.callNumber || '',
    text_phone_number: cfg.textNumber || '',
    review_page_settings_json: '',
    _synthetic: true,
  };
}

async function loadFirms() {
  if (pg.isEnabled()) {
    try {
      return await pg.loadFirms();
    } catch {
      return [];
    }
  }
  if (!db.isConfigured()) return [];
  try {
    return await db.readObjects(TAB, HEADER);
  } catch {
    return [];
  }
}

async function getDefaultFirm() {
  const firms = await loadFirms();
  if (!firms.length) return syntheticDefaultFirm();
  return firms.find((f) => f.id === DEFAULT_FIRM_ID) || firms[0];
}

/** Treat a firm as active unless `active` is explicitly false. */
function isFirmActive(f) {
  return f && f.active !== false && String(f.active).toLowerCase() !== 'false';
}

/**
 * Firms the scheduled jobs should run for. Falls back to a single synthetic
 * env-derived firm when none are stored (or no DB), preserving today's behavior.
 */
async function loadActiveFirms() {
  const firms = await loadFirms();
  const active = firms.filter(isFirmActive);
  return active.length ? active : [syntheticDefaultFirm()];
}

async function getFirmById(id) {
  if (!id) return null;
  const firms = await loadFirms();
  return firms.find((f) => f.id === id) || null;
}

/** Resolve the firm for an incoming Host header; default firm if none matches. */
async function getFirmByHost(host) {
  const h = normalizeHost(host);
  if (h) {
    const firms = await loadFirms();
    const hit = firms.find((f) => normalizeHost(f.review_domain) && normalizeHost(f.review_domain) === h);
    if (hit) return hit;
  }
  return getDefaultFirm();
}

/**
 * Returns the firm whose branded review_domain exactly matches this host, or
 * null (no default fallback). Used to detect that a request arrived on a firm's
 * branded review domain — those should serve the public review page, not admin.
 */
async function matchFirmByHost(host) {
  const h = normalizeHost(host);
  if (!h) return null;
  const firms = await loadFirms();
  const hit = firms.find((f) => normalizeHost(f.review_domain) && normalizeHost(f.review_domain) === h);
  if (hit) return hit;
  const envDomain = normalizeHost(process.env.REVIEW_DOMAIN || '');
  if (envDomain && envDomain === h) return await getDefaultFirm();
  return null;
}

/**
 * Durably save a firm's review-page settings from an editor patch. When neither
 * Postgres nor Sheets is configured, falls back to the review-landing.json file
 * (single-firm only). `firmId` defaults to the default firm.
 * @returns {Promise<{ ok: boolean, storage: string, error?: string }>}
 */
async function saveFirmPageSettings(firmId, patch) {
  if (!pg.isEnabled() && !db.isConfigured()) {
    const res = saveReviewLandingConfig(patch || {});
    return { ok: res.ok, storage: 'file', error: res.error };
  }

  const storage = pg.isEnabled() ? 'postgres' : 'sheet';
  try {
    const targetId = firmId || DEFAULT_FIRM_ID;
    const firms = await loadFirms();
    const existing = firms.find((f) => f.id === targetId)
      || (targetId === DEFAULT_FIRM_ID ? firms.find((f) => f.id === DEFAULT_FIRM_ID) || firms[0] : null);

    // Merge patch onto this firm's current effective config, then split into
    // discrete columns + the settings blob.
    const current = landingConfigForFirm(existing || (await getDefaultFirm()));
    const merged = { ...current };
    for (const [k, v] of Object.entries(patch || {})) {
      if (LANDING_KEYS.includes(k)) merged[k] = v;
    }
    const blob = {};
    for (const k of LANDING_KEYS) blob[k] = merged[k];

    const now = nowIso();
    const rowObj = {
      id: existing?.id || targetId,
      firm_name: existing?.firm_name || COMPANY_NAME,
      review_domain: existing?.review_domain || (targetId === DEFAULT_FIRM_ID ? (process.env.REVIEW_DOMAIN || '').trim() : ''),
      google_review_url: merged.googleReviewUrl || '',
      facebook_review_url: merged.facebookReviewUrl || '',
      apple_review_url: merged.appleReviewUrl || '',
      yelp_review_url: merged.yelpReviewUrl || '',
      call_phone_number: merged.callNumber || '',
      text_phone_number: merged.textNumber || '',
      review_page_settings_json: JSON.stringify(blob),
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    if (pg.isEnabled()) {
      await pg.upsertFirm(rowObj);
    } else if (existing && existing._row) {
      await db.updateObjectRow(TAB, HEADER, existing._row, rowObj);
    } else {
      await db.appendObject(TAB, HEADER, rowObj);
    }
    return { ok: true, storage };
  } catch (err) {
    return { ok: false, storage, error: err.message };
  }
}

/** Backward-compatible wrapper: save the default firm's page settings. */
async function saveDefaultFirmPageSettings(patch) {
  return saveFirmPageSettings(DEFAULT_FIRM_ID, patch);
}

function slugifyFirmId(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Upsert a firm row from a patch of DB column names (a subset is fine — omitted
 * columns are preserved by the COALESCE upsert, which is how blank secret fields
 * keep their stored value). Requires Postgres (the multi-firm reporting config
 * isn't modeled in the Sheets fallback).
 */
async function saveFirm(id, patch) {
  if (!pg.isEnabled()) {
    return { ok: false, error: 'Managing firms requires a Postgres database (set DATABASE_URL).' };
  }
  if (!id) return { ok: false, error: 'Missing firm id.' };
  try {
    const firms = await loadFirms();
    const existing = firms.find((f) => f.id === id);
    const now = nowIso();
    const row = { id, created_at: existing?.created_at || now };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'id' || k === 'created_at' || k === 'updated_at') continue;
      row[k] = v;
    }
    if (!existing && !row.firm_name) row.firm_name = id;
    await pg.upsertFirm(row);
    return { ok: true, storage: 'postgres', id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Create a new firm; derives a unique slug id from the firm name. */
async function createFirm(patch) {
  if (!pg.isEnabled()) {
    return { ok: false, error: 'Managing firms requires a Postgres database (set DATABASE_URL).' };
  }
  const base = slugifyFirmId((patch && patch.firm_name) || '') || 'firm';
  const firms = await loadFirms();
  const taken = new Set(firms.map((f) => f.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return saveFirm(id, patch || {});
}

async function deleteFirm(id) {
  if (!pg.isEnabled()) {
    return { ok: false, error: 'Managing firms requires a Postgres database (set DATABASE_URL).' };
  }
  if (!id) return { ok: false, error: 'Missing firm id.' };
  try {
    const ok = await pg.deleteFirm(id);
    return { ok, error: ok ? undefined : 'Firm not found.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  HEADER,
  DEFAULT_FIRM_ID,
  isConfigured: () => pg.isEnabled() || db.isConfigured(),
  canManageFirms: () => pg.isEnabled(),
  normalizeHost,
  landingConfigForFirm,
  reportConfigForFirm,
  CALL_STATS_SLOTS,
  parseClockTime,
  resolveClockTime,
  clockToHm,
  clockLabel,
  callStatsSlot,
  callStatsSlotClock,
  callStatsSlotRecipients,
  callStatsSlotRawRecipientText,
  callStatsSlotGoal,
  parseEmailList,
  parseMissedGoal,
  loadFirms,
  loadActiveFirms,
  getDefaultFirm,
  getFirmById,
  getFirmByHost,
  matchFirmByHost,
  saveDefaultFirmPageSettings,
  saveFirmPageSettings,
  saveFirm,
  createFirm,
  deleteFirm,
};
