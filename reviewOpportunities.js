const crypto = require('crypto');
const { DateTime } = require('luxon');
const {
  fetchSheetData,
  appendSheetValues,
  updateSheetValues,
  resolveAppendAnchorA1,
  sheetTabFromRangeA1,
} = require('./sheets');

/**
 * "review_opportunities" table — the backend record of every Review Opportunity
 * the AI Decision Engine creates.
 *
 * The rest of this codebase uses Google Sheets as its system of record (weekly
 * sentiment log, negative snapshot, latest sentiment). We follow that same
 * convention here so no new database/infra is introduced for V1: the table is a
 * dedicated worksheet tab whose columns are exactly the required fields.
 *
 *   id | case_id | client_name | review_score | confidence | reasoning |
 *   status | created_at | updated_at | sent_at
 *
 * status ∈ Suggested (AI default) · Approved · Sent · Completed · Declined
 */

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

const REVIEW_OPPORTUNITIES_HEADER = [
  'id',
  'case_id',
  'client_name',
  'review_score',
  'confidence',
  'reasoning',
  'status',
  'created_at',
  'updated_at',
  'sent_at',
];

const STATUS_SUGGESTED = 'Suggested';
const VALID_STATUSES = new Set([
  'Suggested',
  'Approved',
  'Sent',
  'Completed',
  'Declined',
]);

/**
 * Statuses a human has already acted on — the AI must never clobber these.
 * A fresh daily run leaves them exactly as they are.
 */
const HUMAN_OWNED_STATUSES = new Set(['Approved', 'Sent', 'Completed', 'Declined']);

const COL = Object.fromEntries(REVIEW_OPPORTUNITIES_HEADER.map((h, i) => [h, i]));

function spreadsheetId() {
  return (process.env.GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID ?? '').trim();
}

function rangeInput() {
  return (process.env.GOOGLE_REVIEW_OPPORTUNITIES_RANGE ?? 'review_opportunities').trim();
}

function hasOAuth() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

/** Persistence is best-effort (like the other sheet sinks) — off unless configured. */
function isConfigured() {
  return Boolean(spreadsheetId() && hasOAuth());
}

function nowIso() {
  return DateTime.now().setZone(TIMEZONE).toISO();
}

/** Reasoning bullets → one sheet cell (kept human-readable). */
function reasoningToCell(reasoning) {
  if (Array.isArray(reasoning)) {
    return reasoning
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .map((s) => `• ${s}`)
      .join('\n');
  }
  return String(reasoning || '').trim();
}

/** Tab reference for A1 ranges (quotes names that need it). */
function normalizeRange(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (s.includes('!')) return s;
  const needsQuote = /[^A-Za-z0-9_]/.test(s);
  const tab = needsQuote ? `'${s.replace(/'/g, "''")}'` : s;
  return `${tab}!A:ZZ`;
}

async function resolvePrefix() {
  const normalized = normalizeRange(rangeInput());
  const anchor = await resolveAppendAnchorA1(spreadsheetId(), normalized);
  const prefix = anchor.slice(0, Math.max(0, anchor.lastIndexOf('!')));
  return { anchor, prefix, tabTitle: sheetTabFromRangeA1(anchor) };
}

async function ensureHeader(prefix) {
  const top = await fetchSheetData(spreadsheetId(), `${prefix}!A1:A1`);
  const cell = top?.[0]?.[0];
  if (cell == null || String(cell).trim() !== REVIEW_OPPORTUNITIES_HEADER[0]) {
    await updateSheetValues(spreadsheetId(), `${prefix}!A1`, [REVIEW_OPPORTUNITIES_HEADER]);
  }
}

function recordToRow(rec) {
  return [
    rec.id,
    rec.case_id || '',
    rec.client_name || '',
    rec.review_score == null ? '' : String(rec.review_score),
    rec.confidence || '',
    reasoningToCell(rec.reasoning),
    rec.status || STATUS_SUGGESTED,
    rec.created_at || '',
    rec.updated_at || '',
    rec.sent_at || '',
  ];
}

/**
 * Creates or refreshes the Review Opportunity for one case.
 *
 * - New case → append a fresh row (status "Suggested", id + timestamps set).
 * - Existing row still "Suggested" → refresh score/confidence/reasoning + updated_at.
 * - Existing row a human already acted on (Approved/Sent/Completed/Declined) → left untouched.
 *
 * @returns {Promise<{ action: 'created'|'updated'|'skipped-existing'|'disabled', id?: string, status?: string }>}
 */
async function upsertReviewOpportunity(input) {
  if (!isConfigured()) return { action: 'disabled' };

  const caseId = String(input.case_id || '').trim();
  const { prefix } = await resolvePrefix();
  await ensureHeader(prefix);

  const lastColLetter = 'J'; // 10 columns (A..J)
  let existing = [];
  try {
    existing = await fetchSheetData(spreadsheetId(), `${prefix}!A2:${lastColLetter}100000`);
  } catch {
    existing = [];
  }

  // Match by case_id (the stable key). Fall back to client_name when case_id blank.
  let matchRow0 = -1; // 0-based index within `existing`
  for (let i = 0; i < existing.length; i++) {
    const row = existing[i] || [];
    const rowCase = String(row[COL.case_id] ?? '').trim();
    const rowName = String(row[COL.client_name] ?? '').trim();
    const hit = caseId
      ? rowCase === caseId
      : rowName && rowName === String(input.client_name || '').trim();
    if (hit) {
      matchRow0 = i;
      break;
    }
  }

  const now = nowIso();

  if (matchRow0 === -1) {
    const rec = {
      id: crypto.randomUUID(),
      case_id: caseId,
      client_name: input.client_name || '',
      review_score: input.review_score,
      confidence: input.confidence,
      reasoning: input.reasoning,
      status: STATUS_SUGGESTED,
      created_at: now,
      updated_at: now,
      sent_at: '',
    };
    await appendSheetValues(spreadsheetId(), `${prefix}!A1`, [recordToRow(rec)]);
    return { action: 'created', id: rec.id, status: rec.status };
  }

  const existingRow = existing[matchRow0] || [];
  const existingStatus = String(existingRow[COL.status] ?? '').trim() || STATUS_SUGGESTED;

  if (HUMAN_OWNED_STATUSES.has(existingStatus)) {
    return { action: 'skipped-existing', id: existingRow[COL.id], status: existingStatus };
  }

  // Refresh the still-Suggested row in place (preserve id + created_at).
  const sheetRow1 = matchRow0 + 2;
  const rec = {
    id: existingRow[COL.id] || crypto.randomUUID(),
    case_id: caseId || String(existingRow[COL.case_id] ?? '').trim(),
    client_name: input.client_name || existingRow[COL.client_name] || '',
    review_score: input.review_score,
    confidence: input.confidence,
    reasoning: input.reasoning,
    status: STATUS_SUGGESTED,
    created_at: existingRow[COL.created_at] || now,
    updated_at: now,
    sent_at: existingRow[COL.sent_at] || '',
  };
  await updateSheetValues(
    spreadsheetId(),
    `${prefix}!A${sheetRow1}:${lastColLetter}${sheetRow1}`,
    [recordToRow(rec)]
  );
  return { action: 'updated', id: rec.id, status: rec.status };
}

module.exports = {
  REVIEW_OPPORTUNITIES_HEADER,
  VALID_STATUSES,
  STATUS_SUGGESTED,
  isConfigured,
  upsertReviewOpportunity,
};
