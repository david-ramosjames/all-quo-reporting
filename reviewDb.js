const {
  fetchSheetData,
  appendSheetValues,
  updateSheetValues,
  ensureSheetTab,
} = require('./sheets');

/**
 * Small shared helper for the review-system Google Sheets tables
 * (firm_settings, review_requests, review_request_events). Follows the repo's
 * "Sheets as system of record" convention, with a short in-memory cache so the
 * public review page and click-tracking routes don't hit the Sheets API on
 * every request.
 *
 * Everything degrades gracefully: when the sheet/OAuth isn't configured, reads
 * return empty and writes are no-ops, so the public page still renders.
 */

const CACHE_TTL_MS = parseInt(process.env.REVIEW_DB_CACHE_TTL_MS || '15000', 10) || 15000;

/** All review-system tabs live in one spreadsheet. */
function spreadsheetId() {
  return (
    process.env.GOOGLE_REVIEW_SHEET_ID ||
    process.env.GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID ||
    ''
  ).trim();
}

function hasOAuth() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}

function isConfigured() {
  return Boolean(spreadsheetId() && hasOAuth());
}

/** 0-based column index → A1 letters (A..Z, AA..). */
function colLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/** cache: tab -> { rows: string[][], at: number } (data rows only, header stripped). */
const cache = new Map();
const ensured = new Set();

function invalidate(tab) {
  cache.delete(tab);
}

async function ensureTable(tab, header) {
  const id = spreadsheetId();
  if (ensured.has(tab)) return;
  await ensureSheetTab(id, tab);
  const top = await fetchSheetData(id, `${tab}!A1:${colLetter(header.length - 1)}1`);
  const first = top?.[0]?.[0];
  if (first == null || String(first).trim() !== header[0]) {
    await updateSheetValues(id, `${tab}!A1`, [header]);
  }
  ensured.add(tab);
}

/**
 * Returns data rows (header stripped) as arrays, cached. Each element also
 * carries a non-enumerable _row (1-based sheet row) via a parallel index.
 */
async function readRows(tab, header, { force = false } = {}) {
  if (!isConfigured()) return [];
  const cached = cache.get(tab);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
  await ensureTable(tab, header);
  const all = await fetchSheetData(id_(), `${tab}!A2:${colLetter(header.length - 1)}200000`);
  const rows = (all || []).map((r) => (Array.isArray(r) ? r : []));
  cache.set(tab, { rows, at: Date.now() });
  return rows;
}

function id_() {
  return spreadsheetId();
}

/** Row array → object keyed by header, plus _row (1-based sheet row number). */
function rowToObject(header, row, index0) {
  const obj = {};
  header.forEach((h, i) => {
    obj[h] = row[i] != null ? String(row[i]) : '';
  });
  obj._row = index0 + 2; // +1 header, +1 for 1-based
  return obj;
}

async function readObjects(tab, header, opts) {
  const rows = await readRows(tab, header, opts);
  return rows.map((r, i) => rowToObject(header, r, i));
}

function objectToRow(header, obj) {
  return header.map((h) => {
    const v = obj[h];
    return v == null ? '' : String(v);
  });
}

async function appendObject(tab, header, obj) {
  if (!isConfigured()) return false;
  await ensureTable(tab, header);
  await appendSheetValues(id_(), `${tab}!A1`, [objectToRow(header, obj)]);
  invalidate(tab);
  return true;
}

async function updateObjectRow(tab, header, row1Based, obj) {
  if (!isConfigured()) return false;
  const last = colLetter(header.length - 1);
  await updateSheetValues(id_(), `${tab}!A${row1Based}:${last}${row1Based}`, [
    objectToRow(header, obj),
  ]);
  invalidate(tab);
  return true;
}

module.exports = {
  isConfigured,
  spreadsheetId,
  colLetter,
  ensureTable,
  readRows,
  readObjects,
  appendObject,
  updateObjectRow,
  invalidate,
};
