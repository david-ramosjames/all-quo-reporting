/**
 * Deterministic Quo/Slack ↔ Google Sheet matching (columns E/F/K).
 * Injected into the LLM prompt so "not on sheet" is not guessed incorrectly.
 *
 * Column letters match sheets.js / .env (defaults E, F, K, L) — duplicated here to avoid circular requires.
 */

const { DateTime } = require('luxon');

const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

/**
 * After this local time, the person responsible for entering leads into the sheet
 * has typically left for the day, so post-cutoff leads should be framed as a
 * reminder ("expected to be entered next business day") rather than a true gap.
 * Override via SHEET_ENTRY_CUTOFF_LOCAL=HH:mm (24h, local time).
 */
const SHEET_ENTRY_CUTOFF_LOCAL = (process.env.SHEET_ENTRY_CUTOFF_LOCAL || '17:30').trim();

function parseCutoffLocal(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 17, minute: 30 };
  const hour = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const minute = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { hour, minute };
}

const CUTOFF = parseCutoffLocal(SHEET_ENTRY_CUTOFF_LOCAL);

/**
 * Returns { afterHours: boolean, localTimeLabel: string } for a call timestamp.
 * Returns { afterHours: false, localTimeLabel: '' } if the timestamp is missing/invalid.
 */
function classifyEntryCutoff(iso) {
  if (!iso) return { afterHours: false, localTimeLabel: '' };
  const dt = DateTime.fromISO(String(iso), { zone: 'utc' }).setZone(TIMEZONE);
  if (!dt.isValid) return { afterHours: false, localTimeLabel: '' };
  const cutoffMinutes = CUTOFF.hour * 60 + CUTOFF.minute;
  const callMinutes = dt.hour * 60 + dt.minute;
  const afterHours = callMinutes >= cutoffMinutes;
  const localTimeLabel = dt.toFormat('h:mm a');
  return { afterHours, localTimeLabel };
}

function cutoffLabel() {
  const dt = DateTime.fromObject({ hour: CUTOFF.hour, minute: CUTOFF.minute }, { zone: TIMEZONE });
  return dt.toFormat('h:mm a');
}

function columnLettersToIndex(letters) {
  const up = String(letters || 'A').toUpperCase().replace(/[^A-Z]/g, '') || 'A';
  let n = 0;
  for (let i = 0; i < up.length; i++) {
    n = n * 26 + (up.charCodeAt(i) - 64);
  }
  return n - 1;
}

// Optional `cols` (spreadsheet letters) override the env/defaults per firm.
function sheetMatchColumnsFromEnv(cols) {
  cols = cols || {};
  return {
    name:    columnLettersToIndex(cols.name || process.env.GOOGLE_SHEETS_NAME_COL || 'E'),
    phone:   columnLettersToIndex(cols.phone || process.env.GOOGLE_SHEETS_PHONE_COL || 'F'),
    status:  columnLettersToIndex(cols.status || process.env.GOOGLE_SHEETS_STATUS_COL || 'K'),
    consult: columnLettersToIndex(cols.consult || process.env.GOOGLE_SHEETS_CONSULT_COL || 'L'),
  };
}

const NAME_STOP = new Set([
  'unknown',
  'caller',
  'new',
  'lead',
  'the',
  'and',
  'for',
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
]);

/** Last 10 US digits; strips leading 1 when 11 digits. */
function last10Digits(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (!d) return null;
  let x = d;
  if (x.length >= 11 && x.startsWith('1')) x = x.slice(1);
  if (x.length >= 10) return x.slice(-10);
  return null;
}

function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !NAME_STOP.has(t));
}

/** Sheet cell may be a number (no formatting) — avoid scientific notation for large ints. */
function cellPhoneString(cell) {
  if (cell == null) return '';
  if (typeof cell === 'number' && Number.isFinite(cell)) {
    const n = Math.round(cell);
    if (n >= 1e9 && n < 1e11) return String(n);
    return String(cell);
  }
  return String(cell).trim();
}

function parseSheetEfkRows(rows, cols) {
  if (!rows?.length || rows.length < 2) return [];

  const { name: iN, phone: iP, status: iS, consult: iC } = sheetMatchColumnsFromEnv(cols);

  return rows
    .slice(1)
    .map((row, i) => {
      const sheetRow = i + 2;
      const name = String(row[iN] ?? '').trim();
      const phoneStr = cellPhoneString(row[iP]);
      const status = String(row[iS] ?? '').trim();
      const consultation = String(row[iC] ?? '').trim();
      const d10 = last10Digits(phoneStr);
      const empty = !row.some((c) => String(c ?? '').trim() !== '');
      return { sheetRow, name, phoneStr, status, consultation, d10, empty };
    })
    .filter((e) => !e.empty);
}

function buildPhoneIndex(entries) {
  /** @type {Map<string, typeof entries>} */
  const map = new Map();
  for (const e of entries) {
    if (!e.d10) continue;
    if (!map.has(e.d10)) map.set(e.d10, []);
    map.get(e.d10).push(e);
  }
  return map;
}

/** Pull likely phone numbers from free text (Slack, summaries). */
function extractPhonesFromText(text) {
  const out = new Set();
  if (!text || typeof text !== 'string') return out;
  const re = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{10,11}\b/g;
  let m;
  const s = text;
  while ((m = re.exec(s)) !== null) {
    const d10 = last10Digits(m[0]);
    if (d10) out.add(d10);
  }
  return out;
}

function tokenOverlapScore(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  return A.filter((t) => setB.has(t)).length;
}

/**
 * @param {Array<{ phone?: string, contact?: string }>} callData
 * @param {string} slackText
 * @param {any[][]} rows raw sheet values including header
 */
function buildAutomatedSheetMatches(callData, slackText, rows, cols) {
  const entries = parseSheetEfkRows(rows, cols);
  if (!entries.length) {
    return (
      'AUTOMATED SHEET LOOKUPS (code-verified):\n' +
      '(No data rows in sheet — skip reconciliation.)'
    );
  }

  const phoneIndex = buildPhoneIndex(entries);
  const cutoffStr = cutoffLabel();
  const lines = [
    'AUTOMATED SHEET LOOKUPS (code-verified — trust these; do NOT say "not on sheet" for a lead listed here):',
    'Phone matches use the last 10 digits. Name matches require at least two overlapping name tokens (first/last).',
    `SHEET ENTRY CUTOFF: ${cutoffStr} ${TIMEZONE}. Leads marked **[AFTER-HOURS]** below arrived after this time, when the sheet-data-entry person has typically left. For those, frame any "not on sheet" finding as a gentle reminder ("expected to be entered next business day"), NOT as a missed lead or discrepancy.`,
    '',
  ];

  const seen = new Set();

  const afterHoursTag = (cutoff) =>
    cutoff.afterHours
      ? ` **[AFTER-HOURS @ ${cutoff.localTimeLabel} local — entry expected next business day; treat as reminder, not a gap]**`
      : '';

  const pushMatch = (label, d10, entry, via, cutoff) => {
    const key = `${label}|${d10}|${entry.sheetRow}|${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(
      `- ${label} → **on sheet** [sheet row ${entry.sheetRow}] status:"${entry.status || '?'}" consult:"${entry.consultation || '?'}" name:"${entry.name || '?'}" phone:"${entry.phoneStr || '?'}" (${via})${afterHoursTag(cutoff || { afterHours: false })}`
    );
  };

  // --- Quo calls ---
  (callData || []).forEach((c, idx) => {
    const label = `Quo call [${idx + 1}]`;
    const cutoff = classifyEntryCutoff(c.timestamp);
    const tag = afterHoursTag(cutoff);
    const d10 = last10Digits(c.phone) || last10Digits(c.contact);
    if (d10) {
      const hits = phoneIndex.get(d10);
      if (hits?.length) {
        for (const h of hits) pushMatch(label, d10, h, 'phone=sheet', cutoff);
      } else {
        const contact = (c.contact || '').trim();
        const badContact = !contact || /unknown/i.test(contact);
        if (!badContact) {
          let best = null;
          let bestScore = 0;
          for (const e of entries) {
            const sc = tokenOverlapScore(contact, e.name);
            if (sc >= 2 && sc > bestScore) {
              bestScore = sc;
              best = e;
            }
          }
          if (best) {
            pushMatch(label, d10, best, `name overlap (${bestScore} tokens; sheet F did not match this 10-digit)`, cutoff);
          } else {
            lines.push(
              `- ${label} caller digits ${d10}: **no auto row** (column F had no same 10-digit). Search the LEAD PIPELINE lines for this number or "${contact || 'caller name'}" before saying "not on sheet" (sheet may use different formatting or tab).${tag}`
            );
          }
        } else {
          lines.push(
            `- ${label} caller digits ${d10}: **no auto row** by phone in column F. Search LEAD PIPELINE manually — contact name was unclear for auto name-match.${tag}`
          );
        }
      }
    } else {
      lines.push(
        `- ${label}: could not derive 10-digit phone — use LEAD PIPELINE + summaries only; do not guess "not on sheet".${tag}`
      );
    }
  });

  lines.push('');

  // --- Slack-derived phones (any number in the Slack block) ---
  const slackPhones = extractPhonesFromText(slackText || '');
  for (const d10 of slackPhones) {
    const hits = phoneIndex.get(d10);
    if (!hits?.length) continue;
    for (const h of hits) {
      const key = `Slack|${d10}|${h.sheetRow}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        `- Slack text mentions phone ending **${d10}** → **on sheet** [sheet row ${h.sheetRow}] status:"${h.status || '?'}" consult:"${h.consultation || '?'}" name:"${h.name || '?'}" (phone match)`
      );
    }
  }

  lines.push('');
  lines.push(
    'If a lead is not listed above but appears in the LEAD PIPELINE block, still treat as on sheet when phone or name clearly matches that block.'
  );

  return lines.join('\n');
}

module.exports = {
  last10Digits,
  buildAutomatedSheetMatches,
  extractPhonesFromText,
  parseSheetEfkRows,
};
