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
    emailTo: f.report_email_to ? parseList(f.report_email_to) : parseList(env.EMAIL_TO),
    weeklyEmailTo: firstList(f.weekly_email_to, f.report_email_to, env.EMAIL_TO),
    monthlyEmailTo: firstList(f.monthly_email_to, f.report_email_to, env.EMAIL_TO),
    missedEmailTo: firstList(f.missed_calls_email_to, env.MISSED_CLIENT_CALLS_EMAIL_TO, f.report_email_to, env.EMAIL_TO),
    slackBotToken: firstNonEmpty(f.slack_bot_token, env.SLACK_BOT_TOKEN),
    slackChannel: firstNonEmpty(f.slack_channel, env.SLACK_CHANNEL, 'lead-calls'),
    reviewSlackChannel: firstNonEmpty(f.review_slack_channel, env.REVIEW_SLACK_CHANNEL, 'review-opportunities'),
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
