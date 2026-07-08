const { DateTime } = require('luxon');
const db = require('./reviewDb');
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
    if (firm.call_phone_number) cfg.callNumber = firm.call_phone_number;
    if (firm.text_phone_number) cfg.textNumber = firm.text_phone_number;
  }
  return cfg;
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
 * Durably save the default firm's page settings from an editor patch.
 * Falls back to the review-landing.json file when Sheets isn't configured.
 * @returns {Promise<{ ok: boolean, storage: 'sheet'|'file', error?: string }>}
 */
async function saveDefaultFirmPageSettings(patch) {
  if (!db.isConfigured()) {
    const res = saveReviewLandingConfig(patch || {});
    return { ok: res.ok, storage: 'file', error: res.error };
  }

  try {
    // Merge patch onto the current effective config, then split into columns + blob.
    const current = landingConfigForFirm(await getDefaultFirm());
    const merged = { ...current };
    for (const [k, v] of Object.entries(patch || {})) {
      if (LANDING_KEYS.includes(k)) merged[k] = v;
    }

    const blob = {};
    for (const k of LANDING_KEYS) blob[k] = merged[k];

    const firms = await loadFirms();
    const existing = firms.find((f) => f.id === DEFAULT_FIRM_ID) || firms[0];
    const now = nowIso();

    const rowObj = {
      id: existing?.id || DEFAULT_FIRM_ID,
      firm_name: existing?.firm_name || COMPANY_NAME,
      review_domain: existing?.review_domain || (process.env.REVIEW_DOMAIN || '').trim(),
      google_review_url: merged.googleReviewUrl || '',
      call_phone_number: merged.callNumber || '',
      text_phone_number: merged.textNumber || '',
      review_page_settings_json: JSON.stringify(blob),
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    if (existing && existing._row) {
      await db.updateObjectRow(TAB, HEADER, existing._row, rowObj);
    } else {
      await db.appendObject(TAB, HEADER, rowObj);
    }
    return { ok: true, storage: 'sheet' };
  } catch (err) {
    return { ok: false, storage: 'sheet', error: err.message };
  }
}

module.exports = {
  HEADER,
  DEFAULT_FIRM_ID,
  isConfigured: db.isConfigured,
  normalizeHost,
  landingConfigForFirm,
  loadFirms,
  getDefaultFirm,
  getFirmById,
  getFirmByHost,
  saveDefaultFirmPageSettings,
};
