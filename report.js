require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const MailComposer = require('nodemailer/lib/mail-composer');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { runExport } = require('./fetch_calls');
const {
  generateDailyLeadReportPrompt,
  buildWeeklyClientBundleSentimentPrompt,
  buildReviewOpportunityPrompt,
  REVIEW_CONFIDENCE_TIERS,
  SENTIMENT_REASON_TAGS,
  MONTHLY_EXTRACTION_FIELDS,
  buildMonthlyTranscriptExtractionPrompt,
  buildMonthlyBatchExtractionPrompt,
  buildMonthlyNewsletterAggregationPrompt,
} = require('./prompts');
const { fetchSlackMessages, formatSlackForPrompt, postSlackMessage } = require('./slack');
const { upsertReviewOpportunity, isConfigured: reviewStoreConfigured } = require('./reviewOpportunities');
const firmStore = require('./firmStore');
const reviewRequests = require('./reviewRequests');
const quoSend = require('./quoSend');
const {
  getLeadPipelineText,
  fetchSheetData,
  rawRowsToCaseRosterMap,
  appendSheetValues,
  updateSheetValues,
  clearSheetValuesRange,
  batchUpdateSheetValues,
  getSheetIdByTitle,
  deleteSheetRowsByIndex,
  sheetTabFromRangeA1,
  resolveAppendAnchorA1,
  makeAuthClient,
} = require('./sheets');
const { last10Digits } = require('./sheet_reconcile');

// ── Config ────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_MAX_COMPLETION_TOKENS = parseInt(
  process.env.OPENAI_MAX_COMPLETION_TOKENS || '28000',
  10
);
const OPENAI_LEAD_REPORT_MAX_TOKENS = parseInt(
  process.env.OPENAI_LEAD_REPORT_MAX_COMPLETION_TOKENS ||
    String(OPENAI_MAX_COMPLETION_TOKENS),
  10
);
/** Per-client weekly bundle sentiment JSON (summaries + SMS; raise if validation fails). */
const OPENAI_SENTIMENT_MAX_TOKENS = parseInt(
  process.env.OPENAI_SENTIMENT_MAX_COMPLETION_TOKENS || '8192',
  10
);
const SENTIMENT_LLM_DELAY_MS = parseInt(
  process.env.SENTIMENT_LLM_DELAY_MS || '120',
  10
);
/** Pause between monthly extraction **waves** (parallel batches). Lower than weekly default to shorten long runs. */
const MONTHLY_LLM_DELAY_MS = parseInt(process.env.MONTHLY_LLM_DELAY_MS || '60', 10);
/** Per-transcript monthly newsletter theme extraction (JSON). */
const OPENAI_MONTHLY_EXTRACTION_MAX_TOKENS = parseInt(
  process.env.OPENAI_MONTHLY_EXTRACTION_MAX_COMPLETION_TOKENS || '8192',
  10
);
/** Optional cap for batched monthly extraction output (defaults to a function of batch size). */
const OPENAI_MONTHLY_BATCH_MAX_COMPLETION_TOKENS = process.env.OPENAI_MONTHLY_BATCH_MAX_COMPLETION_TOKENS
  ? parseInt(process.env.OPENAI_MONTHLY_BATCH_MAX_COMPLETION_TOKENS, 10)
  : null;
/** Truncate transcripts in **batched** monthly prompts to limit context (per call). */
const MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS = parseInt(
  process.env.MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS || '1200',
  10
);
/** When not "0", monthly batch extraction uses OpenAI strict json_schema (falls back to json_object if unsupported). */
const MONTHLY_BATCH_USE_JSON_SCHEMA = process.env.MONTHLY_BATCH_USE_JSON_SCHEMA !== '0';
/** Monthly pooled newsletter content brief (not organized by caller). */
const OPENAI_MONTHLY_AGGREGATE_MAX_TOKENS = parseInt(
  process.env.OPENAI_MONTHLY_AGGREGATE_MAX_COMPLETION_TOKENS || '20000',
  10
);
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const COMPANY_NAME    = process.env.COMPANY_NAME || 'Ramos James Law, PLLC';
const TIMEZONE        = process.env.TIMEZONE || 'America/Chicago';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL   = process.env.SLACK_CHANNEL || 'lead-calls';

// ── Review Intelligence V1 (daily Google-review candidate detection) ──────────
const clampInt = (raw, def, lo, hi) => {
  const n = parseInt(raw ?? '', 10);
  const v = Number.isFinite(n) ? n : def;
  return Math.max(lo, Math.min(hi, v));
};
/** Slack channel that receives the daily review-opportunity report. */
const REVIEW_SLACK_CHANNEL = (process.env.REVIEW_SLACK_CHANNEL || 'review-opportunities').trim();
/** How far back to read each client's journey (the 24h activity window gates who is scored). */
const REVIEW_JOURNEY_DAYS = clampInt(process.env.REVIEW_JOURNEY_DAYS, 14, 1, 120);
/** Minimum score to persist a Review Opportunity to the backend table. */
const REVIEW_MIN_SCORE = clampInt(process.env.REVIEW_MIN_SCORE, 60, 0, 100);
/** Slack report only shows the very best opportunities: high score + High confidence. */
const REVIEW_REPORT_MIN_SCORE = clampInt(process.env.REVIEW_REPORT_MIN_SCORE, 90, 0, 100);
const REVIEW_REPORT_MIN_CONFIDENCE = (process.env.REVIEW_REPORT_MIN_CONFIDENCE || 'High').trim();
const REVIEW_REPORT_LIMIT = clampInt(process.env.REVIEW_REPORT_LIMIT, 10, 1, 50);
/** Token budget for the per-client review-scoring JSON call. */
const OPENAI_REVIEW_MAX_TOKENS = clampInt(process.env.OPENAI_REVIEW_MAX_COMPLETION_TOKENS, 4096, 512, 32000);

const GOOGLE_SHEETS_ID    = process.env.GOOGLE_SHEETS_ID;
// Blank = entire first worksheet. Otherwise e.g. A:ZZ, or 'Master View'!A:ZZ for a specific tab.
const GOOGLE_SHEETS_RANGE = (process.env.GOOGLE_SHEETS_RANGE ?? '').trim();

/** Optional: weekly sentiment table — join Quo case suffix to sheet columns (same OAuth as lead pipeline). */
const GOOGLE_SHEETS_CASE_ROSTER_ID = (process.env.GOOGLE_SHEETS_CASE_ROSTER_ID ?? '').trim();
const GOOGLE_SHEETS_CASE_ROSTER_RANGE = (process.env.GOOGLE_SHEETS_CASE_ROSTER_RANGE ?? '').trim();

/** Optional: append weekly client sentiment rows (one row per client per run). Same OAuth as other Sheets features. */
const GOOGLE_WEEKLY_SENTIMENT_SHEET_ID = (process.env.GOOGLE_WEEKLY_SENTIMENT_SHEET_ID ?? '').trim();
/** A1 range with tab (e.g. `'Weekly sentiment'!A:Q`); blank = first worksheet. */
const GOOGLE_WEEKLY_SENTIMENT_RANGE = (process.env.GOOGLE_WEEKLY_SENTIMENT_RANGE ?? '').trim();
/**
 * When not "0" (default): for this Quo window, **update** an existing row per client or **append** if new;
 * duplicate rows for the same client+window are removed. Clients not in this run keep their sheet rows.
 * When "0": always **append** new rows (full history of every run).
 */
const GOOGLE_WEEKLY_SENTIMENT_DEDUPE = process.env.GOOGLE_WEEKLY_SENTIMENT_DEDUPE !== '0';

/** Negative-only email snapshot tab (defaults to tab name `Negative Sentiment` on the weekly sheet spreadsheet). */
const GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_SHEET_ID = (process.env.GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_SHEET_ID ?? '').trim();
const GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_RANGE = (process.env.GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_RANGE ?? '').trim();

/** Append-only "All Latest Sentiment" tab — every weekly run appends rollups (one row per client per run). */
const GOOGLE_LATEST_SENTIMENT_SHEET_ID = (process.env.GOOGLE_LATEST_SENTIMENT_SHEET_ID ?? '').trim();
const GOOGLE_LATEST_SENTIMENT_RANGE = (process.env.GOOGLE_LATEST_SENTIMENT_RANGE ?? '').trim();

const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO   = process.env.EMAIL_TO?.split(',').map((e) => e.trim()).filter(Boolean) || [];
const MISSED_CLIENT_CALLS_EMAIL_TO =
  process.env.MISSED_CLIENT_CALLS_EMAIL_TO?.split(',').map((e) => e.trim()).filter(Boolean) || [];
const EMAIL_CONFIGURED = Boolean(
  EMAIL_FROM &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_REFRESH_TOKEN,
);

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Yesterday 00:00–24:00 in TIMEZONE — same window for Quo API and Slack.
 */
function getYesterdayRange() {
  const end   = DateTime.now().setZone(TIMEZONE).startOf('day');
  const start = end.minus({ days: 1 });
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: end.toUTC().toISO(),
  };
}

/**
 * Trailing 7 days for weekly client sentiment: from start of local day 7 days ago through now (UTC ISO for Quo).
 */
function getTrailing7DaysRange() {
  const now   = DateTime.now().setZone(TIMEZONE);
  const start = now.minus({ days: 7 }).startOf('day');
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: now.toUTC().toISO(),
  };
}

/** Trailing 24 hours from "now" — used by the missed-client-call report. */
function getTrailing24HoursRange() {
  const now = DateTime.now().setZone(TIMEZONE);
  const start = now.minus({ hours: 24 });
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: now.toUTC().toISO(),
  };
}

/** Trailing N days for ad-hoc sentiment runs (manual admin trigger). */
function getTrailingDaysRange(days) {
  const n = Math.max(1, Math.floor(Number(days) || 7));
  const now   = DateTime.now().setZone(TIMEZONE);
  const start = now.minus({ days: n }).startOf('day');
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: now.toUTC().toISO(),
  };
}

/** Trailing 30 days for monthly newsletter insight extraction. */
function getTrailing30DaysRange() {
  const now   = DateTime.now().setZone(TIMEZONE);
  const start = now.minus({ days: 30 }).startOf('day');
  return {
    createdAfter:  start.toUTC().toISO(),
    createdBefore: now.toUTC().toISO(),
  };
}

/** Contact is an active client if CRM name ends with a case number: "First Last 1234" */
const CLIENT_CONTACT_CASE_RE = /.+\s\d+$/;

function isClientContactName(contact) {
  const t = (contact || '').trim();
  return t.length > 0 && CLIENT_CONTACT_CASE_RE.test(t);
}

/** Quo client key ends with whitespace + digits, e.g. "Maria Lopez 1048" → "1048". */
function extractTrailingCaseDigitsFromClientKey(clientKey) {
  const m = String(clientKey || '').trim().match(/\s(\d+)$/);
  return m ? m[1] : null;
}

function enrichRollupsWithCaseRoster(rollups, rosterMap) {
  if (!rollups?.length || !rosterMap?.size) return rollups;
  for (const r of rollups) {
    const id = extractTrailingCaseDigitsFromClientKey(r.clientKey);
    const hit = id ? rosterMap.get(id) : null;
    r.leadAttorney = hit?.leadAttorney ?? '';
    r.paralegal = hit?.paralegal ?? '';
  }
  return rollups;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human-readable range for prompts (e.g. "Mon, Apr 1, 2026 (America/Chicago, full calendar day)") */
function buildReportRangeLabel(createdAfter) {
  const dt = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  return `${dt.toFormat('ccc, LLL d, yyyy')} (${TIMEZONE}, full calendar day)`;
}

/** Human-readable 7-day trailing window for weekly sentiment. */
function buildSentiment7DayRangeLabel(createdAfter, createdBefore) {
  const a = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  return `${a.toFormat('LLL d')} – ${b.toFormat('LLL d, yyyy')} (${TIMEZONE}, trailing 7 days)`;
}

/** Human-readable trailing N-day window label for ad-hoc sentiment runs. */
function buildSentimentTrailingDaysRangeLabel(createdAfter, createdBefore, days) {
  const a = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  return `${a.toFormat('LLL d')} – ${b.toFormat('LLL d, yyyy')} (${TIMEZONE}, trailing ${days} day${days === 1 ? '' : 's'})`;
}

function buildMonthly30DayRangeLabel(createdAfter, createdBefore) {
  const a = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  return `${a.toFormat('LLL d')} – ${b.toFormat('LLL d, yyyy')} (${TIMEZONE}, trailing 30 days)`;
}

/** CRM client vs everyone else (leads, former leads, unknown). */
function monthlyCallSegment(contact) {
  return isClientContactName(contact) ? 'client' : 'lead_or_other';
}

/** Voice rows with at least a summary or transcript (excludes SMS rows). Monthly themes are summary-first. */
function filterMonthlyNewsletterCalls(callData) {
  return callData.filter(
    (c) =>
      c.recordType !== 'sms' &&
      (Boolean(String(c.summary || '').trim()) || Boolean(String(c.transcript || '').trim()))
  );
}

function formatDateLabel(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDayOfWeek(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
  });
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ── Prompt data builders ──────────────────────────────────────────────────────

function buildLineBreakdown(callData) {
  const byLine = {};
  for (const c of callData) byLine[c.line] = (byLine[c.line] || 0) + 1;
  return Object.entries(byLine)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

function buildContactBreakdown(callData) {
  const known   = callData.filter((c) => c.contact && c.contact.trim()).length;
  const unknown = callData.length - known;
  return `${known} known, ${unknown} new/unknown`;
}

/** Daily Lead Report — metadata + summary + link only (no transcript). */
function buildCallSummaryOnlyLines(callData) {
  return callData
    .map((c, i) => {
      const who       = c.contact?.trim() || `(unknown — ${c.phone})`;
      const durMin    = Math.round((Number(c.duration) || 0) / 60);
      const timestamp = formatTimestamp(c.timestamp);

      return [
        `[${i + 1}] LINE: ${c.line} | CONTACT: ${who} | PHONE: ${c.phone || ''} | DURATION: ${durMin} min | TIME: ${timestamp}`,
        `LINK: ${c.link || ''}`,
        `SUMMARY: ${c.summary || '(no summary)'}`,
        '---',
      ].join('\n');
    })
    .join('\n');
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

/** GPT-5 / o-series may return string or content-parts array; reasoning can burn the whole token budget. */
function extractChatCompletionText(choice) {
  const msg = choice?.message;
  if (!msg) return { text: '', refusal: null, finishReason: choice?.finish_reason };

  if (msg.refusal) {
    return { text: '', refusal: msg.refusal, finishReason: choice?.finish_reason };
  }

  const c = msg.content;
  if (c == null) return { text: '', refusal: null, finishReason: choice?.finish_reason };
  if (typeof c === 'string') return { text: c.trim(), refusal: null, finishReason: choice?.finish_reason };

  if (Array.isArray(c)) {
    const parts = c
      .map((p) => {
        if (p.type === 'text') return p.text || '';
        return '';
      })
      .join('');
    return { text: parts.trim(), refusal: null, finishReason: choice?.finish_reason };
  }

  return { text: '', refusal: null, finishReason: choice?.finish_reason };
}

async function runChatCompletion(
  prompt,
  maxCompletionTokens,
  labelForLogs = 'OpenAI',
  options = {}
) {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_completion_tokens: maxCompletionTokens,
  };

  if (options.jsonSchema) {
    const js = options.jsonSchema;
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: js.name || 'structured_output',
        strict: js.strict !== false,
        schema: js.schema,
      },
    };
  } else if (options.jsonObject) {
    body.response_format = { type: 'json_object' };
  }

  if (/^gpt-5/i.test(OPENAI_MODEL) || /^o\d/i.test(OPENAI_MODEL)) {
    body.reasoning_effort = OPENAI_REASONING_EFFORT;
  }

  let res;
  try {
    res = await openai.chat.completions.create(body);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || '';
    if (body.reasoning_effort && /reasoning_effort|unsupported/i.test(msg)) {
      delete body.reasoning_effort;
      try {
        res = await openai.chat.completions.create(body);
      } catch (err2) {
        const msg2 = err2.response?.data?.error?.message || err2.message || '';
        if (body.response_format && /response_format|json|schema/i.test(msg2)) {
          if (options.strictResponseFormat) throw err2;
          delete body.response_format;
          res = await openai.chat.completions.create(body);
        } else {
          throw err2;
        }
      }
    } else if (body.response_format && /response_format|json|schema/i.test(msg)) {
      if (options.strictResponseFormat) throw err;
      delete body.response_format;
      res = await openai.chat.completions.create(body);
    } else {
      throw err;
    }
  }

  const choice = res.choices[0];
  const { text, refusal, finishReason } = extractChatCompletionText(choice);

  if (!text) {
    const usage = res.usage;
    console.warn(`  ${labelForLogs} returned no visible assistant text.`, {
      finish_reason: finishReason,
      refusal: refusal || undefined,
      usage,
    });
    if (options.throwOnEmpty) {
      throw new Error(
        refusal ||
          `No completion text (finish_reason: ${finishReason || 'unknown'}). Raise OPENAI_SENTIMENT_MAX_COMPLETION_TOKENS or OPENAI_MAX_COMPLETION_TOKENS, or set OPENAI_REASONING_EFFORT=low.`
      );
    }
    const hint =
      'The model used the token budget before producing visible text (common with GPT-5 + reasoning). ' +
      'Raise OPENAI_LEAD_REPORT_MAX_COMPLETION_TOKENS or OPENAI_MAX_COMPLETION_TOKENS, or set OPENAI_REASONING_EFFORT=low in .env.';
    return refusal
      ? `**Model refused:** ${refusal}\n\n${hint}`
      : `**No report body returned** (finish_reason: ${finishReason || 'unknown'}).\n\n${hint}`;
  }

  return text;
}

const ALLOWED_SENTIMENT = new Set(['positive', 'neutral', 'negative']);
const ALLOWED_REASON_TAG_SET = new Set(SENTIMENT_REASON_TAGS);

function stripMarkdownJsonFence(raw) {
  let t = String(raw || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (m) t = m[1].trim();
  return t;
}

function normalizeReasonTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const key = String(t)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/-+/g, '_');
    if (ALLOWED_REASON_TAG_SET.has(key)) out.push(key);
  }
  return [...new Set(out)];
}

const ALLOWED_REVIEW_RISK = new Set(['none', 'low', 'moderate', 'high']);
const ALLOWED_POSITIVE_REVIEW = new Set(['none', 'possible', 'strong']);

function itemTimeMs(item) {
  const t = item.timestamp;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function linksFromTouchpoints(items) {
  const seen = new Set();
  const parts = [];
  for (const it of [...items].sort((a, b) => itemTimeMs(a) - itemTimeMs(b))) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    const lab =
      it.recordType === 'sms'
        ? `SMS ${formatTimestamp(it.timestamp)}`
        : formatTimestamp(it.timestamp) || 'Open';
    parts.push(`[${lab}](${it.link})`);
  }
  return parts.join(', ') || '—';
}

function buildCommunicationBundleMarkdown(items, maxChars = 48000) {
  const sorted = [...items].sort((a, b) => itemTimeMs(a) - itemTimeMs(b));
  const lines = [];
  let n = 0;
  for (const it of sorted) {
    let line;
    if (it.recordType === 'sms') {
      const dir = it.direction || '?';
      let preview = (it.body || '').replace(/\s+/g, ' ').trim();
      if (preview.length > 600) preview = `${preview.slice(0, 597)}...`;
      line = `- **SMS** · ${formatTimestamp(it.timestamp)} · ${dir}\n  "${preview || '(empty)'}"`;
    } else {
      const isAi = it.aiHandled === 'ai-agent';
      const sona = isAi ? ' · **Sona/AI**' : '';
      const st = it.status || 'unknown';
      const dir = it.direction || '';
      const durSec = Number(it.duration);
      const dur = Number.isFinite(durSec)
        ? durSec > 0
          ? `${Math.max(1, Math.round(durSec / 60))}m`
          : '0m'
        : '—';
      let sum = (it.summary || '').replace(/\s+/g, ' ').trim();
      if (sum.length > 900) sum = `${sum.slice(0, 897)}...`;
      line = `- **Voice** · ${formatTimestamp(it.timestamp)} · ${dir} · **${st}** · ${dur}${sona}\n  Summary: ${sum || '(none — e.g. missed call or summary not ready)'}`;
    }
    if (n + line.length > maxChars) {
      lines.push('\n_(…older touchpoints omitted to fit context limit.)_');
      break;
    }
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join('\n\n') || '_(No touchpoints in window.)_';
}

function groupClientTouchpointsByContact(callData) {
  const rows = callData.filter((c) => isClientContactName(c.contact));
  const map = new Map();
  for (const row of rows) {
    const k = row.contact.trim();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

function makeRepresentativeCallForBundle(clientKey, items) {
  const sorted = [...items].sort((a, b) => itemTimeMs(b) - itemTimeMs(a));
  const latest = sorted[0];
  const calls = items.filter((i) => i.recordType !== 'sms');
  const sms = items.filter((i) => i.recordType === 'sms');
  return {
    recordType: 'client_bundle',
    contact: clientKey,
    phone: latest.phone || '',
    line: latest.line || '',
    timestamp: latest.timestamp,
    link: latest.link || '',
    quoLinksMarkdown: linksFromTouchpoints(items),
    touchpointCount: items.length,
    voiceCount: calls.length,
    smsCount: sms.length,
    duration: '',
    summary: '',
    transcript: '',
  };
}

/** @returns {object | null} */
function parseWeeklyClientBundleSentimentJson(rawText) {
  const stripped = stripMarkdownJsonFence(rawText);
  let obj;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const sentiment = String(obj.sentiment || '').toLowerCase();
  if (!ALLOWED_SENTIMENT.has(sentiment)) return null;
  const reason_summary =
    typeof obj.reason_summary === 'string' ? obj.reason_summary.trim() : '';
  const client_state =
    typeof obj.client_state === 'string' ? obj.client_state.trim() : '';
  if (!reason_summary || !client_state) return null;
  const reason_tags = normalizeReasonTags(obj.reason_tags);
  let bad_review_risk = String(obj.bad_review_risk || 'none').toLowerCase();
  if (!ALLOWED_REVIEW_RISK.has(bad_review_risk)) bad_review_risk = 'none';
  const bad_review_risk_note =
    typeof obj.bad_review_risk_note === 'string' ? obj.bad_review_risk_note.trim() : '';
  let positive_review_candidate = String(obj.positive_review_candidate || 'none').toLowerCase();
  if (!ALLOWED_POSITIVE_REVIEW.has(positive_review_candidate)) positive_review_candidate = 'none';
  const positive_review_note =
    typeof obj.positive_review_note === 'string' ? obj.positive_review_note.trim() : '';
  return {
    sentiment,
    reason_summary,
    reason_tags,
    client_state,
    bad_review_risk,
    bad_review_risk_note,
    positive_review_candidate,
    positive_review_note,
  };
}

async function analyzeWeeklyClientBundleWithLlm(clientKey, items, rangeLabel, attempt = 1) {
  const touchpointCount = items.length;
  const phone = (items.find((i) => i.phone)?.phone || '').trim();
  const bundleMd = buildCommunicationBundleMarkdown(items);
  const prompt = buildWeeklyClientBundleSentimentPrompt({
    COMPANY_NAME,
    clientName: clientKey,
    phone,
    rangeLabel,
    touchpointCount,
    communicationLogMarkdown: bundleMd,
  });
  const extraRetry =
    attempt > 1
      ? '\n\nYour previous answer failed validation. Reply with **only** one JSON object matching the schema; no markdown.'
      : '';
  const text = await runChatCompletion(
    prompt + extraRetry,
    OPENAI_SENTIMENT_MAX_TOKENS,
    `Sentiment bundle [${clientKey.slice(0, 28)}]`,
    { jsonObject: true, throwOnEmpty: true }
  );
  const parsed = parseWeeklyClientBundleSentimentJson(text);
  if (parsed) {
    return parsed;
  }
  if (attempt < 2) return analyzeWeeklyClientBundleWithLlm(clientKey, items, rangeLabel, attempt + 1);
  throw new Error('Invalid weekly bundle sentiment JSON after retry');
}

/** @returns {object | null} */
function normalizeMonthlyExtractionObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const key of MONTHLY_EXTRACTION_FIELDS) {
    const raw = obj[key];
    if (raw == null) {
      out[key] = [];
      continue;
    }
    if (typeof raw === 'string') {
      const t = raw.trim().replace(/\s+/g, ' ');
      out[key] = t && t.length <= 400 ? [t] : [];
      continue;
    }
    if (!Array.isArray(raw)) {
      out[key] = [];
      continue;
    }
    const arr = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const t = item.trim().replace(/\s+/g, ' ');
      if (t && t.length <= 400) arr.push(t);
    }
    out[key] = arr;
  }
  return out;
}

/**
 * OpenAI strict json_schema for batched monthly extraction — forces `extractions.length` and all seven keys per item.
 * @param {number} callCount
 */
function buildMonthlyBatchOpenAiJsonSchema(callCount) {
  const stringArray = { type: 'array', items: { type: 'string' } };
  const itemProperties = MONTHLY_EXTRACTION_FIELDS.reduce((acc, k) => {
    acc[k] = stringArray;
    return acc;
  }, {});
  const schema = {
    type: 'object',
    properties: {
      extractions: {
        type: 'array',
        items: {
          type: 'object',
          properties: itemProperties,
          required: [...MONTHLY_EXTRACTION_FIELDS],
          additionalProperties: false,
        },
        minItems: callCount,
        maxItems: callCount,
      },
    },
    required: ['extractions'],
    additionalProperties: false,
  };
  return {
    name: 'monthly_newsletter_batch_extractions',
    strict: true,
    schema,
  };
}

/** @returns {object | null} */
function parseAndValidateMonthlyExtractionJson(rawText) {
  const stripped = stripMarkdownJsonFence(rawText);
  let obj;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  return normalizeMonthlyExtractionObject(obj);
}

/** @returns {object[] | null} */
function parseAndValidateMonthlyBatchJson(rawText, expectedLen) {
  const stripped = stripMarkdownJsonFence(rawText);
  let root;
  try {
    root = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;
  let arr = root.extractions;
  if (!Array.isArray(arr)) return null;
  if (arr.length > expectedLen) arr = arr.slice(0, expectedLen);
  if (arr.length !== expectedLen) return null;
  const out = [];
  for (const el of arr) {
    const base = el && typeof el === 'object' ? el : {};
    const n = normalizeMonthlyExtractionObject(base);
    if (!n) return null;
    out.push(n);
  }
  return out;
}

function monthlyBatchCompletionTokenBudget(callCount) {
  if (OPENAI_MONTHLY_BATCH_MAX_COMPLETION_TOKENS && callCount > 1) {
    return Math.min(32000, OPENAI_MONTHLY_BATCH_MAX_COMPLETION_TOKENS);
  }
  return Math.min(32000, Math.max(OPENAI_MONTHLY_EXTRACTION_MAX_TOKENS, OPENAI_MONTHLY_EXTRACTION_MAX_TOKENS * callCount));
}

/**
 * One LLM call for several calls. On repeated parse failure, falls back to per-call extraction for that chunk.
 * @returns {Promise<(object | null)[]>}
 */
async function analyzeMonthlyBatchCalls(calls, transcriptMaxChars, attempt = 1) {
  const maxAttempts = 3;
  const items = calls.map((call) => ({
    callSegment: monthlyCallSegment(call.contact),
    line: call.line,
    timestamp: formatTimestamp(call.timestamp),
    summary: call.summary,
    transcript: String(call.transcript || '').trim(),
    link: call.link,
    transcriptMaxChars,
  }));
  const prompt = buildMonthlyBatchExtractionPrompt({ COMPANY_NAME, items });
  const extraRetry =
    attempt > 1
      ? `\n\nReply with only one JSON object: { "extractions": [ ... ] } with extractions.length === ${calls.length}, in Item order. Each element must include all seven keys as arrays of strings (use [] when empty).`
      : '';
  const budget = monthlyBatchCompletionTokenBudget(calls.length);
  const label = `Monthly batch extract (${calls.length} calls)`;

  let text;
  if (attempt === 1 && MONTHLY_BATCH_USE_JSON_SCHEMA) {
    try {
      text = await runChatCompletion(prompt + extraRetry, budget, label, {
        throwOnEmpty: true,
        strictResponseFormat: true,
        jsonSchema: buildMonthlyBatchOpenAiJsonSchema(calls.length),
      });
    } catch (err) {
      const hint = err.response?.data?.error?.message || err.message || String(err);
      console.warn(`  Monthly batch: structured JSON schema call failed (${hint.slice(0, 160)}). Retrying with json_object.`);
      text = await runChatCompletion(prompt + extraRetry, budget, label, { jsonObject: true, throwOnEmpty: true });
    }
  } else {
    text = await runChatCompletion(prompt + extraRetry, budget, label, { jsonObject: true, throwOnEmpty: true });
  }

  const parsed = parseAndValidateMonthlyBatchJson(text, calls.length);
  if (parsed) return parsed;
  if (attempt < maxAttempts) return analyzeMonthlyBatchCalls(calls, transcriptMaxChars, attempt + 1);

  console.log(`    batch invalid — per-call fallback for ${calls.length} row(s)`);
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const seg = monthlyCallSegment(call.contact);
    const n = calls.length;
    if (n > 1 && (i === 0 || (i + 1) % 10 === 0 || i === n - 1)) {
      console.log(`      per-call fallback ${i + 1}/${n} (sequential LLM; silence here is normal)`);
    }
    try {
      results.push(await analyzeOneTranscriptMonthly(call, seg));
    } catch (err) {
      console.log(`      ${err.message}`);
      results.push(null);
    }
    await sleep(SENTIMENT_LLM_DELAY_MS);
  }
  return results;
}

async function analyzeOneTranscriptMonthly(call, callSegment, attempt = 1) {
  const prompt = buildMonthlyTranscriptExtractionPrompt({
    COMPANY_NAME,
    callSegment,
    line: call.line,
    timestamp: formatTimestamp(call.timestamp),
    summary: call.summary,
    transcript: String(call.transcript || '').trim(),
    link: call.link,
  });
  const extraRetry =
    attempt > 1
      ? '\n\nYour previous answer was not valid JSON or failed validation. Reply with **only** one JSON object matching the schema; no markdown.'
      : '';
  const text = await runChatCompletion(
    prompt + extraRetry,
    OPENAI_MONTHLY_EXTRACTION_MAX_TOKENS,
    `Monthly newsletter extract [${callSegment}]`,
    { jsonObject: true, throwOnEmpty: true }
  );
  const parsed = parseAndValidateMonthlyExtractionJson(text);
  if (parsed) return parsed;
  if (attempt < 2) return analyzeOneTranscriptMonthly(call, callSegment, attempt + 1);
  throw new Error('Invalid monthly extraction JSON after retry');
}

/**
 * One chunk (1+ calls) → row objects for the monthly pool. Used alone or inside parallel waves.
 * @returns {Promise<{ ok: boolean, outRows: object[], itemCount: number, error?: string }>}
 */
async function extractOneMonthlyChunk(chunk, batchTranscriptCap) {
  try {
    let extractions;
    if (chunk.length === 1) {
      const c0 = chunk[0];
      extractions = [await analyzeOneTranscriptMonthly(c0, monthlyCallSegment(c0.contact))];
    } else {
      extractions = await analyzeMonthlyBatchCalls(chunk, batchTranscriptCap);
    }
    const outRows = [];
    let itemCount = 0;
    for (let j = 0; j < chunk.length; j++) {
      const call = chunk[j];
      const callSegment = monthlyCallSegment(call.contact);
      const extraction = extractions[j] ?? null;
      outRows.push({ call, callSegment, extraction });
      if (extraction) {
        itemCount += MONTHLY_EXTRACTION_FIELDS.reduce((s, k) => s + (extraction[k]?.length || 0), 0);
      }
    }
    return { ok: true, outRows, itemCount };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || String(err);
    const outRows = chunk.map((call) => ({
      call,
      callSegment: monthlyCallSegment(call.contact),
      extraction: null,
    }));
    return { ok: false, outRows, itemCount: 0, error: msg };
  }
}

/**
 * Pool all extractions by theme — **no per-caller headers** (internal newsletter planning only).
 */
function buildMonthlyRawExtractionsMarkdown(rows, maxForDigest) {
  const ok = rows.filter((r) => r.extraction);
  let list = ok;
  let omitted = 0;
  if (maxForDigest > 0 && ok.length > maxForDigest) {
    omitted = ok.length - maxForDigest;
    list = ok.slice(0, maxForDigest);
  }

  const byField = {};
  for (const k of MONTHLY_EXTRACTION_FIELDS) byField[k] = [];

  for (const r of list) {
    const ex = r.extraction;
    const seg = r.callSegment === 'client' ? 'client' : 'lead_or_other';
    for (const k of MONTHLY_EXTRACTION_FIELDS) {
      for (const item of ex[k] || []) {
        const t = String(item)
          .trim()
          .replace(/\s+/g, ' ')
          .replace(/\*\*/g, '');
        if (!t) continue;
        byField[k].push({ seg, t });
      }
    }
  }

  const parts = [];
  for (const k of MONTHLY_EXTRACTION_FIELDS) {
    const items = byField[k];
    if (!items.length) {
      parts.push(`## ${k}\n\n_(none)_`);
      continue;
    }
    const bullets = items.map(({ seg, t }) => `- _[${seg}]_ ${t}`).join('\n');
    parts.push(`## ${k}\n\n${bullets}`);
  }

  let out = parts.join('\n\n---\n\n');
  if (omitted > 0) {
    out += `\n\n_(${omitted} more call extractions omitted from this pool — increase MONTHLY_AGGREGATE_DIGEST_MAX_TRANSCRIPTS if needed.)_`;
  }
  return out || '_(No successful extractions.)_';
}

async function generateMonthlyNewsletterEmailMarkdown(
  rangeLabel,
  transcriptCount,
  clientCount,
  leadCount,
  rawMd
) {
  const prompt = buildMonthlyNewsletterAggregationPrompt({
    COMPANY_NAME,
    rangeLabel,
    transcriptCount,
    clientTranscriptCount: clientCount,
    leadOrOtherTranscriptCount: leadCount,
    rawExtractionsMarkdown: rawMd,
  });
  return runChatCompletion(
    prompt,
    OPENAI_MONTHLY_AGGREGATE_MAX_TOKENS,
    'Monthly newsletter aggregate',
    { throwOnEmpty: false }
  );
}

function buildMonthlyInsightsEmailHtml(markdownBody, rangeLabel) {
  const inner = markdownBody.trim()
    ? markdownToHtml(markdownBody)
    : '<p><em>(No analysis body.)</em></p>';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:24px;color:#333;background:#f5f5f5">
  <div style="background:#1a1a2e;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px;letter-spacing:.3px">Monthly client newsletter content ideas</h1>
    <p style="margin:6px 0 0;opacity:.85;font-size:13px">${COMPANY_NAME} · ${rangeLabel}</p>
  </div>
  <div style="background:#fff;padding:16px 32px 32px;border:1px solid #e0e0e0;border-top:3px solid #0d9488;border-radius:0 0 8px 8px;line-height:1.75">
    ${inner}
  </div>
  <p style="font-size:11px;color:#aaa;text-align:center;margin-top:16px">
    Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}
  </p>
</body>
</html>`;
}

function pct(n, d) {
  if (!d) return '0';
  return ((100 * n) / d).toFixed(1);
}

function aggregateSentimentResults(rows) {
  const ok = rows.filter((r) => r.analysis);
  const total = ok.length;
  const counts = { positive: 0, neutral: 0, negative: 0 };
  const tagCounts = {};
  const reasonSummaries = [];
  const clientStates = [];

  for (const { analysis: a } of ok) {
    counts[a.sentiment]++;
    for (const t of a.reason_tags) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    reasonSummaries.push(a.reason_summary);
    clientStates.push(a.client_state);
  }

  const tagRanked = Object.entries(tagCounts)
    .sort((x, y) => y[1] - x[1])
    .map(([tag, count]) => ({ tag, count }));

  return {
    total,
    counts,
    pctPositive: pct(counts.positive, total),
    pctNeutral: pct(counts.neutral, total),
    pctNegative: pct(counts.negative, total),
    tagRanked,
    reasonSummaries,
    clientStates,
    rows: ok,
  };
}

function callTimeMs(call) {
  const t = call.timestamp;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Group successful rows by CRM contact (case-number name); newest call first per group. */
function groupRowsByClient(rows) {
  const ok = rows.filter((r) => r.analysis);
  const map = new Map();
  for (const r of ok) {
    const key = (r.call.contact || '').trim() || r.call.phone || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  for (const list of map.values()) {
    list.sort((a, b) => callTimeMs(b.call) - callTimeMs(a.call));
  }
  return map;
}

/** Human-readable rollup when a client had multiple calls with different sentiments. */
function clientOverallLabel(counts) {
  const p = counts.positive;
  const n = counts.neutral;
  const neg = counts.negative;
  const types = [p > 0, n > 0, neg > 0].filter(Boolean).length;
  if (types <= 1) {
    if (neg > 0) return 'Negative';
    if (n > 0) return 'Neutral';
    return 'Positive';
  }
  const parts = [];
  if (p) parts.push(`${p} pos`);
  if (n) parts.push(`${n} neu`);
  if (neg) parts.push(`${neg} neg`);
  return `Mixed (${parts.join(', ')})`;
}

/** Lower = needs attention first: any negative → mixed (no neg) → neutral-only → positive-only */
function clientSortTier(counts) {
  const p = counts.positive;
  const n = counts.neutral;
  const neg = counts.negative;
  if (neg > 0) return 0;
  const variety = [p > 0, n > 0].filter(Boolean).length;
  if (variety >= 2) return 1;
  if (n > 0 && !p) return 2;
  return 3;
}

/** Single-line text for table cells (no pipes / runs of spaces). */
function normalizeTableText(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/\|/g, '·')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * If over hardMax, trim to the last full sentence still inside the limit; else last word boundary + ellipsis.
 * Avoids hard character cuts mid-clause when possible.
 */
function clipToCompleteThought(s, hardMax = 520) {
  const t = normalizeTableText(s);
  if (!t) return '—';
  if (t.length <= hardMax) return t;
  const slice = t.slice(0, hardMax);
  const minKeep = Math.floor(hardMax * 0.42);
  for (let i = slice.length - 1; i >= minKeep; i--) {
    const ch = slice[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      const rest = slice[i + 1];
      if (rest === undefined || /\s/.test(rest)) {
        return slice.slice(0, i + 1).trim();
      }
    }
  }
  const sp = slice.lastIndexOf(' ', Math.floor(hardMax * 0.94));
  if (sp > 36) return `${slice.slice(0, sp).trim()}…`;
  return `${slice.trim()}…`;
}

/** Rough 1–10 engagement / stability score (derived; not from LLM). */
function rollupEngagementScore(r) {
  let s = 5;
  const sent = String(r.holisticSentiment || 'neutral').toLowerCase();
  if (sent === 'positive') s += 3;
  else if (sent === 'negative') s -= 3;
  const risk = String(r.badReviewRisk || 'none').toLowerCase();
  if (risk === 'high') s -= 4;
  else if (risk === 'moderate') s -= 2;
  else if (risk === 'low') s -= 1;
  const pr = String(r.positiveReview || 'none').toLowerCase();
  if (pr === 'strong') s += 2;
  else if (pr === 'possible') s += 1;
  return Math.max(1, Math.min(10, s));
}

function buildClientRollup(clientKey, rows) {
  const analyses = rows.map((r) => r.analysis);
  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const a of analyses) counts[a.sentiment]++;

  const tagFreq = {};
  for (const a of analyses) {
    for (const t of a.reason_tags) {
      tagFreq[t] = (tagFreq[t] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag, c]) => (c > 1 ? `${tag}×${c}` : tag))
    .join(', ');

  const latest = rows[0];
  const oldest = rows[rows.length - 1];
  let summary = latest.analysis.reason_summary;
  if (rows.length > 1) {
    summary = `**Latest:** ${latest.analysis.reason_summary}`;
    if (oldest !== latest && oldest.analysis.reason_summary !== latest.analysis.reason_summary) {
      summary += ` **Earlier:** ${oldest.analysis.reason_summary}`;
    }
  }

  let state = latest.analysis.client_state;
  if (rows.length > 1 && oldest.analysis.client_state !== latest.analysis.client_state) {
    state = `**Now:** ${latest.analysis.client_state} **Earlier:** ${oldest.analysis.client_state}`;
  }

  const touchCount =
    typeof latest.call.touchpointCount === 'number' && latest.call.touchpointCount > 0
      ? latest.call.touchpointCount
      : rows.length;

  const links =
    latest.call.quoLinksMarkdown ||
    rows
      .map((r) => {
        const label = formatTimestamp(r.call.timestamp) || 'call';
        return r.call.link ? `[${label}](${r.call.link})` : '—';
      })
      .join(', ');

  const br = latest.analysis?.bad_review_risk;
  const brNote = latest.analysis?.bad_review_risk_note || '';
  const pr = latest.analysis?.positive_review_candidate;
  const prNote = latest.analysis?.positive_review_note || '';
  const holisticSentiment = String(latest.analysis?.sentiment || 'neutral').toLowerCase();

  const statePlain = stripMarkdownBold(String(state || ''));
  const summaryPlain = stripMarkdownBold(String(summary || ''));
  const statusText = normalizeTableText(statePlain) || '—';
  const brl = String(br || 'none').toLowerCase();
  const prl = String(pr || 'none').toLowerCase();
  const nextSource =
    (brl === 'high' || brl === 'moderate') && brNote
      ? brNote
      : (prl === 'strong' || prl === 'possible') && prNote
        ? prNote
        : summaryPlain;
  const nextActionText = normalizeTableText(nextSource) || '—';

  const roll = {
    clientKey,
    callCount: touchCount,
    counts,
    overallLabel: clientOverallLabel(counts),
    sortTier: clientSortTier(counts),
    topTags: topTags || '—',
    summary,
    state,
    links: links || '—',
    badReviewRisk: br ? String(br) : 'none',
    badReviewNote: brNote,
    positiveReview: pr ? String(pr) : 'none',
    positiveReviewNote: prNote,
    holisticSentiment,
    statusText,
    nextActionText,
  };
  roll.score = rollupEngagementScore(roll);
  return roll;
}

function reviewRiskPriority(risk) {
  switch (String(risk || '').toLowerCase()) {
    case 'high':
      return 0;
    case 'moderate':
      return 1;
    case 'low':
      return 2;
    default:
      return 3;
  }
}

function buildAllClientRollups(rows) {
  const map = groupRowsByClient(rows);
  const rollups = [...map.entries()].map(([key, rs]) => buildClientRollup(key, rs));
  rollups.sort((a, b) => {
    const rp = reviewRiskPriority(a.badReviewRisk) - reviewRiskPriority(b.badReviewRisk);
    if (rp !== 0) return rp;
    if (a.sortTier !== b.sortTier) return a.sortTier - b.sortTier;
    return a.clientKey.localeCompare(b.clientKey, undefined, { sensitivity: 'base' });
  });
  return rollups;
}

/** Markdown cell: no pipes/newlines that break table layout */
function mdTableCell(s, maxLen = 200) {
  if (s == null || s === '') return '—';
  let t = String(s)
    .replace(/\|/g, '·')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > maxLen) t = `${t.slice(0, maxLen - 1)}…`;
  return t;
}

function weeklySentimentWord(s) {
  const x = String(s || 'neutral').toLowerCase();
  if (x === 'positive') return 'Positive';
  if (x === 'negative') return 'Negative';
  return 'Neutral';
}

function buildClientDetailTableMarkdown(rollups) {
  if (!rollups.length) {
    return '_No clients with successful sentiment analysis in this window._';
  }
  const header =
    '| Client (n) | Attorney | Paralegal | Sentiment | Score | Status | Next action | Evidence (Quo) |\n' +
    '|-------------|:---------|:------------|:----------|------:|:-------|:------------|:---------------|';
  const lines = rollups.map((r) => {
    const sent = weeklySentimentWord(r.holisticSentiment);
    const ev = mdTableCell(r.links.replace(/\[[^\]]+\]/g, '[link]'), 140);
    const st = clipToCompleteThought(r.statusText, 560).replace(/\|/g, '·');
    const nx = clipToCompleteThought(r.nextActionText, 560).replace(/\|/g, '·');
    const att = mdTableCell(r.leadAttorney || '—', 28);
    const par = mdTableCell(r.paralegal || '—', 28);
    return `| ${mdTableCell(`${r.clientKey} (${r.callCount})`, 90)} | ${att} | ${par} | ${sent} | ${r.score} | ${st} | ${nx} | ${ev} |`;
  });
  return [header, ...lines].join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownLinksToHtml(s) {
  if (s == null || s === '' || s === '—') return '—';
  const str = String(s);
  if (!/\[[^\]]*\]\(https?:[^)\s]+\)/.test(str)) return escapeHtml(str);
  return str.replace(
    /\[([^\]]*)\]\((https?:[^)\s]+)\)/g,
    (_, text, href) =>
      `<a href="${escapeHtml(href)}" style="color:#7c3aed;font-weight:600;text-decoration:none" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
  );
}

/** Strip ** for plain table cells (HTML). */
function stripMarkdownBold(s) {
  return String(s || '').replace(/\*\*/g, '');
}

const CLIENT_TABLE_FONT =
  'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

function formatSentimentLabelHtml(sentiment) {
  const s = String(sentiment || '').toLowerCase();
  if (s === 'positive') {
    return '<span style="font-size:13px"><strong style="color:#15803d">Positive</strong></span>';
  }
  if (s === 'negative') {
    return '<span style="font-size:13px"><strong style="color:#b91c1c">Negative</strong></span>';
  }
  return '<span style="font-size:13px"><strong style="color:#0f172a">Neutral</strong></span>';
}

/** Short clickable Quo links (V1, V2, SMS) — avoids long timestamps in the cell. */
function buildCompactEvidenceLinksHtml(markdownSrc, maxLinks = 8) {
  if (!markdownSrc || markdownSrc === '—') return '—';
  const re = /\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g;
  const hits = [];
  let m;
  while ((m = re.exec(markdownSrc)) !== null) {
    hits.push({ label: m[1], href: m[2] });
  }
  if (!hits.length) return escapeHtml(mdTableCell(markdownSrc, 48));
  let v = 0;
  const parts = hits.slice(0, maxLinks).map((h) => {
    const isSms = /sms/i.test(h.label);
    const label = isSms ? 'SMS' : `V${++v}`;
    return `<a href="${escapeHtml(h.href)}" style="display:inline-block;margin:2px 6px 2px 0;padding:3px 8px;border-radius:6px;background:#f3e8ff;color:#5b21b6;font-weight:700;font-size:12px;text-decoration:none" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  });
  return parts.join('');
}

function buildClientRollupTableHtml(rollups) {
  if (!rollups.length) {
    return '<p style="font-family:' + CLIENT_TABLE_FONT + '"><em>No clients in table.</em></p>';
  }
  const tdBase = `padding:8px 10px;border:1px solid #e4e4e7;font-size:12px;font-family:${CLIENT_TABLE_FONT};vertical-align:top;line-height:1.45;color:#27272a`;
  const thStyle = `${tdBase};background:#f4f4f5;font-weight:700;color:#18181b;font-size:11px;text-transform:uppercase;letter-spacing:0.04em`;
  const legend =
    `<div style="font-size:12px;color:#475569;margin:0 0 12px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-family:${CLIENT_TABLE_FONT};line-height:1.5">` +
    `<strong>Sentiment:</strong> <span style="color:#15803d;font-weight:600">Positive</span> · ` +
    `<span style="color:#0f172a;font-weight:600">Neutral</span> · ` +
    `<span style="color:#b91c1c;font-weight:600">Negative</span></div>`;

  const rows = rollups
    .map((r, i) => {
      const rowBg = i % 2 === 0 ? '#ffffff' : '#fafafa';
      const clientCell = `<strong>${escapeHtml(r.clientKey)}</strong><div style="font-size:11px;color:#64748b;font-weight:600;margin-top:3px">${r.callCount} tp</div>`;
      const att = escapeHtml(mdTableCell(r.leadAttorney || '—', 120));
      const par = escapeHtml(mdTableCell(r.paralegal || '—', 120));
      const status = escapeHtml(clipToCompleteThought(r.statusText, 560));
      const next = escapeHtml(clipToCompleteThought(r.nextActionText, 560));
      const evidence = buildCompactEvidenceLinksHtml(r.links);
      return `<tr style="background:${rowBg}">
  <td style="${tdBase}">${clientCell}</td>
  <td style="${tdBase}">${att}</td>
  <td style="${tdBase}">${par}</td>
  <td style="${tdBase};white-space:nowrap">${formatSentimentLabelHtml(r.holisticSentiment)}</td>
  <td style="${tdBase};text-align:center;font-weight:800;font-size:15px;color:#1e293b">${r.score}</td>
  <td style="${tdBase}">${status}</td>
  <td style="${tdBase}">${next}</td>
  <td style="${tdBase}">${evidence}</td>
</tr>`;
    })
    .join('\n');

  return (
    legend +
    `<table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 8px;border:1px solid #e4e4e7;font-family:${CLIENT_TABLE_FONT}">
<thead>
<tr>
  <th style="${thStyle};text-align:left">Client</th>
  <th style="${thStyle};text-align:left;width:110px">Attorney</th>
  <th style="${thStyle};text-align:left;width:110px">Paralegal</th>
  <th style="${thStyle};text-align:left;width:92px">Sentiment</th>
  <th style="${thStyle};text-align:center;width:44px">Score</th>
  <th style="${thStyle};text-align:left">Status</th>
  <th style="${thStyle};text-align:left">Next action</th>
  <th style="${thStyle};text-align:left">Evidence</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`
  );
}

function weeklyNegativeCohortDisplay(cohort) {
  if (cohort === 'carryover_prior_7d') return 'Prior 7 days (carryover)';
  return 'Current 7 days';
}

function buildWeeklyNegativeDetailTableMarkdown(rollups) {
  if (!rollups.length) {
    return '_No negative clients in this email._';
  }
  const header =
    '| Period | Client (n) | Attorney | Paralegal | Sentiment | Score | Status | Next action | Evidence (Quo) |\n' +
    '|:-------|-------------|:---------|:------------|:----------|------:|:-------|:------------|:---------------|';
  const lines = rollups.map((r) => {
    const period = mdTableCell(weeklyNegativeCohortDisplay(r._weeklyEmailCohort || 'current_7d'), 36);
    const sent = weeklySentimentWord(r.holisticSentiment);
    const ev = mdTableCell(r.links.replace(/\[[^\]]+\]/g, '[link]'), 140);
    const st = clipToCompleteThought(r.statusText, 560).replace(/\|/g, '·');
    const nx = clipToCompleteThought(r.nextActionText, 560).replace(/\|/g, '·');
    const att = mdTableCell(r.leadAttorney || '—', 28);
    const par = mdTableCell(r.paralegal || '—', 28);
    return `| ${period} | ${mdTableCell(`${r.clientKey} (${r.callCount})`, 90)} | ${att} | ${par} | ${sent} | ${r.score} | ${st} | ${nx} | ${ev} |`;
  });
  return [header, ...lines].join('\n');
}

function buildWeeklyNegativeRollupTableHtml(rollups) {
  if (!rollups.length) {
    return '<p style="font-family:' + CLIENT_TABLE_FONT + '"><em>No negative clients.</em></p>';
  }
  const tdBase = `padding:8px 10px;border:1px solid #e4e4e7;font-size:12px;font-family:${CLIENT_TABLE_FONT};vertical-align:top;line-height:1.45;color:#27272a`;
  const thStyle = `${tdBase};background:#f4f4f5;font-weight:700;color:#18181b;font-size:11px;text-transform:uppercase;letter-spacing:0.04em`;
  const note =
    `<p style="font-size:13px;color:#475569;margin:0 0 14px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-family:${CLIENT_TABLE_FONT};line-height:1.55">` +
    `<strong>Negative sentiment only.</strong> ` +
    `<strong style="color:#0f172a">Current 7 days</strong> = analyzed this run. ` +
    `<strong style="color:#9a3412">Prior 7 days (carryover)</strong> = still negative from the prior week with no touchpoints in the current window.</p>`;

  const rows = rollups
    .map((r, i) => {
      const rowBg = i % 2 === 0 ? '#ffffff' : '#fafafa';
      const cohort = r._weeklyEmailCohort || 'current_7d';
      const periodLabel = weeklyNegativeCohortDisplay(cohort);
      const periodStyle =
        cohort === 'carryover_prior_7d'
          ? 'background:#ffedd5;color:#9a3412;font-weight:700;font-size:11px;padding:4px 8px;border-radius:6px;white-space:normal'
          : 'background:#e2e8f0;color:#334155;font-weight:700;font-size:11px;padding:4px 8px;border-radius:6px;white-space:normal';
      const clientCell = `<strong>${escapeHtml(r.clientKey)}</strong><div style="font-size:11px;color:#64748b;font-weight:600;margin-top:3px">${r.callCount} tp</div>`;
      const att = escapeHtml(mdTableCell(r.leadAttorney || '—', 120));
      const par = escapeHtml(mdTableCell(r.paralegal || '—', 120));
      const status = escapeHtml(clipToCompleteThought(r.statusText, 560));
      const next = escapeHtml(clipToCompleteThought(r.nextActionText, 560));
      const evidence = buildCompactEvidenceLinksHtml(r.links);
      return `<tr style="background:${rowBg}">
  <td style="${tdBase}"><span style="${periodStyle}">${escapeHtml(periodLabel)}</span></td>
  <td style="${tdBase}">${clientCell}</td>
  <td style="${tdBase}">${att}</td>
  <td style="${tdBase}">${par}</td>
  <td style="${tdBase};white-space:nowrap">${formatSentimentLabelHtml(r.holisticSentiment)}</td>
  <td style="${tdBase};text-align:center;font-weight:800;font-size:15px;color:#1e293b">${r.score}</td>
  <td style="${tdBase}">${status}</td>
  <td style="${tdBase}">${next}</td>
  <td style="${tdBase}">${evidence}</td>
</tr>`;
    })
    .join('\n');

  return (
    note +
    `<table role="presentation" style="width:100%;border-collapse:collapse;margin:4px 0 8px;border:1px solid #e4e4e7;font-family:${CLIENT_TABLE_FONT}">
<thead>
<tr>
  <th style="${thStyle};text-align:left;width:120px">Period</th>
  <th style="${thStyle};text-align:left">Client</th>
  <th style="${thStyle};text-align:left;width:110px">Attorney</th>
  <th style="${thStyle};text-align:left;width:110px">Paralegal</th>
  <th style="${thStyle};text-align:left;width:92px">Sentiment</th>
  <th style="${thStyle};text-align:center;width:44px">Score</th>
  <th style="${thStyle};text-align:left">Status</th>
  <th style="${thStyle};text-align:left">Next action</th>
  <th style="${thStyle};text-align:left">Evidence</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`
  );
}

function buildWeeklyNegativeEmailMarkdown(rangeLabel, rollups) {
  const win = `_${rangeLabel}_`;
  if (!rollups.length) {
    return ['## Weekly client negative sentiment', '', win, '', '_No negative client sentiment this week (and no carryover rows)._'].join('\n');
  }
  const intro =
    'This email lists **negative** client sentiment only. ' +
    '**Current 7 days** rows were judged from the latest window; **Prior 7 days (carryover)** are negatives from the previous week who had no touchpoints in the current window.';
  return ['## Weekly client negative sentiment', '', win, '', intro, '', buildWeeklyNegativeDetailTableMarkdown(rollups)].join('\n');
}

function buildWeeklyNegativeSentimentEmailHtml(rangeLabel, rollups) {
  const bodyFont =
    'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const inner = rollups?.length
    ? `<h2 style="color:#1a1a2e;margin:0 0 8px;font-size:17px;font-family:${CLIENT_TABLE_FONT}">Negative clients</h2>` +
      buildWeeklyNegativeRollupTableHtml(rollups)
    : `<p style="color:#525252;font-family:${bodyFont}">No negative client sentiment this week (and no carryover rows).</p>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:${bodyFont};max-width:700px;margin:0 auto;padding:24px;color:#27272a;background:#f5f5f5">
  <div style="background:#1a1a2e;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px;letter-spacing:.3px">Weekly client negative sentiment</h1>
    <p style="margin:6px 0 0;opacity:.85;font-size:13px">${COMPANY_NAME} · ${escapeHtml(rangeLabel)}</p>
  </div>
  <div style="background:#fff;padding:16px 32px 32px;border:1px solid #e0e0e0;border-top:3px solid #7c3aed;border-radius:0 0 8px 8px;line-height:1.75;font-family:${bodyFont};font-size:14px">
    ${inner}
  </div>
  <p style="font-size:11px;color:#aaa;text-align:center;margin-top:16px;font-family:${bodyFont}">
    Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}
  </p>
</body>
</html>`;
}

/** Compact per-client digest for the narrative LLM (not per transcript). */
function buildClientRollupsDigest(rollups, maxClients = 60) {
  if (!rollups.length) return '_(No clients.)_';
  const slice = rollups.slice(0, maxClients);
  return slice
    .map((r, i) => {
      const staff =
        r.leadAttorney || r.paralegal
          ? `\n- **Attorney / paralegal:** ${[r.leadAttorney, r.paralegal].filter(Boolean).join(' · ') || '—'}`
          : '';
      return [
        `### ${i + 1}. ${r.clientKey} (${r.callCount} call${r.callCount === 1 ? '' : 's'})`,
        `- **Overall:** ${r.overallLabel}`,
        `- **Tags:** ${r.topTags}`,
        `- **Summary:** ${r.summary.replace(/\*\*/g, '')}`,
        `- **Client seemed:** ${r.state.replace(/\*\*/g, '')}` + staff,
      ].join('\n');
    })
    .join('\n\n');
}

function buildHardFactsMarkdown(agg, zeroNote) {
  if (agg.total === 0) {
    return [
      '- Total **clients** analyzed (holistic, 7-day window): **0**',
      zeroNote ||
        '- No client touchpoints matched the client naming pattern in this window.',
    ].join('\n');
  }
  return [
    `- Total **clients** analyzed (holistic, 7-day window): **${agg.total}**`,
    `- **Positive:** ${agg.counts.positive} (${agg.pctPositive}%)`,
    `- **Neutral:** ${agg.counts.neutral} (${agg.pctNeutral}%)`,
    `- **Negative:** ${agg.counts.negative} (${agg.pctNegative}%)`,
    `- **Most common reason_tags:** ${agg.tagRanked.length ? agg.tagRanked.map((t) => `\`${t.tag}\`×${t.count}`).join(', ') : '_(none)_'}`,
  ].join('\n');
}

function buildAnalysesDigest(agg, maxLines = 80) {
  if (agg.total === 0) return '_(No transcripts.)_';
  const lines = agg.rows.slice(0, maxLines).map(({ call, analysis: a }, i) => {
    const name = (call.contact || '').trim() || call.phone || `call ${i + 1}`;
    return [
      `### ${i + 1}. ${name}`,
      `- sentiment: **${a.sentiment}**`,
      `- reason_tags: ${a.reason_tags.length ? a.reason_tags.join(', ') : '_(none)_'}`,
      `- reason_summary: ${a.reason_summary}`,
      `- client_state: ${a.client_state}`,
    ].join('\n');
  });
  let out = lines.join('\n\n');
  if (agg.rows.length > maxLines) {
    out += `\n\n_…and ${agg.rows.length - maxLines} more (omitted to save tokens; counts above are complete)._`;
  }
  return out;
}

async function generateDailyLeadReportAnalysis(
  callData,
  totalCalls,
  createdAfter,
  slackText,
  sheetText,
  reportRangeLabel,
  slackMessageCount,
  sheetRowCount
) {
  const prompt = generateDailyLeadReportPrompt({
    COMPANY_NAME,
    dateLabel: formatDateLabel(createdAfter),
    dayOfWeek: formatDayOfWeek(createdAfter),
    reportRangeLabel,
    slackMessageCount,
    sheetRowCount,
    callData,
    totalCalls,
    summaryLinesOnly: buildCallSummaryOnlyLines(callData),
    slackMessages: slackText,
    leadPipeline: sheetText,
  });

  return runChatCompletion(prompt, OPENAI_LEAD_REPORT_MAX_TOKENS, 'Daily Intake & Lead Report');
}

// ── Email ─────────────────────────────────────────────────────────────────────

function markdownToHtml(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" style="color:#0f766e;font-weight:700;text-decoration:none;border-bottom:1px solid #99f6e4" target="_blank">$1</a>'
    )
    .replace(
      /^## (.+)$/gm,
      '<h2 style="color:#0f172a;margin:28px 0 10px;font-size:15px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid #e2e8f0;padding-bottom:6px;font-weight:800">$1</h2>'
    )
    .replace(
      /^### (.+)$/gm,
      '<h3 style="color:#1e293b;margin:14px 0 6px;font-size:15px;font-weight:700">$1</h3>'
    )
    .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
    .replace(/^(\d+)\. (.+)$/gm, '<li style="margin:5px 0;line-height:1.5">$2</li>')
    .replace(/^[-•] (.+)$/gm,    '<li style="margin:5px 0;line-height:1.5">$1</li>')
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, (m) =>
      `<ul style="margin:8px 0 12px;padding-left:20px">${m}</ul>`)
    .replace(/\|(.+)\|/g, (row) => {
      const cells = row.split('|').filter(Boolean);
      const isHeader = cells.some((c) => /^\s*-+\s*$/.test(c));
      if (isHeader) return '';
      const tag = cells[0]?.trim().match(/^[A-Z]/) ? 'th' : 'td';
      return '<tr>' + cells.map((c) =>
        `<${tag} style="padding:7px 10px;border:1px solid #e2e8f0;text-align:left;vertical-align:top;line-height:1.45">${c.trim()}</${tag}>`
      ).join('') + '</tr>';
    })
    .replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (m) =>
      `<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">${m}</table>`)
    .replace(/\n{2,}/g, '</p><p style="margin:10px 0;line-height:1.65">')
    .replace(/\n/g, '<br>');
}

function buildEmailHtml(analysis, stats, dateLabel) {
  const totalMinHr = stats.totalMinutes >= 60
    ? `${Math.floor(stats.totalMinutes / 60)}h ${stats.totalMinutes % 60}m`
    : `${stats.totalMinutes}m`;
  const title = '📌 Daily Intake & Lead Report';
  const emojiBar = '#0d9488';

  const sheetShown =
    stats.sheetRows != null && Number.isFinite(stats.sheetRows)
      ? String(stats.sheetRows)
      : '—';

  const metricsRow = `<table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:12px 14px;background:#f0fdfa;border-radius:6px;text-align:center;border:1px solid #99f6e4">
          <div style="font-size:11px;color:#0f766e;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Total calls</div>
          <div style="font-size:26px;font-weight:bold;color:#134e4a">${stats.totalFetched}</div>
          <div style="font-size:11px;color:#666">Quo window</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#fffbeb;border-radius:6px;text-align:center;border:1px solid #fde68a">
          <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Transcripts analyzed</div>
          <div style="font-size:26px;font-weight:bold;color:#78350f">${stats.totalSaved}</div>
          <div style="font-size:11px;color:#666">with summaries/transcripts</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#faf5ff;border-radius:6px;text-align:center;border:1px solid #e9d5ff">
          <div style="font-size:11px;color:#6b21a8;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Talk time</div>
          <div style="font-size:26px;font-weight:bold;color:#581c87">${totalMinHr}</div>
          <div style="font-size:11px;color:#666">connected minutes</div>
        </td>
      </tr>
      <tr><td style="height:10px"></td></tr>
      <tr>
        <td style="padding:12px 14px;background:#fff7ed;border-radius:6px;text-align:center;border:1px solid #fed7aa">
          <div style="font-size:11px;color:#9a3412;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Slack lead messages</div>
          <div style="font-size:26px;font-weight:bold;color:#7c2d12">${stats.slackMessages ?? '—'}</div>
          <div style="font-size:11px;color:#666">#lead-calls in window</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#eef2ff;border-radius:6px;text-align:center;border:1px solid #c7d2fe">
          <div style="font-size:11px;color:#3730a3;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Pipeline rows</div>
          <div style="font-size:26px;font-weight:bold;color:#581c87">${sheetShown}</div>
          <div style="font-size:11px;color:#666">pipeline rows</div>
        </td>
        <td style="width:10px"></td>
        <td style="padding:12px 14px;background:#f8fafc;border-radius:6px;text-align:center;border:1px solid #e2e8f0">
          <div style="font-size:11px;color:#0f172a;text-transform:uppercase;letter-spacing:.5px;font-weight:bold">Window</div>
          <div style="font-size:18px;font-weight:bold;color:#0f172a">${dateLabel}</div>
          <div style="font-size:11px;color:#666">daily snapshot</div>
        </td>
      </tr>
    </table>`;

  const footerNote = `Quo transcript CSV attached &nbsp;·&nbsp; Weekly client sentiment is emailed separately &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#1f2937;background:#f3f6fb">
  <div style="background:#1a1a2e;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:22px;letter-spacing:.2px;font-weight:800">${title}</h1>
    <p style="margin:8px 0 0;opacity:.86;font-size:13px">${COMPANY_NAME} · ${dateLabel}</p>
  </div>
  <div style="background:#fff;padding:16px 32px 12px;border:1px solid #e0e0e0;border-top:3px solid ${emojiBar}">
    ${metricsRow}
  </div>
  <div style="background:#fff;padding:16px 32px 32px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;line-height:1.68">
    <div style="margin:0 0 14px;padding:10px 12px;border:1px solid #dbeafe;background:#f8fbff;border-radius:8px;color:#334155;font-size:13px">
      Executive + operational intake brief across <strong>Quo</strong>, <strong>Slack</strong>, and <strong>Google Sheets</strong>.
    </div>
    <div style="margin:0;font-size:14px">${analysis.trim() ? markdownToHtml(analysis) : '<p><em>(No analysis body — check console warning from OpenAI step.)</em></p>'}</div>
  </div>
  <p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:16px">
    ${footerNote}
  </p>
</body>
</html>`;
}

async function sendEmail({ htmlBody, plainText, subject, attachments = [], to }) {
  const recipients = (Array.isArray(to) && to.length ? to : EMAIL_TO).join(', ');
  const mail = {
    from: EMAIL_FROM,
    to: recipients,
    subject,
    text: plainText,
    html: htmlBody,
  };
  if (attachments.length) mail.attachments = attachments;

  const raw = await new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });

  const encodedMessage = raw
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const gmail = google.gmail({ version: 'v1', auth: makeAuthClient() });
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });
}

// ── Monthly client newsletter content (30-day window, batched JSON → pooled brief) ─

async function runMonthlyNewsletterInsightsReport() {
  const { createdAfter, createdBefore } = getTrailing30DaysRange();
  const rangeLabel = buildMonthly30DayRangeLabel(createdAfter, createdBefore);
  const processCap = parseInt(process.env.MONTHLY_MAX_TRANSCRIPTS_TO_PROCESS || '0', 10);
  const digestCap = parseInt(process.env.MONTHLY_AGGREGATE_DIGEST_MAX_TRANSCRIPTS || '200', 10);
  let monthlyBatchSize = parseInt(process.env.MONTHLY_EXTRACTION_BATCH_SIZE ?? '40', 10);
  if (!Number.isFinite(monthlyBatchSize) || monthlyBatchSize < 1) monthlyBatchSize = 40;
  monthlyBatchSize = Math.min(60, monthlyBatchSize);
  let monthlyConcurrency = parseInt(process.env.MONTHLY_EXTRACTION_CONCURRENCY ?? '3', 10);
  if (!Number.isFinite(monthlyConcurrency) || monthlyConcurrency < 1) monthlyConcurrency = 3;
  monthlyConcurrency = Math.min(10, monthlyConcurrency);
  const batchTranscriptCap =
    Number.isFinite(MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS) && MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS >= 0
      ? MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS
      : 1200;

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Monthly client newsletter mining (30-day call summaries → pooled FAQ & story ideas)');
  console.log(`  Window: ${rangeLabel}`);
  console.log('═'.repeat(52));

  console.log('\n[1/4] Fetching Quo calls (30-day window, summary-first)...\n');
  const { callData, totalFetched, totalSaved } = await runExport({
    createdAfter,
    createdBefore,
    monthlyNewsletter: true,
    fetchTranscriptForMonthly: process.env.MONTHLY_FETCH_TRANSCRIPTS === 'true',
  });

  let transcripts = filterMonthlyNewsletterCalls(callData);
  let clientTranscriptCount = 0;
  let leadTranscriptCount = 0;
  for (const c of transcripts) {
    if (monthlyCallSegment(c.contact) === 'client') clientTranscriptCount++;
    else leadTranscriptCount++;
  }

  if (processCap > 0 && transcripts.length > processCap) {
    console.log(
      `  MONTHLY_MAX_TRANSCRIPTS_TO_PROCESS=${processCap} — analyzing first ${processCap} of ${transcripts.length} calls.`
    );
    transcripts = transcripts.slice(0, processCap);
    clientTranscriptCount = 0;
    leadTranscriptCount = 0;
    for (const c of transcripts) {
      if (monthlyCallSegment(c.contact) === 'client') clientTranscriptCount++;
      else leadTranscriptCount++;
    }
  }

  console.log(
    `\n[2/4] Calls queued for monthly extraction: ${transcripts.length} (${clientTranscriptCount} client · ${leadTranscriptCount} lead_or_other) of ${totalSaved} saved (${totalFetched} calls in window).`
  );
  console.log(
    `       MONTHLY_EXTRACTION_BATCH_SIZE=${monthlyBatchSize} · MONTHLY_EXTRACTION_CONCURRENCY=${monthlyConcurrency} · MONTHLY_LLM_DELAY_MS=${MONTHLY_LLM_DELAY_MS}`
  );

  /** @type {{ call: object, callSegment: string, extraction: object | null }[]} */
  const rows = [];

  if (!OPENAI_API_KEY) {
    console.log('\n[3/4] Skipped theme extraction (no OPENAI_API_KEY).');
  } else if (!transcripts.length) {
    console.log('\n[3/4] No calls with summaries (or transcripts) in window.');
  } else {
    const batchLabel =
      monthlyBatchSize === 1
        ? 'one LLM request per call'
        : `up to ${monthlyBatchSize} calls per LLM request`;
    const concLabel =
      monthlyConcurrency > 1 ? `; up to ${monthlyConcurrency} batches in parallel per wave` : '';
    console.log(`\n[3/4] LLM theme extraction (${batchLabel}${concLabel}; anonymized JSON; pooled later)...`);

    const chunks = [];
    for (let start = 0; start < transcripts.length; start += monthlyBatchSize) {
      chunks.push({ start, chunk: transcripts.slice(start, start + monthlyBatchSize) });
    }
    const totalWaves = Math.ceil(chunks.length / monthlyConcurrency);
    for (let w = 0; w < chunks.length; w += monthlyConcurrency) {
      const wave = chunks.slice(w, w + monthlyConcurrency);
      const waveNum = Math.floor(w / monthlyConcurrency) + 1;
      const callsThisWave = wave.reduce((s, x) => s + x.chunk.length, 0);
      process.stdout.write(`  [wave ${waveNum}/${totalWaves}] ${wave.length} batch(es), ${callsThisWave} calls ... `);

      const settled = await Promise.all(
        wave.map(({ start, chunk }) =>
          extractOneMonthlyChunk(chunk, batchTranscriptCap).then((r) => ({ start, ...r }))
        )
      );
      settled.sort((a, b) => a.start - b.start);
      let waveItems = 0;
      const failNotes = [];
      for (const r of settled) {
        if (!r.ok && r.error) failNotes.push(`fail@${r.start}: ${r.error}`);
        rows.push(...r.outRows);
        waveItems += r.itemCount;
      }
      const tail = failNotes.length ? ` · ${failNotes.join(' · ')}` : '';
      console.log(`${waveItems} theme items${tail}`);
      await sleep(MONTHLY_LLM_DELAY_MS);
    }
  }

  const okCount = rows.filter((r) => r.extraction).length;
  const rawMd = buildMonthlyRawExtractionsMarkdown(rows, digestCap);

  console.log('\n[4/4] Aggregating pooled themes into client newsletter brief...');
  let bodyMd = '';
  if (!OPENAI_API_KEY) {
    bodyMd =
      'OPENAI_API_KEY is not configured — monthly extraction was skipped.\n\n' +
      `_Window: ${rangeLabel} · ${transcripts.length} call(s) would have been queued._`;
  } else if (!okCount) {
    bodyMd =
      'No successful theme extractions in this run (check logs). Raw window had ' +
      `${transcripts.length} call(s) queued.`;
  } else {
    bodyMd = await generateMonthlyNewsletterEmailMarkdown(
      rangeLabel,
      transcripts.length,
      clientTranscriptCount,
      leadTranscriptCount,
      rawMd
    );
  }
  console.log('  Done.');

  const subject = 'Monthly client newsletter content ideas (from call themes)';
  const html = buildMonthlyInsightsEmailHtml(bodyMd, rangeLabel);

  if (!EMAIL_TO.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured — printing monthly insights body:\n');
    console.log(bodyMd);
  } else {
    await sendEmail({
      htmlBody: html,
      plainText: bodyMd,
      subject,
      attachments: [],
    });
    console.log(`\n  Sent monthly insights to: ${EMAIL_TO.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Monthly client newsletter content run complete.');
  return { rangeLabel, transcriptsQueued: transcripts.length, extractionsOk: okCount, bodyMd };
}

// ── Weekly client sentiment (7-day window, LLM per transcript) ───────────────

const WEEKLY_SENTIMENT_SHEET_HEADER = [
  'week_range_label',
  'window_start_utc',
  'window_end_utc',
  'published_at_local',
  'client',
  'touchpoints',
  'attorney',
  'paralegal',
  'sentiment',
  'score',
  'bad_review_risk',
  'positive_review_candidate',
  'client_state',
  'reason_summary',
  'reason_tags',
  'status',
  'next_action',
  'evidence_urls',
];

const WEEKLY_NEGATIVE_SHEET_HEADER = ['cohort', ...WEEKLY_SENTIMENT_SHEET_HEADER];

function markdownLinksToPlainUrls(md) {
  if (!md || md === '—') return '';
  const urls = new Set();
  const re = /\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(md))) !== null) urls.add(m[1]);
  return [...urls].join(' ');
}

function sheetCellOneLine(s, maxLen = 5000) {
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function rollupToWeeklySheetRow(r, createdAfter, createdBefore, rangeLabel, publishedAtLocal) {
  return [
    rangeLabel,
    createdAfter,
    createdBefore,
    publishedAtLocal,
    r.clientKey,
    r.callCount,
    r.leadAttorney || '',
    r.paralegal || '',
    weeklySentimentWord(r.holisticSentiment),
    r.score,
    r.badReviewRisk || 'none',
    r.positiveReview || 'none',
    sheetCellOneLine(stripMarkdownBold(r.state || ''), 800),
    sheetCellOneLine(stripMarkdownBold(r.summary || ''), 2000),
    sheetCellOneLine(stripMarkdownBold(r.topTags || ''), 1200),
    sheetCellOneLine(r.statusText, 4000),
    sheetCellOneLine(r.nextActionText, 4000),
    markdownLinksToPlainUrls(r.links),
  ];
}

function weeklyNegativeSnapshotSpreadsheetId() {
  return GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_SHEET_ID || GOOGLE_WEEKLY_SENTIMENT_SHEET_ID;
}

function weeklyNegativeSnapshotRangeInput() {
  return GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_RANGE || 'Negative Sentiment';
}

function rollupToNegativeSnapshotSheetRow(r, cohortKey, runCreatedAfter, runCreatedBefore, runRangeLabel, publishedAtLocal) {
  const cohortCell = weeklyNegativeCohortDisplay(cohortKey);
  const base = rollupToWeeklySheetRow(
    r,
    r.carryWindowStart || runCreatedAfter,
    r.carryWindowEnd || runCreatedBefore,
    r.sheetWeekRangeLabel || runRangeLabel,
    publishedAtLocal
  );
  return [cohortCell, ...base];
}

function latestSentimentSpreadsheetId() {
  return GOOGLE_LATEST_SENTIMENT_SHEET_ID || GOOGLE_WEEKLY_NEGATIVE_SENTIMENT_SHEET_ID || GOOGLE_WEEKLY_SENTIMENT_SHEET_ID;
}

function latestSentimentRangeInput() {
  return GOOGLE_LATEST_SENTIMENT_RANGE || 'All Latest Sentiment';
}

/**
 * Append-only sink: every sentiment run appends one row per analyzed client
 * to the "All Latest Sentiment" tab. Existing rows are never touched.
 * Header is written automatically the first time the tab is empty.
 */
async function appendLatestSentimentRows(rollups, createdAfter, createdBefore, rangeLabel) {
  const spreadsheetId = latestSentimentSpreadsheetId();
  if (!spreadsheetId) return;
  const hasOAuth =
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN;
  if (!hasOAuth) return;
  if (!rollups?.length) {
    console.log('  All Latest Sentiment sheet: no rollups to append.');
    return;
  }

  const rangeInput = latestSentimentRangeInput();
  const normalized = normalizeWeeklySentimentSheetRange(rangeInput);
  const appendAnchor = await resolveAppendAnchorA1(spreadsheetId, normalized);
  const prefix = appendAnchor.slice(0, Math.max(0, appendAnchor.lastIndexOf('!')));
  const publishedAtLocal = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');

  const top = await fetchSheetData(spreadsheetId, `${prefix}!A1:A1`);
  if (!top?.length || !top[0]?.[0]) {
    await updateSheetValues(spreadsheetId, `${prefix}!A1`, [WEEKLY_SENTIMENT_SHEET_HEADER]);
  }

  const rows = rollups.map((r) =>
    rollupToWeeklySheetRow(r, createdAfter, createdBefore, rangeLabel, publishedAtLocal)
  );

  await appendSheetValues(spreadsheetId, `${prefix}!A1`, rows);
  console.log(
    `  All Latest Sentiment sheet: appended ${rows.length} row(s) to "${sheetTabFromRangeA1(appendAnchor) || 'tab'}".`
  );
}

async function replaceWeeklyNegativeSentimentSnapshot(emailRollups, createdAfter, createdBefore, rangeLabel) {
  const spreadsheetId = weeklyNegativeSnapshotSpreadsheetId();
  if (!spreadsheetId) return;
  const hasOAuth =
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN;
  if (!hasOAuth) return;

  const rangeInput = weeklyNegativeSnapshotRangeInput();
  const normalized = normalizeWeeklySentimentSheetRange(rangeInput);
  const appendAnchor = await resolveAppendAnchorA1(spreadsheetId, normalized);
  const prefix = appendAnchor.slice(0, Math.max(0, appendAnchor.lastIndexOf('!')));
  const lastCol = weeklySheetColLetter0Based(WEEKLY_NEGATIVE_SHEET_HEADER.length - 1);
  const publishedAtLocal = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  const rows = (emailRollups || []).map((r) =>
    rollupToNegativeSnapshotSheetRow(
      r,
      r._weeklyEmailCohort || 'current_7d',
      createdAfter,
      createdBefore,
      rangeLabel,
      publishedAtLocal
    )
  );

  await clearSheetValuesRange(spreadsheetId, `${prefix}!A2:${lastCol}20000`);
  const values = rows.length ? [WEEKLY_NEGATIVE_SHEET_HEADER, ...rows] : [WEEKLY_NEGATIVE_SHEET_HEADER];
  await updateSheetValues(spreadsheetId, `${prefix}!A1`, values);
  console.log(
    `  Negative snapshot sheet: wrote ${rows.length} data row(s) on "${sheetTabFromRangeA1(appendAnchor) || 'tab'}".`
  );
}

/** 0-based column index → A1 column letters (supports A..ZZ). */
function weeklySheetColLetter0Based(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const WEEKLY_SHEET_COL_WINDOW_START = 1;
const WEEKLY_SHEET_COL_WINDOW_END = 2;
const WEEKLY_SHEET_COL_CLIENT = 4;

/**
 * Env may be tab-only (`Sheet1`). Sheets helpers need A1 with `!` (e.g. `Sheet1!A:ZZ`).
 * If already `Tab!A:Z`, returned as-is.
 */
function normalizeWeeklySentimentSheetRange(rangeInput) {
  const s = String(rangeInput ?? '').trim();
  if (!s) return '';
  if (s.includes('!')) return s;
  const needsQuote = /[^A-Za-z0-9_]/.test(s);
  const tab = needsQuote ? `'${s.replace(/'/g, "''")}'` : s;
  return `${tab}!A:ZZ`;
}

async function syncWeeklySentimentToGoogleSheets({
  spreadsheetId,
  rangeInput,
  createdAfter,
  createdBefore,
  rangeLabel,
  rollups,
}) {
  const hasOAuth =
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN;
  if (!hasOAuth) {
    console.warn('  Weekly sentiment sheet: skipped (Google OAuth not configured).');
    return;
  }

  if (!rollups?.length) {
    console.log('  Weekly sentiment sheet: no client rows in this run — sheet unchanged.');
    return;
  }

  const rangeForSheets = normalizeWeeklySentimentSheetRange(rangeInput);
  const appendAnchorA1 = await resolveAppendAnchorA1(spreadsheetId, rangeForSheets);
  const prefix = appendAnchorA1.slice(0, Math.max(0, appendAnchorA1.lastIndexOf('!')));
  const tabTitle = sheetTabFromRangeA1(appendAnchorA1);
  const lastCol = weeklySheetColLetter0Based(WEEKLY_SENTIMENT_SHEET_HEADER.length - 1);
  const scanRows = Math.min(
    50000,
    Math.max(500, parseInt(process.env.GOOGLE_WEEKLY_SENTIMENT_SCAN_MAX_ROWS || '8000', 10) || 8000)
  );

  let needsHeader = true;
  try {
    const top = await fetchSheetData(spreadsheetId, `${prefix}!A1:A1`);
    const cell = top?.[0]?.[0];
    if (cell != null && String(cell).trim() === WEEKLY_SENTIMENT_SHEET_HEADER[0]) needsHeader = false;
  } catch {
    needsHeader = true;
  }

  const publishedAtLocal = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  const dataRows = rollups.map((r) =>
    rollupToWeeklySheetRow(r, createdAfter, createdBefore, rangeLabel, publishedAtLocal)
  );

  if (needsHeader) {
    await updateSheetValues(spreadsheetId, `${prefix}!A1:${lastCol}1`, [WEEKLY_SENTIMENT_SHEET_HEADER]);
  }

  if (!GOOGLE_WEEKLY_SENTIMENT_DEDUPE) {
    await appendSheetValues(spreadsheetId, appendAnchorA1, dataRows);
    console.log(
      `  Weekly sentiment sheet: appended ${dataRows.length} row(s) on "${tabTitle || 'tab'}" (GOOGLE_WEEKLY_SENTIMENT_DEDUPE=0 append-only).`
    );
    return;
  }

  let existing = [];
  try {
    existing = await fetchSheetData(spreadsheetId, `${prefix}!A2:${lastCol}${scanRows + 1}`);
  } catch {
    existing = [];
  }

  /** @type {Map<string, number[]>} key → ascending 1-based sheet row numbers */
  const keyToRows = new Map();
  for (let i = 0; i < (existing || []).length; i++) {
    const row = existing[i] || [];
    const ws = String(row[WEEKLY_SHEET_COL_WINDOW_START] ?? '').trim();
    const we = String(row[WEEKLY_SHEET_COL_WINDOW_END] ?? '').trim();
    const client = String(row[WEEKLY_SHEET_COL_CLIENT] ?? '').trim();
    if (!ws || !we || !client) continue;
    if (ws !== createdAfter || we !== createdBefore) continue;
    const key = `${ws}\t${we}\t${client}`;
    const sheetRow1 = i + 2;
    if (!keyToRows.has(key)) keyToRows.set(key, []);
    keyToRows.get(key).push(sheetRow1);
  }

  const toUpdate = [];
  const toAppend = [];
  const delete0Based = [];

  for (const r of rollups) {
    const key = `${createdAfter}\t${createdBefore}\t${r.clientKey}`;
    const hits = keyToRows.get(key) || [];
    const newVals = rollupToWeeklySheetRow(r, createdAfter, createdBefore, rangeLabel, publishedAtLocal);
    if (!hits.length) {
      toAppend.push(newVals);
      continue;
    }
    const primary = hits[0];
    toUpdate.push({ row1: primary, values: newVals });
    for (let j = 1; j < hits.length; j++) {
      delete0Based.push(hits[j] - 1);
    }
  }

  if (toUpdate.length) {
    const batch = toUpdate.map(({ row1, values }) => ({
      range: `${prefix}!A${row1}:${lastCol}${row1}`,
      values: [values],
    }));
    await batchUpdateSheetValues(spreadsheetId, batch);
  }

  if (delete0Based.length) {
    const sheetId = await getSheetIdByTitle(spreadsheetId, tabTitle);
    await deleteSheetRowsByIndex(spreadsheetId, sheetId, delete0Based);
  }

  if (toAppend.length) {
    await appendSheetValues(spreadsheetId, appendAnchorA1, toAppend);
  }

  console.log(
    `  Weekly sentiment sheet: ${toUpdate.length} updated · ${toAppend.length} appended · ${delete0Based.length} duplicate row(s) removed — "${tabTitle || 'tab'}"`
  );
}

function urlsToMarkdownLinks(urlsRaw) {
  const parts = String(urlsRaw || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  if (!parts.length) return '—';
  return parts.map((u, i) => `[V${i + 1}](${u})`).join(' ');
}

async function loadWeeklyNegativeCarryoverRollups({
  createdAfter,
  currentRollups,
}) {
  const hasOAuth =
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN;
  if (!GOOGLE_WEEKLY_SENTIMENT_SHEET_ID || !hasOAuth) return [];

  const rangeForSheets = normalizeWeeklySentimentSheetRange(GOOGLE_WEEKLY_SENTIMENT_RANGE);
  const appendAnchorA1 = await resolveAppendAnchorA1(GOOGLE_WEEKLY_SENTIMENT_SHEET_ID, rangeForSheets);
  const prefix = appendAnchorA1.slice(0, Math.max(0, appendAnchorA1.lastIndexOf('!')));
  const lastCol = weeklySheetColLetter0Based(WEEKLY_SENTIMENT_SHEET_HEADER.length - 1);
  const scanRows = Math.min(
    50000,
    Math.max(500, parseInt(process.env.GOOGLE_WEEKLY_SENTIMENT_SCAN_MAX_ROWS || '8000', 10) || 8000)
  );
  const existing = await fetchSheetData(
    GOOGLE_WEEKLY_SENTIMENT_SHEET_ID,
    `${prefix}!A2:${lastCol}${scanRows + 1}`
  );

  const currentClients = new Set((currentRollups || []).map((r) => String(r.clientKey || '').trim()).filter(Boolean));
  const priorStart = DateTime.fromISO(createdAfter, { zone: 'utc' }).minus({ days: 7 });
  const priorEnd = DateTime.fromISO(createdAfter, { zone: 'utc' });

  const carryByClient = new Map();
  for (let i = (existing || []).length - 1; i >= 0; i--) {
    const row = existing[i] || [];
    const client = String(row[WEEKLY_SHEET_COL_CLIENT] ?? '').trim();
    if (!client || currentClients.has(client) || carryByClient.has(client)) continue;

    const sentiment = String(row[8] ?? '').trim().toLowerCase();
    if (sentiment !== 'negative') continue;

    const rowWindowEnd = String(row[WEEKLY_SHEET_COL_WINDOW_END] ?? '').trim();
    if (!rowWindowEnd) continue;
    const endUtc = DateTime.fromISO(rowWindowEnd, { zone: 'utc' });
    if (!endUtc.isValid || endUtc < priorStart || endUtc >= priorEnd) continue;

    const statusBase = String(row[15] ?? '').trim();
    const carryNote = `Carryover (no new touchpoints in current 7-day window). Last negative window ended ${endUtc
      .setZone(TIMEZONE)
      .toFormat('LLL d')}.`;
    const statusText = statusBase ? `${carryNote} ${statusBase}` : carryNote;

    const scoreRaw = String(row[9] ?? '').trim();
    const scoreNum = Number(scoreRaw);
    carryByClient.set(client, {
      clientKey: client,
      callCount: Number.parseInt(String(row[5] ?? '0'), 10) || 0,
      leadAttorney: String(row[6] ?? '').trim(),
      paralegal: String(row[7] ?? '').trim(),
      holisticSentiment: 'negative',
      score: Number.isFinite(scoreNum) ? scoreNum : 0,
      badReviewRisk: String(row[10] ?? 'none').trim().toLowerCase() || 'none',
      positiveReview: String(row[11] ?? 'none').trim().toLowerCase() || 'none',
      summary: String(row[13] ?? '').trim(),
      state: String(row[12] ?? '').trim(),
      topTags: String(row[14] ?? '').trim(),
      statusText,
      nextActionText: String(row[16] ?? '').trim() || 'Follow up on prior negative client sentiment.',
      links: urlsToMarkdownLinks(row[17]),
      overallLabel: 'Negative',
      sortTier: 0,
      sheetWeekRangeLabel: String(row[0] ?? '').trim(),
      carryWindowStart: String(row[WEEKLY_SHEET_COL_WINDOW_START] ?? '').trim(),
      carryWindowEnd: String(row[WEEKLY_SHEET_COL_WINDOW_END] ?? '').trim(),
    });
  }

  return [...carryByClient.values()];
}

async function runWeeklyClientSentimentReport(opts = {}) {
  const requestedDays = opts.days != null ? Math.max(1, Math.floor(Number(opts.days) || 0)) : null;
  const days = requestedDays || 7;
  const onlyLatest = Boolean(opts.onlyLatest);
  const { createdAfter, createdBefore } = requestedDays
    ? getTrailingDaysRange(days)
    : getTrailing7DaysRange();
  const rangeLabel = requestedDays
    ? buildSentimentTrailingDaysRangeLabel(createdAfter, createdBefore, days)
    : buildSentiment7DayRangeLabel(createdAfter, createdBefore);

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  Weekly client sentiment (trailing ${days} day${days === 1 ? '' : 's'} · summaries + SMS + all call statuses)${onlyLatest ? ' [latest-only mode: skipping email + Negative Sentiment + weekly upsert]' : ''}`);
  console.log(`  Window: ${rangeLabel}`);
  console.log('═'.repeat(52));

  console.log(`\n[1/4] Fetching Quo calls + SMS (${days}-day window)...\n`);
  const { callData, totalFetched, totalSaved } = await runExport({
    createdAfter,
    createdBefore,
    weeklyCommunications: true,
    includeMessages: true,
    fetchTranscriptForWeekly: false,
  });

  const groups = groupClientTouchpointsByContact(callData);
  const clientCount = groups.size;
  console.log(
    `\n[2/4] Client touchpoint groups (CRM name ends with case number): ${clientCount} client(s) · ${totalSaved} rows saved · ${totalFetched} calls fetched in window.`
  );

  /** @type {{ call: object, analysis: object | null }[]} */
  const rows = [];

  if (!OPENAI_API_KEY) {
    console.log('\n[3/4] Skipped per-client LLM (no OPENAI_API_KEY).');
  } else if (!clientCount) {
    console.log('\n[3/4] No client touchpoints to analyze.');
  } else {
    console.log('\n[3/4] LLM sentiment (JSON) per client — full 7-day communication bundle...');
    const entries = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })
    );
    for (let i = 0; i < entries.length; i++) {
      const [clientKey, items] = entries[i];
      const label = (clientKey || `client ${i + 1}`).slice(0, 48);
      process.stdout.write(`  [${i + 1}/${entries.length}] ${label} ... `);
      const rep = makeRepresentativeCallForBundle(clientKey, items);
      try {
        const analysis = await analyzeWeeklyClientBundleWithLlm(clientKey, items, rangeLabel);
        rows.push({ call: rep, analysis });
        console.log(`${analysis.sentiment} · review ${analysis.bad_review_risk} · +review ${analysis.positive_review_candidate}`);
      } catch (err) {
        console.log(`failed: ${err.message}`);
        rows.push({ call: rep, analysis: null });
      }
      await sleep(SENTIMENT_LLM_DELAY_MS);
    }
  }

  const agg = aggregateSentimentResults(rows);

  console.log('\n[4/4] Building weekly email (tables only)...');
  const rollups = buildAllClientRollups(rows);

  if (GOOGLE_SHEETS_CASE_ROSTER_ID) {
    const hasOAuth =
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN;
    if (hasOAuth) {
      try {
        const rosterRows = await fetchSheetData(
          GOOGLE_SHEETS_CASE_ROSTER_ID,
          GOOGLE_SHEETS_CASE_ROSTER_RANGE
        );
        const rosterMap = rawRowsToCaseRosterMap(rosterRows);
        enrichRollupsWithCaseRoster(rollups, rosterMap);
        console.log(`  Case roster sheet: ${rosterMap.size} row(s) indexed for attorney/paralegal.`);
      } catch (err) {
        console.warn(`  Case roster fetch failed (weekly email still sends): ${err.message}`);
      }
    } else {
      console.warn(
        '  GOOGLE_SHEETS_CASE_ROSTER_ID is set but Google OAuth env vars are incomplete — attorney/paralegal columns omitted.'
      );
    }
  }

  if (!onlyLatest && GOOGLE_WEEKLY_SENTIMENT_SHEET_ID) {
    try {
      await syncWeeklySentimentToGoogleSheets({
        spreadsheetId: GOOGLE_WEEKLY_SENTIMENT_SHEET_ID,
        rangeInput: GOOGLE_WEEKLY_SENTIMENT_RANGE,
        createdAfter,
        createdBefore,
        rangeLabel,
        rollups,
      });
    } catch (err) {
      console.warn(`  Weekly sentiment sheet sync failed: ${err.message}`);
    }
  }

  let carryoverNegatives = [];
  if (!onlyLatest && GOOGLE_WEEKLY_SENTIMENT_SHEET_ID && OPENAI_API_KEY) {
    try {
      carryoverNegatives = await loadWeeklyNegativeCarryoverRollups({
        createdAfter,
        currentRollups: rollups,
      });
      if (carryoverNegatives.length) {
        console.log(`  Weekly email carryover: added ${carryoverNegatives.length} prior-window negative client(s) not updated this week.`);
      }
    } catch (err) {
      console.warn(`  Weekly carryover load failed: ${err.message}`);
    }
  }

  const currentNegativeRollups = rollups
    .filter((r) => String(r.holisticSentiment || '').toLowerCase() === 'negative')
    .map((r) => ({ ...r, _weeklyEmailCohort: 'current_7d' }));
  const carryTagged = carryoverNegatives.map((o) => ({ ...o, _weeklyEmailCohort: 'carryover_prior_7d' }));
  const emailRollups = [...currentNegativeRollups, ...carryTagged];

  let bodyMd = '';
  if (!OPENAI_API_KEY) {
    bodyMd =
      '## Weekly client negative sentiment\n\nOPENAI_API_KEY is not configured — analysis was skipped.\n';
  } else {
    bodyMd = buildWeeklyNegativeEmailMarkdown(rangeLabel, emailRollups);
  }
  console.log('  Done.');

  if (!onlyLatest) {
    try {
      await replaceWeeklyNegativeSentimentSnapshot(emailRollups, createdAfter, createdBefore, rangeLabel);
    } catch (err) {
      console.warn(`  Negative snapshot sheet failed: ${err.message}`);
    }
  }

  try {
    await appendLatestSentimentRows(rollups, createdAfter, createdBefore, rangeLabel);
  } catch (err) {
    console.warn(`  All Latest Sentiment sheet append failed: ${err.message}`);
  }

  if (onlyLatest) {
    console.log('\n  Latest-only mode: skipping email send.');
  } else {
    const subject = `Weekly Client Negative Sentiment - ${rangeLabel}`;
    const html = buildWeeklyNegativeSentimentEmailHtml(rangeLabel, emailRollups);

    if (!EMAIL_TO.length || !EMAIL_CONFIGURED) {
      console.log('\n  Email not configured — printing weekly sentiment body:\n');
      console.log(bodyMd);
    } else {
      await sendEmail({
        htmlBody: html,
        plainText: bodyMd,
        subject,
        attachments: [],
      });
      console.log(`\n  Sent weekly sentiment report to: ${EMAIL_TO.join(', ')}`);
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Weekly sentiment run complete.');
  return { rangeLabel, clientsAnalyzed: clientCount, aggregate: agg, clientRollups: rollups, bodyMd };
}

// ── Missed Client Call Report (trailing 24h, client contacts only) ───────────

const MISSED_INBOUND_STATUSES = new Set([
  'missed',
  'no-answer',
  'noanswer',
  'voicemail',
  'unanswered',
  'rejected',
  'busy',
  'declined',
]);

function isIncomingDirection(d) {
  const v = String(d || '').toLowerCase();
  return v === 'incoming' || v === 'inbound';
}

function isMissedInboundCall(c) {
  if (!isIncomingDirection(c.direction)) return false;
  const status = String(c.status || '').toLowerCase();
  // A completed inbound is never a miss — even if Sona routed it, the client
  // reached someone (either Sona resolved it or it was handed off to a human).
  if (status === 'completed') return false;
  // Sona/AI-handled inbound that did NOT complete (voicemail, hang-up
  // mid-Sona, etc.) — staff still need to call back.
  if (c.aiHandled) return true;
  if (MISSED_INBOUND_STATUSES.has(status)) return true;
  // Fallback: incoming with zero duration treated as missed.
  const dur = Number(c.duration || 0);
  if (status && (!Number.isFinite(dur) || dur <= 0)) return true;
  return false;
}

function classifyMissedReason(c) {
  if (c.aiHandled) return 'Sona/AI handled';
  const status = String(c.status || '').toLowerCase();
  if (status === 'voicemail') return 'Voicemail';
  if (MISSED_INBOUND_STATUSES.has(status)) return 'Missed (no answer)';
  return 'Missed';
}

function formatMissedCallTime(iso) {
  if (!iso) return '';
  const dt = DateTime.fromISO(String(iso), { zone: 'utc' }).setZone(TIMEZONE);
  if (!dt.isValid) return '';
  return dt.toFormat("ccc, LLL d 'at' h:mm a") + ` ${TIMEZONE}`;
}

function buildMissedClientCallTable(rows) {
  const header = ['Client', 'Phone', 'Missed at', 'Reason', 'Attorney', 'Paralegal', 'Quo line', 'Link'];
  const lines = [header.join(' | '), header.map(() => '---').join(' | ')];
  for (const r of rows) {
    lines.push(
      [
        r.contact || '(unknown)',
        r.phone || '',
        r.missedAtLocal || '',
        r.reason || '',
        r.attorney || '',
        r.paralegal || '',
        r.line || '',
        r.link ? `[open](${r.link})` : '',
      ].join(' | ')
    );
  }
  return lines.join('\n');
}

function buildMissedClientCallEmailHtml(rangeLabel, rows) {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 14px; }
    th { background: #f6f8fa; }
    .empty { color: #57606a; font-style: italic; padding: 16px 0; }
  `.trim();
  const headerRow =
    '<tr><th>Client</th><th>Phone</th><th>Missed at</th><th>Reason</th><th>Attorney</th><th>Paralegal</th><th>Quo line</th><th>Link</th></tr>';
  const bodyRows = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.contact || '(unknown)')}</td>` +
        `<td>${escapeHtml(r.phone || '')}</td>` +
        `<td>${escapeHtml(r.missedAtLocal || '')}</td>` +
        `<td>${escapeHtml(r.reason || '')}</td>` +
        `<td>${escapeHtml(r.attorney || '')}</td>` +
        `<td>${escapeHtml(r.paralegal || '')}</td>` +
        `<td>${escapeHtml(r.line || '')}</td>` +
        `<td>${r.link ? `<a href="${escapeHtml(r.link)}">open</a>` : ''}</td></tr>`
    )
    .join('');
  const table = rows.length
    ? `<table>${headerRow}${bodyRows}</table>`
    : '<p class="empty">No outstanding missed client calls in the last 24 hours. Nice work!</p>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <h2>Missed Client Call Report</h2>
    ${table}
    <p style="margin-top: 16px;"><strong>Window:</strong> ${escapeHtml(rangeLabel)}</p>
    <p>Client numbers whose most recent call in the last 24 hours was a missed or Sona/AI-handled call that didn't connect to a person — regardless of which internal line handled it. A number drops off as soon as its latest call is answered (client calls back and gets through) or we dial out to them from any line. Please call back the clients still listed.</p>
  </body></html>`;
}

/**
 * Trailing 24h. Pulls all calls (including missed) from Quo, filters to
 * client contacts (CRM name ends in a case number), groups by phone, and
 * surfaces clients whose latest activity is an unreturned missed inbound.
 */
async function runMissedClientCallReport() {
  const { createdAfter, createdBefore } = getTrailing24HoursRange();
  const a = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  const rangeLabel = `${a.toFormat("LLL d, h:mm a")} – ${b.toFormat("LLL d, h:mm a")} ${TIMEZONE}`;

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Missed Client Call Report (trailing 24h)');
  console.log(`  Window: ${rangeLabel}`);
  console.log('═'.repeat(52));

  console.log('\n[1/3] Fetching Quo calls (all lines, all statuses, trailing 24h)...');
  const { callData } = await runExport({
    createdAfter,
    createdBefore,
    weeklyCommunications: true,
    includeMessages: false,
    fetchTranscriptForWeekly: false,
    // Pull every line in the workspace — resolving calls often happen on a
    // different line (e.g. miss on RJL Outbound, callback via RJL Main Line,
    // client retry into RJL Transfers). Filtering to QUO_PHONE_NUMBERS here
    // would drop those and produce false-positive flags.
    phoneNumbersFilter: [],
  });

  // Group EVERY call in the window by phone last-10 first, so resolving calls
  // (callbacks, transfers, etc.) that may have a different/missing contact
  // label are still grouped with their corresponding miss. Then qualify the
  // group as "client" only if at least one call in it has a client-shaped
  // contact name (CRM name ending in a case number).
  const allCalls = (callData || []).filter((r) => r.recordType === 'call');
  console.log(`\n[2/3] ${allCalls.length} call(s) in window (will filter to clients next).`);

  /** @type {Map<string, { leadAttorney?: string, paralegal?: string }>} */
  let rosterMap = new Map();
  if (GOOGLE_SHEETS_CASE_ROSTER_ID && allCalls.length) {
    const hasOAuth =
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN;
    if (hasOAuth) {
      try {
        const rosterRows = await fetchSheetData(
          GOOGLE_SHEETS_CASE_ROSTER_ID,
          GOOGLE_SHEETS_CASE_ROSTER_RANGE
        );
        rosterMap = rawRowsToCaseRosterMap(rosterRows);
        console.log(`  Case roster sheet: ${rosterMap.size} row(s) indexed for attorney/paralegal.`);
      } catch (err) {
        console.warn(`  Case roster fetch failed (report still sends without attorney/paralegal): ${err.message}`);
      }
    } else {
      console.warn(
        '  GOOGLE_SHEETS_CASE_ROSTER_ID is set but Google OAuth env vars are incomplete — attorney/paralegal columns omitted.'
      );
    }
  }

  // Group every call by the external DIAL-IN number (caller's phone, last 10
  // digits) — regardless of which internal Quo line handled it. We fetch all
  // lines (phoneNumbersFilter: []), so a number's complete activity (misses,
  // callbacks, our outbound from any line) lands in one bucket.
  /** @type {Map<string, object[]>} */
  const byPhone = new Map();
  for (const c of allCalls) {
    const key = last10Digits(c.phone) || last10Digits(c.contact);
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(c);
  }

  /** @type {{ contact: string, phone: string, missedAtLocal: string, missedAtIso: string, line: string, link: string }[]} */
  const outstanding = [];
  for (const [, group] of byPhone) {
    // Skip numbers where no call in the group is from a client contact
    // (CRM contact name must end in a case number — e.g. "David Eagan 3432").
    const clientAnchor = group.find((c) => isClientContactName(c.contact));
    if (!clientAnchor) continue;

    group.sort((x, y) => String(x.timestamp || '').localeCompare(String(y.timestamp || '')));

    // Flag ONLY when the dial-in number's most recent call is itself a missed
    // or Sona-handled (not completed) inbound. If the last call was completed
    // (client got through) or outbound (we dialed back from any line), there's
    // nothing outstanding — regardless of earlier misses.
    const lastCall = group[group.length - 1];
    if (!lastCall || !isMissedInboundCall(lastCall)) continue;

    // Prefer the client-formatted contact name (most likely to carry the case
    // number) even if lastCall itself was on a transfer leg without it.
    const displayContact = clientAnchor.contact || lastCall.contact || '';
    const caseId = extractTrailingCaseDigitsFromClientKey(displayContact);
    const rosterHit = caseId ? rosterMap.get(caseId) : null;
    outstanding.push({
      contact: displayContact,
      phone: lastCall.phone || clientAnchor.phone || '',
      missedAtLocal: formatMissedCallTime(lastCall.timestamp),
      missedAtIso: lastCall.timestamp || '',
      reason: classifyMissedReason(lastCall),
      attorney: rosterHit?.leadAttorney || '',
      paralegal: rosterHit?.paralegal || '',
      line: lastCall.line || '',
      link: lastCall.link || '',
      _groupKey: last10Digits(lastCall.phone) || last10Digits(lastCall.contact) || '',
    });
  }

  outstanding.sort((x, y) => String(x.missedAtIso).localeCompare(String(y.missedAtIso)));

  console.log(`\n[3/3] Outstanding (unreturned) missed client calls: ${outstanding.length}`);
  for (const r of outstanding) {
    console.log(`  - ${r.contact} (${r.phone}) — ${r.reason} ${r.missedAtLocal}`);
    // Dump the full call sequence for this dial-in number so false-positives
    // are diagnosable from the Railway logs without re-running.
    const group = r._groupKey ? byPhone.get(r._groupKey) || [] : [];
    for (const c of group) {
      const t = formatMissedCallTime(c.timestamp);
      const dir = String(c.direction || '?').toLowerCase();
      const status = c.status || '?';
      const dur = c.duration != null ? c.duration : '?';
      const ai = c.aiHandled ? ' aiHandled' : '';
      const cid = c.contactId ? ` cid=${c.contactId}` : '';
      console.log(`      • ${t} ${dir} status=${status} dur=${dur}${ai}${cid} phone="${c.phone || ''}" line="${c.line || ''}"`);
    }
    delete r._groupKey;
  }

  const subject = outstanding.length
    ? `Missed Client Call Report — ${outstanding.length} to call back`
    : 'Missed Client Call Report — all clear';
  const html = buildMissedClientCallEmailHtml(rangeLabel, outstanding);
  const plainText = outstanding.length
    ? `Missed Client Call Report\nWindow: ${rangeLabel}\n\n${buildMissedClientCallTable(outstanding)}\n`
    : `Missed Client Call Report\nWindow: ${rangeLabel}\n\nNo outstanding missed client calls in the last 24 hours.\n`;

  const recipients = MISSED_CLIENT_CALLS_EMAIL_TO.length ? MISSED_CLIENT_CALLS_EMAIL_TO : EMAIL_TO;
  if (!recipients.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured (set MISSED_CLIENT_CALLS_EMAIL_TO or EMAIL_TO + Gmail OAuth) — printing report:\n');
    console.log(plainText);
  } else {
    await sendEmail({ htmlBody: html, plainText, subject, to: recipients });
    console.log(`\n  Sent missed-client-call report to: ${recipients.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Missed Client Call Report complete.');
  return { rangeLabel, outstandingCount: outstanding.length, outstanding };
}

// ── Review Intelligence V1 (daily Google-review candidate detection) ──────────

/** "Maria Lopez 1048" → "Maria Lopez" (drop the trailing case number for display). */
function displayClientName(clientKey) {
  const stripped = String(clientKey || '').replace(/\s+\d+$/, '').trim();
  return stripped || String(clientKey || '').trim();
}

/** Absolute base for client-facing review links: firm branded domain → env → none. */
function reviewPublicBase(firm) {
  const dom = firm && firm.review_domain ? String(firm.review_domain).trim() : '';
  if (dom) return `https://${dom.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const env = (process.env.REVIEW_PUBLIC_BASE_URL || '').trim();
  return env ? env.replace(/\/+$/, '') : '';
}

function reviewConfidenceRank(confidence) {
  switch (String(confidence || '').toLowerCase()) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    default:
      return 2;
  }
}

function reviewConfidenceEmoji(confidence) {
  switch (String(confidence || '').toLowerCase()) {
    case 'high':
      return '🟢';
    case 'medium':
      return '🟡';
    default:
      return '⚪';
  }
}

/** @returns {object | null} */
function parseReviewOpportunityJson(rawText) {
  const stripped = stripMarkdownJsonFence(rawText);
  let obj;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const scoreNum = Number(obj.review_score);
  if (!Number.isFinite(scoreNum)) return null;
  const review_score = Math.max(0, Math.min(100, Math.round(scoreNum)));

  const rawConf = String(obj.confidence || '').trim();
  const capConf = rawConf ? rawConf.charAt(0).toUpperCase() + rawConf.slice(1).toLowerCase() : '';
  const confidence = REVIEW_CONFIDENCE_TIERS.includes(capConf) ? capConf : 'Low';

  const toList = (v, cap) =>
    Array.isArray(v)
      ? v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, cap)
      : v
        ? [String(v).trim()].filter(Boolean)
        : [];

  return {
    review_score,
    confidence,
    qualified: obj.qualified === true,
    positive_signals: toList(obj.positive_signals, 12),
    disqualifiers: toList(obj.disqualifiers, 12),
    reasoning: toList(obj.reasoning, 8),
  };
}

async function analyzeReviewOpportunityWithLlm(clientKey, items, rangeLabel, sentiment, attempt = 1) {
  const caseId = extractTrailingCaseDigitsFromClientKey(clientKey);
  const phone = (items.find((i) => i.phone)?.phone || '').trim();
  const bundleMd = buildCommunicationBundleMarkdown(items);
  const prompt = buildReviewOpportunityPrompt({
    COMPANY_NAME,
    clientName: clientKey,
    caseId,
    phone,
    rangeLabel,
    touchpointCount: items.length,
    communicationLogMarkdown: bundleMd,
    priorSentiment: sentiment?.sentiment,
    priorBadReviewRisk: sentiment?.bad_review_risk,
    priorPositiveReviewCandidate: sentiment?.positive_review_candidate,
    priorReasonSummary: sentiment?.reason_summary,
  });
  const extraRetry =
    attempt > 1
      ? '\n\nYour previous answer failed validation. Reply with **only** one JSON object matching the schema; no markdown.'
      : '';
  const text = await runChatCompletion(
    prompt + extraRetry,
    OPENAI_REVIEW_MAX_TOKENS,
    `Review opportunity [${clientKey.slice(0, 28)}]`,
    { jsonObject: true, throwOnEmpty: true }
  );
  const parsed = parseReviewOpportunityJson(text);
  if (parsed) return parsed;
  if (attempt < 2) return analyzeReviewOpportunityWithLlm(clientKey, items, rangeLabel, sentiment, attempt + 1);
  throw new Error('Invalid review opportunity JSON after retry');
}

/**
 * A recent-window negative signal from the existing sentiment analyzer that
 * disqualifies a client from being asked for a review right now.
 */
function sentimentDisqualifies(sentiment) {
  if (!sentiment) return false;
  const s = String(sentiment.sentiment || '').toLowerCase();
  const risk = String(sentiment.bad_review_risk || 'none').toLowerCase();
  return s === 'negative' || risk === 'high' || risk === 'moderate';
}

/** Emoji staff react with to approve texting the client (configurable). */
const REVIEW_APPROVE_EMOJI = (process.env.REVIEW_APPROVE_EMOJI || 'white_check_mark').replace(/:/g, '').trim();

/** Intro / summary message posted before the per-candidate cards. */
function buildReviewIntroMessage(meta) {
  const { rangeLabel, dateLabel, candidateCount, qualifiedCount, reportedCount, canApprove } = meta;
  const approveHint = canApprove
    ? `React :${REVIEW_APPROVE_EMOJI}: (or reply *approve*) on a card to text that client their review link.`
    : '_Approval-to-send is off until the review store + Quo sending are configured._';
  return {
    text: `⭐ Review Intelligence — ${dateLabel} — ${reportedCount} candidate(s)`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⭐ Review Intelligence — ${dateLabel}`, emoji: true } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Active in last 24h: *${candidateCount}*  ·  Qualified: *${qualifiedCount}*  ·  Showing top *${reportedCount}*  ·  ${rangeLabel}`,
          },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: approveHint } },
      { type: 'divider' },
    ],
  };
}

function buildReviewEmptyMessage(meta) {
  const { dateLabel, rangeLabel, candidateCount, qualifiedCount } = meta;
  const note = qualifiedCount
    ? `_No clients met the bar to recommend today (score ≥ ${REVIEW_REPORT_MIN_SCORE} and High confidence — a standout positive moment)._\n${qualifiedCount} were positive but below the bar · ${candidateCount} active · ${rangeLabel}`
    : `_No review candidates in the last 24 hours._\n${candidateCount} active · ${rangeLabel}`;
  return {
    text: `⭐ Review Intelligence — ${dateLabel} — nothing recommended`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⭐ Review Intelligence — ${dateLabel}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: note } },
    ],
  };
}

/** One self-contained message per candidate, so a ✅ reaction maps to that client. */
function buildReviewCandidateMessage(o, idx) {
  const name = o.clientName || o.clientKey;
  const caseCell = o.caseId ? `Case *${o.caseId}*` : '_no case #_';
  const reasons = (o.reasoning.length ? o.reasoning : o.positive_signals).map((r) => `• ${r}`).join('\n');
  const linkLine = o.reviewLink ? `\n*Review link:* ${o.reviewLink}` : '';
  const approveLine = o.reviewRequestId && o.phone
    ? `\n_React :${REVIEW_APPROVE_EMOJI}: or reply *approve* to text this link to ${o.phone}._`
    : o.reviewRequestId
      ? '\n_No client phone on file — send the link manually._'
      : '';
  const text =
    `*${idx + 1}. ${name}*  ·  ${caseCell}\n` +
    `Score: *${o.review_score}/100*   ·   Confidence: ${reviewConfidenceEmoji(o.confidence)} *${o.confidence}*\n` +
    `*Why they were selected:*\n${reasons || '• Positive signals across recent conversations.'}` +
    linkLine + approveLine;
  return {
    text: `${idx + 1}. ${name} — review candidate (${o.review_score}/100)`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

/**
 * Review Intelligence V1. Every day (default 6:00 PM CST) reads the last 24h of
 * client communications, evaluates each active client's overall journey, scores
 * them as a Google-review candidate (0–100), records qualified clients in the
 * review_opportunities table, and posts the highest-confidence picks to Slack.
 */
async function runReviewIntelligenceReport() {
  // Journey window feeds the "overall client journey" evaluation; the trailing
  // 24h window decides *who* is eligible (must have communicated yesterday).
  const { createdAfter, createdBefore } = getTrailingDaysRange(REVIEW_JOURNEY_DAYS);
  const active = getTrailing24HoursRange();
  const activeCutoffMs = new Date(active.createdAfter).getTime();

  const a = DateTime.fromISO(active.createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(active.createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  const rangeLabel = `${a.toFormat('LLL d, h:mm a')} – ${b.toFormat('LLL d, h:mm a')} ${TIMEZONE}`;
  const dateLabel = b.toFormat('ccc, LLL d, yyyy');
  const journeyLabel = buildSentimentTrailingDaysRangeLabel(createdAfter, createdBefore, REVIEW_JOURNEY_DAYS);

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Review Intelligence V1 (Google review candidates)');
  console.log(`  Activity window (24h): ${rangeLabel}`);
  console.log(`  Journey context: ${REVIEW_JOURNEY_DAYS} day(s)`);
  console.log('═'.repeat(52));

  console.log(`\n[1/5] Fetching Quo calls + SMS (${REVIEW_JOURNEY_DAYS}-day journey window)...\n`);
  const { callData } = await runExport({
    createdAfter,
    createdBefore,
    weeklyCommunications: true,
    includeMessages: true,
    fetchTranscriptForWeekly: false,
  });

  const groups = groupClientTouchpointsByContact(callData);
  const candidates = [...groups.entries()]
    .filter(([, items]) => items.some((it) => itemTimeMs(it) >= activeCutoffMs))
    .sort((x, y) => x[0].localeCompare(y[0], undefined, { sensitivity: 'base' }));

  console.log(
    `\n[2/5] Clients with communications in the last 24h: ${candidates.length} (of ${groups.size} client(s) seen in journey window).`
  );

  if (!OPENAI_API_KEY) {
    console.log('\n[3/5] Skipped — OPENAI_API_KEY is not configured; cannot score candidates.');
    return { rangeLabel, candidates: candidates.length, qualified: 0, reported: 0 };
  }
  if (!candidates.length) {
    console.log('\n[3/5] No active clients to evaluate.');
  }

  console.log('\n[3/5] Scoring candidates (existing sentiment gate → review decision engine)...');
  /** @type {object[]} */
  const opportunities = [];
  let disqualifiedCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const [clientKey, items] = candidates[i];
    const label = displayClientName(clientKey).slice(0, 40);
    process.stdout.write(`  [${i + 1}/${candidates.length}] ${label} ... `);

    let sentiment = null;
    try {
      sentiment = await analyzeWeeklyClientBundleWithLlm(clientKey, items, journeyLabel);
    } catch (err) {
      console.log(`sentiment failed (${err.message}) — skipping`);
      await sleep(SENTIMENT_LLM_DELAY_MS);
      continue;
    }

    // Leverage existing sentiment: a recent negative read disqualifies outright.
    if (sentimentDisqualifies(sentiment)) {
      disqualifiedCount++;
      console.log(`disqualified (sentiment ${sentiment.sentiment}, risk ${sentiment.bad_review_risk})`);
      await sleep(SENTIMENT_LLM_DELAY_MS);
      continue;
    }

    let review = null;
    try {
      review = await analyzeReviewOpportunityWithLlm(clientKey, items, journeyLabel, sentiment);
    } catch (err) {
      console.log(`review scoring failed (${err.message}) — skipping`);
      await sleep(SENTIMENT_LLM_DELAY_MS);
      continue;
    }

    const qualifies = review.qualified && !review.disqualifiers.length && review.review_score >= REVIEW_MIN_SCORE;
    console.log(
      `${review.review_score}/100 · ${review.confidence}${qualifies ? ' · QUALIFIED' : ''}`
    );

    if (qualifies) {
      opportunities.push({
        clientKey,
        clientName: displayClientName(clientKey),
        caseId: extractTrailingCaseDigitsFromClientKey(clientKey) || '',
        phone: (items.find((i) => i.phone)?.phone || '').trim(),
        ...review,
      });
    } else if (!review.qualified || review.disqualifiers.length) {
      disqualifiedCount++;
    }
    await sleep(SENTIMENT_LLM_DELAY_MS);
  }

  opportunities.sort((x, y) => {
    if (y.review_score !== x.review_score) return y.review_score - x.review_score;
    return reviewConfidenceRank(x.confidence) - reviewConfidenceRank(y.confidence);
  });

  console.log(
    `\n[4/5] Persisting ${opportunities.length} qualified opportunit(ies) + creating trackable links...`
  );

  // Surface only the very best (high score + High confidence). Trackable links
  // are minted only for these — no need to create links we won't act on.
  const minConfRank = reviewConfidenceRank(REVIEW_REPORT_MIN_CONFIDENCE);
  const reportItems = opportunities
    .filter(
      (o) => o.review_score >= REVIEW_REPORT_MIN_SCORE && reviewConfidenceRank(o.confidence) <= minConfRank
    )
    .slice(0, REVIEW_REPORT_LIMIT);
  const surfaced = new Set(reportItems);

  let firm = null;
  try {
    firm = await firmStore.getDefaultFirm();
  } catch { /* fall back to no firm */ }
  const publicBase = reviewPublicBase(firm);
  const requestsOn = reviewRequests.isConfigured();

  if (!reviewStoreConfigured() && !requestsOn) {
    console.log('  Skipped (set GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID / GOOGLE_REVIEW_SHEET_ID + Google OAuth to persist).');
  }

  for (const o of opportunities) {
    let oppId = '';
    // Record every qualified opportunity (analytics), but only mint a link for surfaced ones.
    if (reviewStoreConfigured()) {
      try {
        const res = await upsertReviewOpportunity({
          case_id: o.caseId,
          client_name: o.clientName,
          review_score: o.review_score,
          confidence: o.confidence,
          reasoning: o.reasoning,
        });
        oppId = res.id || '';
        console.log(`  ${o.clientName} (case ${o.caseId || '—'}): ${res.action}${surfaced.has(o) ? ' [surfaced]' : ''}`);
      } catch (err) {
        console.warn(`  ${o.clientName}: opportunity store failed — ${err.message}`);
      }
    }

    if (requestsOn && surfaced.has(o)) {
      try {
        const rr = await reviewRequests.createReviewRequest({
          firmId: firm?.id || '',
          caseId: o.caseId,
          clientName: o.clientName,
          clientFirstName: o.clientName.split(/\s+/)[0] || '',
          clientPhone: o.phone,
          source: 'review_intelligence',
          reviewOpportunityId: oppId,
        });
        if (rr && rr.token) {
          o.reviewToken = rr.token;
          o.reviewRequestId = rr.id;
          o.reviewLink = publicBase ? `${publicBase}/r/${rr.token}` : `/r/${rr.token}`;
          // No text is sent here — sending is approval-gated (Slack ✅/reply or analytics page).
        }
      } catch (err) {
        console.warn(`  ${o.clientName}: review link failed — ${err.message}`);
      }
    }
  }

  console.log(
    `\n[5/5] Posting daily Slack report to #${REVIEW_SLACK_CHANNEL} (${reportItems.length} shown; ${disqualifiedCount} disqualified)...`
  );

  const meta = {
    rangeLabel,
    dateLabel,
    candidateCount: candidates.length,
    qualifiedCount: opportunities.length,
    reportedCount: reportItems.length,
    canApprove: requestsOn && quoSend.isConfigured(),
  };

  if (!SLACK_BOT_TOKEN) {
    console.log('  Slack not configured (SLACK_BOT_TOKEN) — printing report:\n');
    const intro = reportItems.length ? buildReviewIntroMessage(meta) : buildReviewEmptyMessage(meta);
    console.log(intro.text);
    reportItems.forEach((o, i) => console.log(buildReviewCandidateMessage(o, i).text + (o.reviewLink ? `  ${o.reviewLink}` : '')));
  } else {
    try {
      const intro = reportItems.length ? buildReviewIntroMessage(meta) : buildReviewEmptyMessage(meta);
      await postSlackMessage({ token: SLACK_BOT_TOKEN, channel: REVIEW_SLACK_CHANNEL, text: intro.text, blocks: intro.blocks });

      // One message per candidate → its ts maps back to the request for ✅ approval.
      for (let i = 0; i < reportItems.length; i++) {
        const o = reportItems[i];
        const msg = buildReviewCandidateMessage(o, i);
        const posted = await postSlackMessage({ token: SLACK_BOT_TOKEN, channel: REVIEW_SLACK_CHANNEL, text: msg.text, blocks: msg.blocks });
        if (o.reviewRequestId && posted?.ts) {
          try {
            await reviewRequests.setSlackMessage(o.reviewRequestId, posted.channel || REVIEW_SLACK_CHANNEL, posted.ts);
          } catch (err) {
            console.warn(`  Could not map Slack message for ${o.clientName}: ${err.message}`);
          }
        }
      }
      console.log(`  Posted intro + ${reportItems.length} candidate message(s) to #${REVIEW_SLACK_CHANNEL}.`);
    } catch (err) {
      console.warn(`  Slack post failed: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Review Intelligence run complete.');
  return {
    rangeLabel,
    candidates: candidates.length,
    qualified: opportunities.length,
    reported: reportItems.length,
    disqualified: disqualifiedCount,
  };
}

// ── Main report runner ────────────────────────────────────────────────────────

async function runDailyReport() {
  const { createdAfter, createdBefore } = getYesterdayRange();
  const dateLabel     = formatDateLabel(createdAfter);
  const dayOfWeek     = formatDayOfWeek(createdAfter);
  const rangeLabel    = buildReportRangeLabel(createdAfter);
  const slackThreads  = process.env.SLACK_INCLUDE_THREADS !== 'false';

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  Daily reports: ${dayOfWeek}, ${dateLabel}`);
  console.log(`  Window: ${rangeLabel}`);
  console.log('═'.repeat(52));

  // 1. Fetch calls (same calendar window as Slack)
  console.log('\n[1/6] Fetching calls...\n');
  const { csvLines, callData, totalFetched, totalSaved } = await runExport({
    createdAfter,
    createdBefore,
  });

  const totalMinutes = Math.round(
    callData.reduce((s, c) => s + (Number(c.duration) || 0), 0) / 60
  );
  const stats = {
    totalFetched,
    totalSaved,
    totalMinutes,
    slackMessages: 0,
    sheetRows: null,
  };

  // 2. Save daily CSV
  console.log('\n[2/6] Saving daily CSV...');
  const csvFilename = `quo_daily_${createdAfter.slice(0, 10)}.csv`;
  fs.writeFileSync(csvFilename, csvLines.join('\n'), 'utf8');
  console.log(`  ${csvFilename} (${totalFetched} calls fetched, ${totalSaved} transcripts)`);

  // 3. Slack — full day, all pages, no message cap; optional threads
  console.log(`\n[3/6] Fetching #${SLACK_CHANNEL} (same window as calls; threads=${slackThreads})...`);
  let slackText = '(Slack not configured — set SLACK_BOT_TOKEN to enable.)';
  if (SLACK_BOT_TOKEN) {
    try {
      const slackMessages = await fetchSlackMessages(
        SLACK_BOT_TOKEN,
        SLACK_CHANNEL,
        createdAfter,
        createdBefore,
        { includeThreads: slackThreads }
      );
      stats.slackMessages = slackMessages.length;
      slackText = formatSlackForPrompt(slackMessages, TIMEZONE, rangeLabel);
      console.log(`  Fetched ${slackMessages.length} top-level message(s) (all pages in range).`);
    } catch (err) {
      slackText = `(Could not fetch Slack messages: ${err.message})`;
      console.warn(`  Warning: ${err.message}`);
    }
  } else {
    console.log('  Skipped (no SLACK_BOT_TOKEN).');
  }

  // 4. Google Sheets — system of record
  console.log('\n[4/6] Fetching lead pipeline from Google Sheets...');
  let sheetText = '(Google Sheets not configured — set GOOGLE_SHEETS_ID and OAuth; run setup-sheets-auth.js.)';
  if (GOOGLE_SHEETS_ID) {
    try {
      const { text, totalRows } = await getLeadPipelineText(
        GOOGLE_SHEETS_ID,
        GOOGLE_SHEETS_RANGE,
        undefined,
        { callData, slackText }
      );
      sheetText = text;
      stats.sheetRows = totalRows;
      console.log(`  Fetched ${totalRows} row(s) from sheet.`);
    } catch (err) {
      sheetText = `(Could not fetch Google Sheet: ${err.message})`;
      console.warn(`  Warning: ${err.message}`);
    }
  } else {
    console.log('  Skipped (not configured).');
  }

  // 5. LLM — Daily Intake & Lead Report (merged lead + call-quality insights).
  let leadAnalysis = '';
  if (!OPENAI_API_KEY) {
    leadAnalysis = 'OPENAI_API_KEY is not configured — skipping AI analysis.';
    console.log('\n[5/6] Skipped Daily Intake & Lead Report (no OPENAI_API_KEY).');
  } else {
    console.log('\n[5/6] Generating Daily Intake & Lead Report (summaries + Slack + sheet)...');
    leadAnalysis = await generateDailyLeadReportAnalysis(
      callData,
      totalFetched,
      createdAfter,
      slackText,
      sheetText,
      rangeLabel,
      stats.slackMessages,
      stats.sheetRows
    );
    console.log('  Done.');
  }

  // 6. Email — Daily Intake & Lead Report + Quo CSV (yesterday)
  console.log('\n[6/6] Sending Daily Intake & Lead Report email (with Quo CSV)...');
  if (!EMAIL_TO.length || !EMAIL_CONFIGURED) {
    console.log('  Email not configured — printing report:\n');
    console.log('\n--- Daily Intake & Lead Report ---\n');
    console.log(leadAnalysis);
  } else {
    const leadSubject = `Daily Intake & Lead Report — ${dayOfWeek}, ${dateLabel}`;
    const leadHtml = buildEmailHtml(leadAnalysis, stats, dateLabel);
    await sendEmail({
      htmlBody: leadHtml,
      plainText: leadAnalysis,
      subject: leadSubject,
      attachments: [{ filename: path.basename(csvFilename), path: csvFilename }],
    });
    console.log(`  Sent to: ${EMAIL_TO.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Done.');
  return { csvFilename, leadAnalysis, stats };
}

if (require.main === module) {
  const arg = process.argv[2];
  let run = runDailyReport;
  if (arg === '--weekly' || arg === 'weekly') run = runWeeklyClientSentimentReport;
  if (arg === '--monthly' || arg === 'monthly') run = runMonthlyNewsletterInsightsReport;
  if (arg === '--missed' || arg === 'missed') run = runMissedClientCallReport;
  if (arg === '--review' || arg === 'review') run = runReviewIntelligenceReport;
  run().catch((err) => {
    console.error('\nError:', err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = {
  runDailyReport,
  runWeeklyClientSentimentReport,
  runMonthlyNewsletterInsightsReport,
  runMissedClientCallReport,
  runReviewIntelligenceReport,
};
