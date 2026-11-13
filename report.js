require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const MailComposer = require('nodemailer/lib/mail-composer');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { runExport, fetchDailyCallStats, fetchContactMap, lookupContactName, lookupContactId, fetchWorkspaceUserMap } = require('./fetch_calls');
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
  INTAKE_MARKETING_ENUMS,
  buildIntakeMarketingBatchPrompt,
  buildIntakeMarketingBriefPrompt,
  buildIntakeGradingPrompt,
} = require('./prompts');
const { fetchSlackMessages, formatSlackForPrompt, postSlackMessage } = require('./slack');
const { upsertReviewOpportunity, isConfigured: reviewStoreConfigured } = require('./reviewOpportunities');
const firmStore = require('./firmStore');
const pg = require('./pgStore');
const reviewRequests = require('./reviewRequests');
const quoSend = require('./quoSend');
const { aggregateLanguages, detectLanguage } = require('./languageDetect');
const { isObviousNoActionSms, isAutoReplyOutboundSms } = require('./smsHelpers');
const {
  getLeadPipelineText,
  fetchSheetData,
  ensureSheetTab,
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

// quo-router phone-staff "available missed call" counts (optional)
const QUO_ROUTER_URL = (process.env.QUO_ROUTER_URL || '').replace(/\/+$/, '');
const QUO_ROUTER_FIRM_ID = process.env.QUO_ROUTER_FIRM_ID || 'ramosjames';
const QUO_ROUTER_REPORT_TOKEN =
  process.env.QUO_ROUTER_REPORT_TOKEN || process.env.REPORT_API_TOKEN || '';

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
/**
 * When nothing clears the bar, still surface the single best positive candidate
 * (flagged as below the bar) so staff always have something to consider.
 * Set REVIEW_REPORT_ALWAYS_SHOW_BEST=false to keep the old "nothing today" behavior.
 */
const REVIEW_REPORT_ALWAYS_SHOW_BEST =
  String(process.env.REVIEW_REPORT_ALWAYS_SHOW_BEST ?? 'true').trim().toLowerCase() !== 'false';
/** Token budget for the per-client review-scoring JSON call. */
const OPENAI_REVIEW_MAX_TOKENS = clampInt(process.env.OPENAI_REVIEW_MAX_COMPLETION_TOKENS, 4096, 512, 32000);
const OPENAI_INTAKE_GRADING_MAX_TOKENS = clampInt(process.env.OPENAI_INTAKE_GRADING_MAX_COMPLETION_TOKENS, 6000, 1024, 32000);
const INTAKE_GRADING_MIN_SECONDS = clampInt(process.env.INTAKE_GRADING_MIN_SECONDS, 90, 30, 600);
const INTAKE_GRADING_MIN_TRANSCRIPT_CHARS = clampInt(process.env.INTAKE_GRADING_MIN_TRANSCRIPT_CHARS, 350, 80, 5000);
const INTAKE_GRADING_MAX_CALLS = clampInt(process.env.INTAKE_GRADING_MAX_CALLS, 60, 1, 200);
/** Client-language lookback: how many days of transcripts + SMS to scan. */
const CLIENT_LANGUAGE_LOOKBACK_DAYS = clampInt(process.env.CLIENT_LANGUAGE_LOOKBACK_DAYS, 90, 1, 365);
const CLIENT_LANGUAGES_TAB = process.env.GOOGLE_CLIENT_LANGUAGES_TAB || 'Client Languages';

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

// ── Per-firm reporting context ────────────────────────────────────────────────
// Each run executes inside a firm context so the Quo key, phone lines, email
// recipients, Slack channels, company name, and sheet IDs come from that firm.
// AsyncLocalStorage carries it safely through awaits and across concurrent job
// runs (e.g. the daily + missed crons both fire at 07:00). When no context is
// active, firmCtx() resolves to the env-derived defaults — identical to before.
const { AsyncLocalStorage } = require('async_hooks');
const firmCtxStore = new AsyncLocalStorage();
function firmCtx() {
  return firmCtxStore.getStore() || firmStore.reportConfigForFirm(null);
}

/**
 * Run a job once per active firm, each inside its own firm context. Per-firm
 * errors are caught so one firm can't abort the others. `opts.firmId` scopes the
 * run to a single firm (used by the manual trigger for testing).
 */
async function runForAllFirms(jobFn, opts = {}) {
  const firms = await firmStore.loadActiveFirms();
  const list = opts.firmId ? firms.filter((f) => f.id === opts.firmId) : firms;
  if (opts.firmId && !list.length) {
    console.warn(`  No active firm with id "${opts.firmId}" — nothing to run.`);
    return { firms: [], results: [] };
  }
  const results = [];
  for (const firm of list) {
    const ctx = firmStore.reportConfigForFirm(firm);
    if (list.length > 1) console.log(`\n${'━'.repeat(52)}\n▶ Firm: ${ctx.firmName} (${ctx.id})\n${'━'.repeat(52)}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await firmCtxStore.run(ctx, async () => {
      try {
        const out = await jobFn(opts);
        return { firmId: ctx.id, ok: true, result: out };
      } catch (err) {
        console.error(`  [firm ${ctx.id}] job failed: ${err.message}`);
        return { firmId: ctx.id, ok: false, error: err.message };
      }
    });
    results.push(r);
  }
  return { firms: list.map((f) => f.id), results };
}

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
    COMPANY_NAME: firmCtx().firmName,
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
  const prompt = buildMonthlyBatchExtractionPrompt({ COMPANY_NAME: firmCtx().firmName, items });
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
    COMPANY_NAME: firmCtx().firmName,
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
    COMPANY_NAME: firmCtx().firmName,
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
    <p style="margin:6px 0 0;opacity:.85;font-size:13px">${firmCtx().firmName} · ${rangeLabel}</p>
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
    <p style="margin:6px 0 0;opacity:.85;font-size:13px">${firmCtx().firmName} · ${escapeHtml(rangeLabel)}</p>
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
    COMPANY_NAME: firmCtx().firmName,
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

/**
 * Line-based Markdown → email-safe HTML. Handles headings, ordered/unordered
 * lists, GitHub-style tables (with a separator row), blockquotes, and inline
 * bold/links/code. Block-by-block parsing avoids the ordering pitfalls of the
 * old chained global-regex approach (stray <br>s, orphaned <p> tags, tables
 * broken by the newline pass).
 */
function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" style="color:#0d9488;font-weight:600;text-decoration:none;border-bottom:1px solid #99f6e4" target="_blank">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0A1C40">$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px">$1</code>');

  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const isTableSep = (l) => l != null && l.includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l);
  const rowCells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const startsBlock = (l) =>
    /^\s*(#{1,3})\s+/.test(l) || /^\s*[-*•]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^\s*>\s?/.test(l);

  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^\s*###\s+(.+)$/))) {
      out.push(`<h3 style="color:#1e293b;margin:20px 0 6px;font-size:15px;font-weight:700">${inline(m[1])}</h3>`);
      i++; continue;
    }
    if ((m = line.match(/^\s*#{1,2}\s+(.+)$/))) {
      out.push(`<h2 style="color:#0A1C40;margin:26px 0 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;font-weight:800;border-bottom:2px solid #0d9488;padding-bottom:6px">${inline(m[1])}</h2>`);
      i++; continue;
    }

    // Table — current line has cells and the next line is a --- separator.
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const header = rowCells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        body.push(rowCells(lines[i])); i++;
      }
      const thead = '<tr>' + header.map((c) =>
        `<th style="padding:9px 12px;background:#0A1C40;color:#fff;text-align:left;font-size:12px;font-weight:700;letter-spacing:.02em">${inline(c)}</th>`).join('') + '</tr>';
      const tbody = body.map((r, ri) =>
        `<tr style="background:${ri % 2 ? '#f8fafc' : '#ffffff'}">` +
        r.map((c) => `<td style="padding:8px 12px;border-top:1px solid #e2e8f0;font-size:13px;vertical-align:top;line-height:1.5;color:#334155">${inline(c)}</td>`).join('') +
        '</tr>').join('');
      out.push(`<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;width:100%;margin:14px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">${thead}${tbody}</table>`);
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*•]\s+/, ''))); i++;
      }
      out.push(`<ul style="margin:10px 0 14px;padding-left:22px">${items.map((it) => `<li style="margin:5px 0;line-height:1.55">${it}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+\.\s+/, ''))); i++;
      }
      out.push(`<ol style="margin:10px 0 14px;padding-left:22px">${items.map((it) => `<li style="margin:5px 0;line-height:1.55">${it}</li>`).join('')}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(inline(lines[i].replace(/^\s*>\s?/, ''))); i++;
      }
      out.push(`<blockquote style="margin:12px 0;padding:10px 16px;border-left:3px solid #0d9488;background:#f0fdfa;color:#334155;border-radius:0 6px 6px 0">${quote.join('<br>')}</blockquote>`);
      continue;
    }

    const para = [];
    while (
      i < lines.length && lines[i].trim() && !startsBlock(lines[i]) &&
      !(lines[i].includes('|') && isTableSep(lines[i + 1]))
    ) {
      para.push(inline(lines[i])); i++;
    }
    out.push(`<p style="margin:10px 0;line-height:1.7;font-size:14px">${para.join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** A small stat chip (one of the four metrics beside the hero number). */
function emailStatChip(value, label) {
  const v = String(value == null ? '—' : value);
  return `<td width="25%" style="padding:0 5px" valign="top">
    <div style="background:#0e2f57;border:1px solid #1c477d;border-radius:10px;padding:12px 6px;text-align:center">
      <div style="font-size:19px;font-weight:800;color:#ffffff;line-height:1.1">${v}</div>
      <div style="font-size:9px;color:#8fb0d8;text-transform:uppercase;letter-spacing:.5px;margin-top:3px">${label}</div>
    </div>
  </td>`;
}

function buildEmailHtml(analysis, stats, dateLabel) {
  const totalMinHr = stats.totalMinutes >= 60
    ? `${Math.floor(stats.totalMinutes / 60)}h ${stats.totalMinutes % 60}m`
    : `${stats.totalMinutes}m`;
  const title = 'Daily Intake &amp; Lead Report';

  const sheetShown =
    stats.sheetRows != null && Number.isFinite(stats.sheetRows)
      ? String(stats.sheetRows)
      : '—';

  const chips = [
    emailStatChip(stats.totalSaved, 'Transcripts'),
    emailStatChip(totalMinHr, 'Talk time'),
    emailStatChip(stats.slackMessages ?? '—', 'Slack leads'),
    emailStatChip(sheetShown, 'Pipeline'),
  ].join('');

  const preheader = `${stats.totalFetched} calls · ${stats.totalSaved} transcripts · ${totalMinHr} talk time · ${stats.slackMessages ?? '—'} Slack leads — ${dateLabel}`;
  const footerNote = `Quo transcript CSV attached &nbsp;·&nbsp; Weekly client sentiment is emailed separately &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`;
  const body = analysis.trim()
    ? markdownToHtml(analysis)
    : '<p style="margin:10px 0;line-height:1.7;font-size:14px"><em>(No analysis body — check console warning from OpenAI step.)</em></p>';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:#0A1C40;-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0A1C40;font-size:1px;line-height:1px">${preheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0A1C40">
    <tr>
      <td align="center" style="padding:0 0 26px">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          <tr>
            <td style="padding:30px 30px 22px">
              <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#5eead4">${firmCtx().firmName}</div>
              <div style="font-size:25px;font-weight:800;color:#ffffff;margin-top:6px;letter-spacing:.2px">📌 ${title}</div>
              <div style="font-size:13px;color:#a9b8d6;margin-top:4px">${dateLabel}</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px">
                <tr>
                  <td width="40%" valign="top" style="padding-right:10px">
                    <div style="background:#0d8f86;background:linear-gradient(135deg,#12b3a6,#0d8f86);border-radius:14px;padding:18px">
                      <div style="font-size:38px;font-weight:800;color:#ffffff;line-height:1">${stats.totalFetched}</div>
                      <div style="font-size:12px;color:#d6fff8;margin-top:4px">calls handled today</div>
                    </div>
                  </td>
                  <td width="60%" valign="top">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${chips}</tr></table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border-radius:16px;padding:22px 30px 30px;color:#374a63">
              <div style="margin:0 0 18px;padding:11px 14px;border-left:3px solid #12b3a6;background:#f0fdfa;border-radius:0 8px 8px 0;color:#334155;font-size:13px;line-height:1.55">
                Executive &amp; operational intake brief across <strong style="color:#0A1C40">Quo</strong>, <strong style="color:#0A1C40">Slack</strong>, and <strong style="color:#0A1C40">Google Sheets</strong>.
              </div>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 20px;text-align:center;font-size:11px;color:#7f92b5;line-height:1.6">
              ${footerNote}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendEmail({ htmlBody, plainText, subject, attachments = [], to, from }) {
  const rawTo = Array.isArray(to) && to.length ? to : firmCtx().emailTo;
  const recipients = firmStore.parseEmailList(Array.isArray(rawTo) ? rawTo.join(',') : rawTo);
  if (!recipients.length) {
    throw new Error('Invalid To header: no valid email addresses (use name@domain.com, not display names)');
  }
  const mail = {
    from: from || firmCtx().emailFrom || EMAIL_FROM,
    to: recipients,
    subject,
    text: plainText,
    html: htmlBody,
    newline: '\r\n',
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
  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
  } catch (err) {
    if (/invalid to header/i.test(err.message || '')) {
      throw new Error(`Invalid To header (${recipients.join(', ')}). Use comma-separated addresses like name@domain.com.`);
    }
    throw err;
  }
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
    apiKey: firmCtx().quoApiKey,
    phoneNumbersFilter: firmCtx().quoPhoneNumbers,
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

  const subject = `${firmCtx().firmName} — Monthly client newsletter content ideas (from call themes)`;
  const html = buildMonthlyInsightsEmailHtml(bodyMd, rangeLabel);

  if (!firmCtx().monthlyEmailTo.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured — printing monthly insights body:\n');
    console.log(bodyMd);
  } else {
    await sendEmail({
      htmlBody: html,
      plainText: bodyMd,
      subject,
      attachments: [],
      to: firmCtx().monthlyEmailTo,
    });
    console.log(`\n  Sent monthly insights to: ${firmCtx().monthlyEmailTo.join(', ')}`);
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
  return firmCtx().sheets.negativeSentimentId || firmCtx().sheets.weeklySentimentId;
}

function weeklyNegativeSnapshotRangeInput() {
  return firmCtx().sheets.negativeSentimentRange || 'Negative Sentiment';
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

/**
 * Each weekly run adds one sentiment history row per case in Case Tracker.
 * One row per Quo contact (clientKey), same grain as the weekly sheet/email.
 * Case Tracker joins by trailing case digits; multiple contacts may share a case #.
 * The Contact Sentiment tab shows contact-level rows; Unknown when last interaction is 30+ days.
 */
async function appendLatestSentimentRows(rollups, createdAfter, createdBefore, rangeLabel) {
  const baseUrl = (
    process.env.CASE_TRACKER_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, '');
  // Prefer new secret key names; keep legacy service_role JWT as fallback.
  const serviceKey = (
    process.env.CASE_TRACKER_SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.CASE_TRACKER_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
  if (!baseUrl || !serviceKey) {
    console.warn(
      '  Client sentiment: skipped (set CASE_TRACKER_SUPABASE_URL and CASE_TRACKER_SUPABASE_SECRET_KEY).'
    );
    return;
  }
  if (!rollups?.length) {
    console.log('  Client sentiment: no rollups to save.');
    return;
  }

  const scoredAt = new Date().toISOString();
  // One row per Quo contact (clientKey) — same grain as the weekly sheet / email.
  // Trailing case digits are stored for Case Tracker joins but do not collapse contacts.
  const byContact = new Map();
  for (const rollup of rollups) {
    const clientKey = String(rollup.clientKey || '').trim();
    if (!clientKey) continue;
    const caseNumber = extractTrailingCaseDigitsFromClientKey(clientKey);
    if (!caseNumber) continue;
    const score = Number(rollup.score);
    byContact.set(clientKey, {
      case_number: caseNumber,
      client_name: clientKey,
      sentiment: weeklySentimentWord(rollup.holisticSentiment),
      score: Number.isFinite(score) ? Math.round(score) : null,
      reason_summary: sheetCellOneLine(stripMarkdownBold(rollup.summary || ''), 2000) || null,
      // Keep markdown labels (dates) so Case Tracker can show "V1 Oct 30" and
      // later rewrite the Quo href to the Slack router post in the case channel.
      evidence_urls: rollup.links && rollup.links !== '—' ? String(rollup.links) : null,
      scored_at: scoredAt,
      window_start: createdAfter || null,
      window_end: createdBefore || null,
      week_label: rangeLabel || null,
      event_key: `quo:${clientKey}:${createdAfter || ''}:${createdBefore || ''}`,
      source: 'quo',
      updated_at: scoredAt,
    });
  }
  const rows = [...byContact.values()];
  if (!rows.length) {
    console.log('  Client sentiment: no rows had a trailing case number.');
    return;
  }

  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    const response = await fetch(`${baseUrl}/rest/v1/case_client_sentiment?on_conflict=event_key`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Supabase sentiment upsert failed (${response.status}): ${detail}`);
    }
  }
  console.log(`  Client sentiment: saved ${rows.length} case reading(s) to Supabase.`);
}

/** Stable Case Tracker key: needs:{phoneLast10|cid|unknown}:{missed|callback|sms} */
function needsResponseEventKey(r) {
  const phoneKey = last10Digits(r.phone) || last10Digits(r.contact) || 'unknown';
  const kindPart = r.kind === 'callback' ? 'callback' : r.kind === 'sms' ? 'sms' : 'missed';
  return `needs:${phoneKey}:${kindPart}`;
}

function phoneKeyFromNeedsEventKey(eventKey) {
  const m = /^needs:([^:]+):(missed|callback|sms)$/.exec(String(eventKey || ''));
  return m ? m[1] : null;
}

/**
 * Staff follow-up that clears an open needs-response item:
 * outbound text after detected_at, or connected human call with the same
 * 2-minute grace used for callback returns. A connected call to another
 * Quo contact on the same case number counts too (co-clients share a case).
 */
function laterConnectedCall(events, sinceIso) {
  return (events || []).some(
    (ev) => ev && ev.recordType !== 'sms' && isConnectedReturnCall(ev, sinceIso)
  );
}

/** Calls for every client contact whose name ends in this case number. */
function callsForCaseNumber(byPhone, caseNumber) {
  const wanted = String(caseNumber || '').trim();
  if (!wanted) return [];
  const events = [];
  for (const group of byPhone.values()) {
    const anchor = (group || []).find((c) => isClientContactName(c.contact));
    const found = anchor ? extractTrailingCaseDigitsFromClientKey(anchor.contact) : null;
    if (found !== wanted) continue;
    events.push(...group);
  }
  return events;
}

function hasStaffResponseSince(group, sinceIso) {
  if (!sinceIso) return false;
  const sinceMs = new Date(sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) return false;
  for (const ev of group || []) {
    if (!ev || !ev.timestamp) continue;
    const t = new Date(ev.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    if (ev.recordType === 'sms') {
      if (t <= sinceMs) continue;
      // Canned auto-replies are not a human follow-up.
      if (isStaffClearingOutboundSms(ev)) return true;
      continue;
    }
    // Calls: 2-minute grace so the originating miss/callback leg is not "the return".
    if (t <= sinceMs + 120 * 1000) continue;
    if (isConnectedHumanCall(ev)) return true;
  }
  return false;
}

function buildNeedsResponseDbRow(r, rangeLabel, nowIso) {
  const caseNumber = extractTrailingCaseDigitsFromClientKey(r.contact);
  if (!caseNumber) return null;
  let reasonCode = 'other';
  if (r.kind === 'sms') reasonCode = 'sms';
  else if (r.kind === 'callback') reasonCode = 'callback';
  else if (/sona|ai/i.test(String(r.reason || ''))) reasonCode = 'sona';
  else reasonCode = 'missed_call';
  const details =
    r.kind === 'sms'
      ? sheetCellOneLine(String(r.smsPreview || r.details || r.callbackWhy || ''), 500) || null
      : sheetCellOneLine(String(r.callbackWhy || r.details || ''), 500) || null;
  return {
    case_number: caseNumber,
    client_name: String(r.contact || '').trim() || caseNumber,
    phone: r.phone || null,
    channel: r.kind === 'sms' ? 'sms' : 'call',
    reason: String(r.reason || reasonCode).trim() || reasonCode,
    reason_code: reasonCode,
    status: 'open',
    detected_at: r.missedAtIso || nowIso,
    report_window_label: rangeLabel || null,
    attorney_name: r.attorney || null,
    paralegal_name: r.paralegal || null,
    legal_assistant_name: r.legalAssistant || null,
    quo_line: r.line || null,
    evidence_url: r.link || null,
    details,
    event_key: needsResponseEventKey(r),
    source: 'quo-reporting',
    resolved_at: null,
    resolved_by: null,
    updated_at: nowIso,
  };
}

function caseTrackerWriteConfig() {
  const cfg = caseTrackerRestConfig();
  if (!cfg) return null;
  return {
    ...cfg,
    headers: { ...cfg.headers, 'Content-Type': 'application/json' },
  };
}

/** @returns {Promise<{ id: string, event_key: string, phone: string|null, case_number: string|null, detected_at: string }[]>} */
async function listOpenNeedsResponseRows(cfg) {
  /** @type {{ id: string, event_key: string, phone: string|null, case_number: string|null, detected_at: string }[]} */
  const openRows = [];
  let from = 0;
  for (;;) {
    const openRes = await fetch(
      `${cfg.baseUrl}/rest/v1/case_needs_response?status=eq.open&select=id,event_key,phone,case_number,detected_at&order=detected_at&offset=${from}&limit=1000`,
      { headers: cfg.headers }
    );
    if (!openRes.ok) {
      const detail = (await openRes.text()).slice(0, 200);
      throw new Error(`Needs-response open list failed (${openRes.status}): ${detail}`);
    }
    const page = await openRes.json();
    if (!Array.isArray(page) || !page.length) break;
    for (const row of page) openRows.push(row);
    if (page.length < 1000) break;
    from += page.length;
  }
  return openRows;
}

/**
 * Touches that can clear an open item, keyed by phone last-10.
 * Starts from the morning window, then adds the Quo ledger back to the oldest open row.
 */
async function clearanceMapForOpenRows(openRows, byPhoneTouch, nowIso) {
  /** @type {Map<string, object[]>} */
  const clearanceMap = new Map();
  for (const [key, group] of byPhoneTouch || []) clearanceMap.set(key, [...(group || [])]);
  if (!openRows.length || !pg.isEnabled()) return clearanceMap;
  try {
    const oldestMs = openRows
      .map((row) => new Date(row.detected_at).getTime())
      .filter((ms) => Number.isFinite(ms));
    if (!oldestMs.length) return clearanceMap;
    const oldestIso = new Date(Math.min(...oldestMs)).toISOString();
    await pg.ensureSchema();
    const [ledgerCalls, ledgerMsgs] = await Promise.all([
      pg.listQuoCallsInWindow(oldestIso, nowIso),
      pg.listQuoMessagesInWindow(oldestIso, nowIso),
    ]);
    for (const row of ledgerCalls) {
      const parts = row.participants && typeof row.participants === 'object' ? row.participants : {};
      const externals = Array.isArray(parts.external) ? parts.external : [];
      const inbound = isIncomingDirection(row.direction);
      const phone = String(
        inbound ? parts.from || externals[0] || '' : parts.to || externals[0] || ''
      ).trim();
      const key = last10Digits(phone);
      if (!key) continue;
      if (!clearanceMap.has(key)) clearanceMap.set(key, []);
      clearanceMap.get(key).push({
        recordType: 'call',
        timestamp:
          isoTs(row.completed_at) || isoTs(row.answered_at) || isoTs(row.created_at) || '',
        direction: row.direction || '',
        status: row.status || '',
        aiHandled: row.ai_handled ? 'ai-agent' : null,
        phone,
      });
    }
    for (const row of ledgerMsgs) {
      const payload = row.payload_json && typeof row.payload_json === 'object' ? row.payload_json : {};
      const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
      const resource = data.resource || data.object || payload.object || {};
      const from = String(resource.from || '').trim();
      const to = String(resource.to || '').trim();
      const inbound = isIncomingDirection(row.direction);
      const phone = inbound ? from || to : to || from;
      const key = last10Digits(phone);
      if (!key) continue;
      if (!clearanceMap.has(key)) clearanceMap.set(key, []);
      clearanceMap.get(key).push({
        recordType: 'sms',
        timestamp: isoTs(row.created_at) || '',
        direction: row.direction || '',
        phone,
        body: String(resource.text || resource.body || resource.message || '').trim(),
      });
    }
    console.log(
      `  Needs response clearance: ledger ${ledgerCalls.length} call(s), ${ledgerMsgs.length} text(s) since oldest open.`
    );
  } catch (err) {
    console.warn(`  Needs response clearance ledger expand skipped: ${err.message}`);
  }
  return clearanceMap;
}

/**
 * Phone last-10 ↔ case number from Quo directory contacts (name ends in the
 * case number) plus the tracker's client phone. Used so a call to one
 * co-client can clear an open item on another phone for the same case.
 */
async function fetchCasePhoneIndex(cfg) {
  /** @type {Map<string, Set<string>>} */
  const phonesByCase = new Map();
  /** @type {Map<string, Set<string>>} */
  const casesByPhone = new Map();
  const add = (caseNumber, phone) => {
    const cn = String(caseNumber || '').trim();
    const key = last10Digits(phone);
    if (!cn || !key) return;
    if (!phonesByCase.has(cn)) phonesByCase.set(cn, new Set());
    phonesByCase.get(cn).add(key);
    if (!casesByPhone.has(key)) casesByPhone.set(key, new Set());
    casesByPhone.get(key).add(cn);
  };
  const pages = async (url, onRow) => {
    let from = 0;
    for (;;) {
      const response = await fetch(`${url}&offset=${from}&limit=1000`, { headers: cfg.headers });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(`Case phone index failed (${response.status}): ${detail}`);
      }
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) onRow(row);
      if (rows.length < 1000) break;
      from += rows.length;
    }
  };
  try {
    await pages(
      `${cfg.baseUrl}/rest/v1/case_quo_contacts?select=phone,display_name&order=id`,
      (row) => add(extractTrailingCaseDigitsFromClientKey(row.display_name), row.phone)
    );
    await pages(
      `${cfg.baseUrl}/rest/v1/case_tracker_entries?select=case_number,client_phone&order=case_number`,
      (row) => add(row.case_number, row.client_phone)
    );
  } catch (err) {
    console.warn(`  Needs response case-phone index skipped: ${err.message}`);
  }
  return { phonesByCase, casesByPhone };
}

function siblingCaseCalls(clearanceMap, phonesByCase, caseNumber, ownPhoneKey) {
  const keys = phonesByCase.get(String(caseNumber || '').trim());
  if (!keys) return [];
  const events = [];
  for (const key of keys) {
    if (key === ownPhoneKey) continue;
    for (const ev of clearanceMap.get(key) || []) {
      if (ev && ev.recordType !== 'sms') events.push(ev);
    }
  }
  return events;
}

async function patchNeedsResponseResolved(cfg, ids, nowIso) {
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const patch = await fetch(
      `${cfg.baseUrl}/rest/v1/case_needs_response?status=eq.open&id=in.(${chunk.map(encodeURIComponent).join(',')})`,
      {
        method: 'PATCH',
        headers: { ...cfg.headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'resolved',
          resolved_at: nowIso,
          resolved_by: 'auto:responded',
          updated_at: nowIso,
        }),
      }
    );
    if (!patch.ok) {
      const detail = (await patch.text()).slice(0, 200);
      console.warn(`  Needs response: auto-responded patch failed (${patch.status}): ${detail}`);
    }
  }
}

/**
 * Mark open needs-response rows resolved when the ledger (plus any extra touches)
 * shows an outbound text or a connected human call after the item was detected.
 * Does not add new rows and does not send email.
 */
async function resolveRespondedNeedsResponse(byPhoneTouch = new Map()) {
  const cfg = caseTrackerWriteConfig();
  const now = new Date().toISOString();
  if (!cfg) {
    return { skipped: true, resolveIds: [], openByKey: new Map(), now, cfg: null };
  }
  const openRows = await listOpenNeedsResponseRows(cfg);
  const clearanceMap = await clearanceMapForOpenRows(openRows, byPhoneTouch, now);
  const { phonesByCase } = await fetchCasePhoneIndex(cfg);
  const openByKey = new Map(openRows.map((row) => [String(row.event_key), row]));
  const resolveIds = [];
  for (const row of openRows) {
    const phoneKey =
      phoneKeyFromNeedsEventKey(row.event_key) || last10Digits(row.phone) || '';
    const group = phoneKey ? clearanceMap.get(phoneKey) || [] : [];
    const clearedOnPhone = hasStaffResponseSince(group, row.detected_at);
    const clearedOnCase = laterConnectedCall(
      siblingCaseCalls(clearanceMap, phonesByCase, row.case_number, phoneKey),
      row.detected_at
    );
    if (!clearedOnPhone && !clearedOnCase) continue;
    resolveIds.push(row.id);
    openByKey.delete(String(row.event_key));
  }
  if (resolveIds.length) {
    await patchNeedsResponseResolved(cfg, resolveIds, now);
    console.log(`  Needs response: auto-resolved ${resolveIds.length} after outbound text / returned call.`);
  }
  return { skipped: false, resolveIds, openByKey, now, cfg };
}

/**
 * Live clear for one Quo webhook: outbound text, or a connected human call.
 * Same rules as the sweep (outbound SMS any time after detected_at; call needs the 2-minute grace).
 */
async function clearNeedsResponseForTouch(touch) {
  if (!touch?.phone || !touch?.timestamp) return 0;
  if (touch.recordType === 'sms') {
    if (isIncomingDirection(touch.direction)) return 0;
  } else if (touch.recordType === 'call') {
    if (!isConnectedHumanCall(touch)) return 0;
  } else {
    return 0;
  }
  const phoneKey = last10Digits(touch.phone);
  if (!phoneKey) return 0;
  const cfg = caseTrackerWriteConfig();
  if (!cfg) return 0;
  const openRows = await listOpenNeedsResponseRows(cfg);
  const caseNumbers =
    touch.recordType === 'call'
      ? (await fetchCasePhoneIndex(cfg)).casesByPhone.get(phoneKey) || new Set()
      : new Set();
  const now = new Date().toISOString();
  const resolveIds = [];
  for (const row of openRows) {
    const rowKey = phoneKeyFromNeedsEventKey(row.event_key) || last10Digits(row.phone) || '';
    const samePhone = rowKey === phoneKey;
    const sameCase =
      touch.recordType === 'call' &&
      row.case_number &&
      caseNumbers.has(String(row.case_number).trim());
    if (!samePhone && !sameCase) continue;
    if (samePhone) {
      if (!hasStaffResponseSince([touch], row.detected_at)) continue;
    } else if (!isConnectedReturnCall(touch, row.detected_at)) {
      continue;
    }
    resolveIds.push(row.id);
  }
  if (!resolveIds.length) return 0;
  await patchNeedsResponseResolved(cfg, resolveIds, now);
  console.log(`  Needs response: live-cleared ${resolveIds.length} for ${phoneKey}.`);
  return resolveIds.length;
}

/** Daytime backstop: open queue vs ledger only. No LLM, no new items, no email. */
async function runNeedsResponseClearSweep() {
  console.log('Needs response clear sweep — open items vs call/text activity.');
  const result = await resolveRespondedNeedsResponse(new Map());
  if (result.skipped) {
    console.warn(
      '  Needs response clear sweep skipped (set CASE_TRACKER_SUPABASE_URL and CASE_TRACKER_SUPABASE_SECRET_KEY).'
    );
    return result;
  }
  console.log(
    `  Needs response clear sweep done: auto-resolved ${result.resolveIds.length}, still open ${result.openByKey.size}.`
  );
  return result;
}

/**
 * Sync Client Needs Response into Case Tracker.
 * - Keeps open rows until outbound text, connected return call (2-min rule), or manual close.
 * - Does NOT clear just because an item aged out of the trailing-24h email window.
 * - Returns only newly opened rows for the morning email.
 */
async function syncNeedsResponseToCaseTracker(outstanding, rangeLabel, byPhoneTouch = new Map()) {
  const cleared = await resolveRespondedNeedsResponse(byPhoneTouch);
  if (cleared.skipped || !cleared.cfg) {
    console.warn(
      '  Needs response: skipped Case Tracker sync (set CASE_TRACKER_SUPABASE_URL and CASE_TRACKER_SUPABASE_SECRET_KEY).'
    );
    return { emailNew: outstanding || [], inserted: 0, autoResolved: 0 };
  }

  const { now, cfg, openByKey, resolveIds } = cleared;
  /** @type {object[]} */
  const emailNew = [];
  /** @type {object[]} */
  const upserts = [];
  for (const r of outstanding || []) {
    const row = buildNeedsResponseDbRow(r, rangeLabel, now);
    if (!row) continue;
    if (openByKey.has(row.event_key)) continue; // already on the Case Tracker queue — not new for email
    upserts.push(row);
    emailNew.push(r);
  }

  for (let index = 0; index < upserts.length; index += 200) {
    const chunk = upserts.slice(index, index + 200);
    const response = await fetch(`${cfg.baseUrl}/rest/v1/case_needs_response?on_conflict=event_key`, {
      method: 'POST',
      headers: {
        ...cfg.headers,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Supabase needs-response upsert failed (${response.status}): ${detail}`);
    }
  }

  console.log(
    `  Needs response: Case Tracker +${upserts.length} new open · email ${emailNew.length} new · still-open queue ${openByKey.size + upserts.length} (after ${resolveIds.length} auto-resolved).`
  );
  return { emailNew, inserted: upserts.length, autoResolved: resolveIds.length };
}

function caseTrackerRestConfig() {
  const baseUrl = (
    process.env.CASE_TRACKER_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, '');
  const serviceKey = (
    process.env.CASE_TRACKER_SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.CASE_TRACKER_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
  if (!baseUrl || !serviceKey) return null;
  return {
    baseUrl,
    serviceKey,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
  };
}

/**
 * Case number → legal assistant name from Case Tracker (DocketFlow assignment).
 * Same rule as the Needs Response page: first assigned contact whose role is legal_assistant.
 */
async function fetchCaseTrackerLegalAssistantByCase() {
  const cfg = caseTrackerRestConfig();
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!cfg) return map;

  const assistants = new Map();
  {
    const response = await fetch(
      `${cfg.baseUrl}/rest/v1/contacts?role=eq.legal_assistant&select=id,name`,
      { headers: cfg.headers }
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Legal assistant contacts failed (${response.status}): ${detail}`);
    }
    const rows = await response.json();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row.id || '').trim();
      const name = String(row.name || '').trim();
      if (id && name) assistants.set(id, name);
    }
  }
  if (!assistants.size) return map;

  let from = 0;
  for (;;) {
    const response = await fetch(
      `${cfg.baseUrl}/rest/v1/cases?select=case_number,assigned_contact_ids&order=case_number&offset=${from}&limit=1000`,
      { headers: cfg.headers }
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Case assignments failed (${response.status}): ${detail}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      const ids = Array.isArray(row.assigned_contact_ids) ? row.assigned_contact_ids : [];
      let name = '';
      for (const id of ids) {
        const hit = assistants.get(String(id || '').trim());
        if (hit) {
          name = hit;
          break;
        }
      }
      if (!name) continue;
      const raw = String(row.case_number || '').trim();
      const digits = (raw.match(/(\d+)$/) || [])[1] || '';
      if (digits) map.set(digits, name);
      const unpadded = digits.replace(/^0+(?=\d)/, '');
      if (unpadded) map.set(unpadded, name);
    }
    if (rows.length < 1000) break;
    from += rows.length;
  }
  return map;
}

function legalAssistantForCase(caseId, legalAssistantMap) {
  if (!caseId || !legalAssistantMap?.size) return '';
  return legalAssistantMap.get(String(caseId)) || '';
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
  const weeklySentimentId = firmCtx().sheets.weeklySentimentId;
  if (!weeklySentimentId || !hasOAuth) return [];

  const rangeForSheets = normalizeWeeklySentimentSheetRange(firmCtx().sheets.weeklySentimentRange);
  const appendAnchorA1 = await resolveAppendAnchorA1(weeklySentimentId, rangeForSheets);
  const prefix = appendAnchorA1.slice(0, Math.max(0, appendAnchorA1.lastIndexOf('!')));
  const lastCol = weeklySheetColLetter0Based(WEEKLY_SENTIMENT_SHEET_HEADER.length - 1);
  const scanRows = Math.min(
    50000,
    Math.max(500, parseInt(process.env.GOOGLE_WEEKLY_SENTIMENT_SCAN_MAX_ROWS || '8000', 10) || 8000)
  );
  const existing = await fetchSheetData(
    weeklySentimentId,
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
    apiKey: firmCtx().quoApiKey,
    phoneNumbersFilter: firmCtx().quoPhoneNumbers,
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

  if (firmCtx().sheets.caseRosterId) {
    const hasOAuth =
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN;
    if (hasOAuth) {
      try {
        const rosterRows = await fetchSheetData(
          firmCtx().sheets.caseRosterId,
          firmCtx().sheets.caseRosterRange
        );
        const rosterMap = rawRowsToCaseRosterMap(rosterRows, firmCtx().sheets.rosterColumns);
        enrichRollupsWithCaseRoster(rollups, rosterMap);
        console.log(`  Case roster sheet: ${rosterMap.size} row(s) indexed for attorney/paralegal.`);
      } catch (err) {
        console.warn(`  Case roster fetch failed (weekly email still sends): ${err.message}`);
      }
    } else {
      console.warn(
        '  Case roster sheet is set but Google OAuth env vars are incomplete — attorney/paralegal columns omitted.'
      );
    }
  }

  if (!onlyLatest && firmCtx().sheets.weeklySentimentId) {
    try {
      await syncWeeklySentimentToGoogleSheets({
        spreadsheetId: firmCtx().sheets.weeklySentimentId,
        rangeInput: firmCtx().sheets.weeklySentimentRange,
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
  if (!onlyLatest && firmCtx().sheets.weeklySentimentId && OPENAI_API_KEY) {
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
    const subject = `${firmCtx().firmName} — Weekly Client Negative Sentiment - ${rangeLabel}`;
    const html = buildWeeklyNegativeSentimentEmailHtml(rangeLabel, emailRollups);

    if (!firmCtx().weeklyEmailTo.length || !EMAIL_CONFIGURED) {
      console.log('\n  Email not configured — printing weekly sentiment body:\n');
      console.log(bodyMd);
    } else {
      await sendEmail({
        htmlBody: html,
        plainText: bodyMd,
        subject,
        attachments: [],
        to: firmCtx().weeklyEmailTo,
      });
      console.log(`\n  Sent weekly sentiment report to: ${firmCtx().weeklyEmailTo.join(', ')}`);
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
  // Sona/AI-handled inbound always needs a human callback — even when Quo marks
  // it "completed," Sona only gathers info / documents the request; it does not
  // resolve the client's matter or connect them to a person. (Quo sets
  // aiHandled = 'ai-agent' on these.) A later human-answered call or an outbound
  // callback still clears the client, since flagging keys off the LATEST call.
  if (c.aiHandled) return true;
  // A human-completed / answered inbound means the client actually reached a person.
  if (status === 'completed' || status === 'answered') return false;
  if (MISSED_INBOUND_STATUSES.has(status)) return true;
  // Fallback: incoming with zero duration treated as missed.
  const dur = Number(c.duration || 0);
  if (status && (!Number.isFinite(dur) || dur <= 0)) return true;
  return false;
}

/**
 * Quo list-calls often drops the completed return/transfer legs that Quo Router
 * (and our webhook ledger) still see. Merge those legs into the missed-call
 * window so a 2:06 miss is cleared by a 2:08 human complete on the same number.
 */
async function enrichMissedCallsFromLedger(callData, window, contactMap = {}) {
  const rows = Array.isArray(callData) ? [...callData] : [];
  if (!pg.isEnabled()) return rows;
  try {
    await pg.ensureSchema();
    const ledgerCalls = await pg.listQuoCallsInWindow(window.createdAfter, window.createdBefore);
    if (!ledgerCalls.length) {
      console.log('  [missed] webhook ledger: no rows in this window');
      return rows;
    }
    const byId = new Map();
    for (const c of rows) {
      if (c && c.id) byId.set(String(c.id), c);
    }
    let added = 0;
    let patched = 0;
    for (const row of ledgerCalls) {
      const parts = row.participants && typeof row.participants === 'object' ? row.participants : {};
      const externals = Array.isArray(parts.external) ? parts.external : [];
      const inbound = isIncomingDirection(row.direction);
      const phone = String(
        inbound ? parts.from || externals[0] || '' : parts.to || externals[0] || ''
      ).trim();
      const status = String(row.status || '').toLowerCase();
      const ts =
        isoTs(row.completed_at) || isoTs(row.answered_at) || isoTs(row.created_at) || '';
      const contact = phone ? lookupContactName(contactMap, phone) || '' : '';
      const contactId = phone ? lookupContactId(contactMap, phone) || '' : '';
      const line = row.line_name || '';
      const link =
        row.phone_number_id && row.conversation_id
          ? `https://my.openphone.com/inbox/${row.phone_number_id}/c/${row.conversation_id}${
              row.call_id ? `?at=${row.call_id}` : ''
            }`
          : '';
      const id = row.call_id ? String(row.call_id) : '';
      const existing = id ? byId.get(id) : null;
      if (existing) {
        let changed = false;
        // Prefer the ledger's resolved status when the API still shows a miss/ring.
        if (status && status !== String(existing.status || '').toLowerCase()) {
          if (status === 'completed' || status === 'answered' || !existing.status) {
            existing.status = row.status;
            changed = true;
          }
        }
        if (!existing.phone && phone) {
          existing.phone = phone;
          changed = true;
        }
        if (!existing.contact && contact) {
          existing.contact = contact;
          changed = true;
        }
        if (!existing.contactId && contactId) {
          existing.contactId = contactId;
          changed = true;
        }
        if ((!existing.timestamp || existing.timestamp < ts) && ts) {
          existing.timestamp = ts;
          changed = true;
        }
        if ((Number(row.duration_sec) || 0) > (Number(existing.duration) || 0)) {
          existing.duration = Number(row.duration_sec) || 0;
          changed = true;
        }
        if (!existing.link && link) {
          existing.link = link;
          changed = true;
        }
        if (!existing.line && line) {
          existing.line = line;
          changed = true;
        }
        if (changed) patched += 1;
        continue;
      }
      if (!id && !phone) continue;
      const mapped = {
        recordType: 'call',
        id: id || null,
        phoneNumberId: row.phone_number_id || '',
        timestamp: ts,
        line,
        phone,
        contact,
        contactId,
        duration: Number(row.duration_sec || 0),
        summary: '',
        transcript: '',
        link,
        status: row.status || '',
        direction: row.direction || '',
        aiHandled: row.ai_handled ? 'ai-agent' : null,
        answeredBy: row.answered_by || null,
        initiatedBy: row.initiated_by || null,
        userId: row.user_id || null,
        _fromLedger: true,
      };
      rows.push(mapped);
      if (id) byId.set(id, mapped);
      added += 1;
    }
    console.log(
      `  [missed] webhook ledger: +${added} call(s), patched ${patched} (${ledgerCalls.length} ledger row(s))`
    );
  } catch (err) {
    console.warn(`  [missed] webhook ledger merge skipped: ${err.message}`);
  }
  return rows;
}

/** Merge dial-in groups that share a Quo contact id (transfer legs sometimes lack phone). */
function mergeCallGroupsByContactId(byPhone) {
  const cidToKeys = new Map();
  for (const [key, group] of byPhone) {
    for (const c of group) {
      const cid = c && c.contactId ? String(c.contactId) : '';
      if (!cid) continue;
      if (!cidToKeys.has(cid)) cidToKeys.set(cid, new Set());
      cidToKeys.get(cid).add(key);
    }
  }
  for (const keys of cidToKeys.values()) {
    if (keys.size < 2) continue;
    const list = [...keys];
    const primary = list[0];
    const merged = byPhone.get(primary) || [];
    const seen = new Set(merged.map((c) => c.id || `${c.timestamp}|${c.line}|${c.status}`));
    for (let i = 1; i < list.length; i++) {
      const otherKey = list[i];
      for (const c of byPhone.get(otherKey) || []) {
        const id = c.id || `${c.timestamp}|${c.line}|${c.status}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(c);
      }
      byPhone.delete(otherKey);
    }
    byPhone.set(primary, merged);
  }
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
  return dt.toFormat("ccc, LLL d 'at' h:mm a");
}

const CASE_TRACKER_NEEDS_RESPONSE_URL = (
  process.env.CASE_TRACKER_NEEDS_RESPONSE_URL ||
  'https://rjl-case-tracker.vercel.app/needs-response'
).trim().replace(/\/$/, '');

// ── Callback-required detection (from the call transcript, via an LLM) ────────
// Instead of relying on any external bot/tag, we read each client's most recent
// substantive call (transcript preferred, summary as fallback) and ask the LLM
// whether the FIRM still owes that client a near-term return call — e.g. the
// client asked to be called back, or a staff member promised to call them (not
// a later "we'll reach out once we have more information" status update).
// Direction matters: a call where WE asked the CLIENT to call us back does NOT
// count. Non-client calls (referring attorneys, vendors, insurers) don't count.
// A callback falls off once we've actually reached the client again (see
// isConnectedReturnCall). Fails closed so a bad LLM call drops the flag.

// Cap on how many client calls we run through the LLM per report run.
const CALLBACK_MAX_CLASSIFY = parseInt(process.env.MISSED_CALLBACK_MAX_CLASSIFY || '200', 10);
/** Cap LLM SMS classifications per morning needs-response run. */
const SMS_MAX_CLASSIFY = parseInt(process.env.MISSED_SMS_MAX_CLASSIFY || '200', 10);
/** Completion budget for the firm-owes-callback JSON call (reasoning can eat most of a small cap). */
const OPENAI_CALLBACK_MAX_TOKENS = clampInt(process.env.OPENAI_CALLBACK_MAX_COMPLETION_TOKENS, 1000, 300, 8000);
const OPENAI_SMS_NEEDS_RESPONSE_MAX_TOKENS = clampInt(
  process.env.OPENAI_SMS_NEEDS_RESPONSE_MAX_COMPLETION_TOKENS,
  800,
  200,
  4000
);

/** Best classifiable text for a call: full transcript if present, else summary. */
function callClassifyText(c) {
  const tr = String(c?.transcript || '').trim();
  if (tr && tr !== '(no transcript — weekly bundle)') return { text: tr, kind: 'transcript' };
  const sum = String(c?.summary || '').trim();
  if (sum) return { text: sum, kind: 'summary' };
  return null;
}

/**
 * Reads one call and decides whether the FIRM still owes this client a
 * near-term return call. Contingent "we'll reach out once we have more
 * information" updates do not count. Direction-aware: the firm asking the
 * client to call US back does NOT count. Fails closed (returns ok:false) so a
 * bad LLM call never invents a callback. Returns { ok, reason }.
 */
async function classifyCallbackFromCall(c) {
  const picked = callClassifyText(c);
  if (!picked) return { ok: false, reason: 'no transcript or summary' };
  const dir = isIncomingDirection(c.direction)
    ? 'inbound (the client called the firm)'
    : 'outbound (the firm called the client)';
  const alreadyConnected = isConnectedHumanCall(c);
  const connectedNote = alreadyConnected
    ? `Connection status: this recording is a call that ALREADY connected the client with a person (${dir}). Answer true ONLY if someone promised an ADDITIONAL return phone call as the immediate next step (e.g. "I'll call you back in 10 minutes", "the attorney will call you this afternoon"). If they only said the team will call later once there is an update, a deeper answer, more information, or when something is ready — answer FALSE. The firm already spoke with them on this call.`
    : `Connection status: this call did not complete with a person (missed / Sona / no-answer), or that is unclear from metadata.`;
  const label = picked.kind === 'transcript' ? 'Transcript' : 'Call summary (no full transcript available)';
  const prompt = `You are reviewing a single phone call at a personal-injury law firm to decide whether the FIRM still owes THIS PERSON A RETURN PHONE CALL that staff should place now (or very soon) as the next action.

Call direction: ${dir}
Contact: ${c.contact || '(unknown)'}
${connectedNote}

Answer true ONLY when the call contains an EXPLICIT, UNMET request or promise that someone will PHONE the client as the next step:
- The client asked to be called back ("can you call me back", "have the attorney call me"), or
- A staff member/attorney said they would call the client back as the next action ("I'll call you back", "I'll have X call you this afternoon", "give me 10 minutes and I'll call you"), or
- The client could not reach the person they needed and is waiting on that person to return THIS call.

The promise must be a phone call that is already owed. "Call", "contact", "reach out", or "let you know" later does NOT count if it is a status update after some other event.

Be strict — an unfinished task is NOT a callback. Answer false if ANY of these apply:
- FUTURE / CONTINGENT CONTACT: staff will get back to the client only after receiving more information, documents, a police report, a check, next steps, a deeper answer, or similar. Examples that are FALSE: "as soon as I hear a word I'll send you a message", "once we know the next steps I will reach out… probably next week", "the office will contact you once they have the check ready", "as soon as we get that police report I'll let you know", "I'll leave a message so he can verify that information and let you know how long it may take" / "le dejaré el mensaje para que verifique y le deje saber cuánto tiempo se puede tomar", "lo que puedo hacer es que ellos le llamen de vuelta, en cuanto ellos tengan una respuesta ya más a profundidad", "que me llamen en cuanto puedan / cuando tengan alguna actualización".
- A later process call (someone will introduce themselves, go over the process, or set up treatment after information arrives) is onboarding, not a callback owed from this conversation.
- The promised follow-up is a message, text, email, or "I'll let you know" — not a return phone call.
- The client has ENDED or is ending the relationship: they fired the firm, said they're using another firm, asked to stop being contacted, sent a disengagement/termination letter, or declined to sign paperwork because they're leaving. Never flag these people for a callback, even if loose ends remain.
- The only thing outstanding is paperwork, a document, records, a signature, an email to send, or other administrative follow-up work. That is internal work, not a phone call the client is waiting on.
- The FIRM called and asked the CLIENT to call US back — the client owes the callback, not the firm.
- The firm already spoke with the person on this call and nobody promised a further IMMEDIATE call.
- The other party is NOT a client — a referring attorney, vendor, insurance company, court, or an internal/marketing call.

If you have to infer or assume a callback was implied, the answer is false. Only an explicit near-term return-call request or promise counts. Apply the same rules to Spanish (or any language).

${label}:
"""
${picked.text.slice(0, 6000)}
"""

Respond as JSON only: {"firm_owes_callback": true or false, "reason": "<brief, quote the explicit near-term call-back request or promise if true>"}`;
  try {
    const out = await runChatCompletion(prompt, OPENAI_CALLBACK_MAX_TOKENS, 'Callback classifier', { jsonObject: true });
    const parsed = JSON.parse(out);
    let ok = Boolean(parsed.firm_owes_callback);
    const reason = String(parsed.reason || '');
    // Safety net: a live conversation that only promised a later update is not a chase-list callback.
    if (ok && alreadyConnected && looksLikeContingentCallbackReason(reason)) {
      console.log(`    Callback suppressed (contingent follow-up on connected call) — ${c.contact || c.phone || c.id}: ${reason}`);
      ok = false;
    }
    return { ok, reason };
  } catch (err) {
    console.warn(`    Callback classify failed (${err.message}) — treating as NOT a callback.`);
    return { ok: false, reason: 'classifier error' };
  }
}

/** True when a person on the firm side actually connected with the client on this leg. */
function isConnectedHumanCall(c) {
  if (!c) return false;
  const status = String(c.status || '').toLowerCase();
  if (status !== 'completed' && status !== 'answered') return false;
  if (isIncomingDirection(c.direction)) return !c.aiHandled;
  return true; // outbound completed = we reached them
}

/**
 * True if `c` is a call, placed AFTER the callback was owed, that actually
 * connected the client with a person — either we called out and they answered,
 * or they called in and reached a human. Used to fall a callback off the list
 * once it's genuinely been returned (a later missed attempt does NOT count).
 */
function isConnectedReturnCall(c, sinceIso) {
  if (!c || !c.timestamp || !sinceIso) return false;
  const t = new Date(c.timestamp).getTime();
  // 2-minute grace so the originating call's own legs don't count as "returned".
  const since = new Date(sinceIso).getTime() + 120 * 1000;
  if (!Number.isFinite(t) || !Number.isFinite(since) || t <= since) return false;
  return isConnectedHumanCall(c);
}

/**
 * Reasons that are really "call later when we know more" — not a chase-list
 * callback. Used as a safety net when the model over-flags contingent language
 * (common in Spanish intakes).
 */
function looksLikeContingentCallbackReason(reason) {
  const s = String(reason || '').toLowerCase();
  if (!s) return false;
  return /en cuanto|una vez que|cuando (tengan|haya|salga|puedan)|once (we|they|you)|when (we|they|you) (have|get|know|can)|as soon as .{0,60}(update|respuesta|informaci[oó]n|information|report|check|ready|answer)|m[aá]s a profundidad|alguna actualizaci[oó]n|deeper (answer|response)|more (information|info)|when .+ (update|ready|available)/i.test(
    s
  );
}

/** Outbound SMS that counts as staff clearing a needs-response item. */
function isStaffClearingOutboundSms(ev) {
  if (!ev || ev.recordType !== 'sms') return false;
  if (isIncomingDirection(ev.direction)) return false;
  return !isAutoReplyOutboundSms(ev.body);
}

/**
 * Latest inbound SMS not yet cleared by a later connected human call or
 * real staff outbound text (auto-replies ignored). Skips empty/ack/greeting bodies.
 */
function findLatestUnclearedInboundSms(group) {
  const sorted = [...(group || [])].sort((x, y) =>
    String(x.timestamp || '').localeCompare(String(y.timestamp || ''))
  );
  let lastInbound = null;
  for (const ev of sorted) {
    if (ev.recordType !== 'sms') continue;
    if (!isIncomingDirection(ev.direction)) continue;
    if (isObviousNoActionSms(ev.body)) continue;
    lastInbound = ev;
  }
  if (!lastInbound) return null;
  const since = String(lastInbound.timestamp || '');
  const cleared = sorted.some((ev) => {
    if (!ev.timestamp || String(ev.timestamp) <= since) return false;
    if (ev.recordType === 'sms') return isStaffClearingOutboundSms(ev);
    return isConnectedHumanCall(ev);
  });
  return cleared ? null : lastInbound;
}

/** Short prior thread for SMS classifier context (calls + texts before the candidate). */
function smsThreadContextForClassify(group, beforeIso, maxItems = 4) {
  const prior = [...(group || [])]
    .filter((ev) => ev && ev.timestamp && String(ev.timestamp) < String(beforeIso || ''))
    .sort((x, y) => String(x.timestamp || '').localeCompare(String(y.timestamp || '')))
    .slice(-maxItems);
  if (!prior.length) return '(no earlier touchpoints in this window)';
  return prior
    .map((ev) => {
      const when = formatMissedCallTime(ev.timestamp) || ev.timestamp || '';
      if (ev.recordType === 'sms') {
        const dir = isIncomingDirection(ev.direction) ? 'inbound SMS' : 'outbound SMS';
        let body = String(ev.body || '').replace(/\s+/g, ' ').trim();
        if (body.length > 220) body = `${body.slice(0, 217)}...`;
        return `- ${when} · ${dir}: "${body || '(empty)'}"`;
      }
      const dir = isIncomingDirection(ev.direction) ? 'inbound call' : 'outbound call';
      const status = ev.aiHandled ? 'Sona/AI' : ev.status || 'call';
      return `- ${when} · ${dir} (${status})`;
    })
    .join('\n');
}

/**
 * LLM: does this inbound client text still need a staff response (call OR text)?
 * Same spirit as classifyCallbackFromCall — strict, fails closed.
 * Returns { ok, reason }.
 */
async function classifySmsNeedsStaffResponse(sms, group = []) {
  const body = String(sms?.body || '').trim();
  if (!body) return { ok: false, reason: 'empty text' };
  if (isObviousNoActionSms(body)) return { ok: false, reason: 'acknowledgement only' };

  const contact = sms.contact || '(unknown)';
  const prior = smsThreadContextForClassify(group, sms.timestamp);
  const prompt = `You are reviewing one inbound SMS from a CLIENT to a personal-injury law firm. Decide whether staff still need to get back to this client (by phone call OR text — either counts).

Contact: ${contact}

Recent thread before this text (oldest → newest):
${prior}

Inbound client text to judge:
"""
${body.slice(0, 2000)}
"""

Answer true when the text needs a substantive staff response or follow-up now, for example:
- A question about the case, status, timeline, settlement, treatment, documents, court, or next steps
- A request to be called, emailed, or updated
- A concern, complaint, confusion, urgency, or "please help / can someone call me"
- New information that clearly expects acknowledgment beyond a silent read
- Anything complex enough that leaving it unanswered would leave the client hanging

Answer false when NO staff response is needed, for example:
- Pure acknowledgements: ok, thanks, got it, sounds good, yes/no to a prior firm question with nothing further
- Emoji / reaction-only messages
- FYI confirmations that do not ask for anything ("I'll be there", "signed it", "dropped it off") unless they also ask a question or request a reply
- Spam, wrong-number, or non-client vendor noise
- The client ending / firing the firm or asking to stop contact

Be strict. If unsure whether a reply is really needed, answer false. Apply the same rules to Spanish (or any language).

Respond as JSON only: {"needs_staff_response": true or false, "reason": "<brief; quote the part that needs a reply if true>"}`;
  try {
    const out = await runChatCompletion(
      prompt,
      OPENAI_SMS_NEEDS_RESPONSE_MAX_TOKENS,
      'SMS needs-response classifier',
      { jsonObject: true }
    );
    const parsed = JSON.parse(out);
    return {
      ok: Boolean(parsed.needs_staff_response),
      reason: String(parsed.reason || ''),
    };
  } catch (err) {
    console.warn(`    SMS classify failed (${err.message}) — treating as NOT needing response.`);
    return { ok: false, reason: 'classifier error' };
  }
}

function buildMissedClientCallTable(rows, kind = 'missed') {
  const header =
    kind === 'callback'
      ? ['Client', 'Phone', 'Requested at', 'Why', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo']
      : kind === 'sms'
        ? ['Client', 'Phone', 'Text at', 'Preview', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo']
        : ['Client', 'Phone', 'Callback?', 'Missed at', 'Reason', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo'];
  const lines = [header.join(' | '), header.map(() => '---').join(' | ')];
  for (const r of rows) {
    const quo = r.link ? `[Quo](${r.link})` : '';
    const cells =
      kind === 'callback'
        ? [
            r.contact || '(unknown)',
            r.phone || '',
            r.missedAtLocal || '',
            (r.callbackWhy || '').replace(/\|/g, '/'),
            r.attorney || '',
            r.paralegal || '',
            r.legalAssistant || '',
            r.line || '',
            quo,
          ]
        : kind === 'sms'
          ? [
              r.contact || '(unknown)',
              r.phone || '',
              r.missedAtLocal || '',
              (r.smsPreview || '').replace(/\|/g, '/'),
              r.attorney || '',
              r.paralegal || '',
              r.legalAssistant || '',
              r.line || '',
              quo,
            ]
          : [
              r.contact || '(unknown)',
              r.phone || '',
              r.callbackRequested ? 'Yes' : '',
              r.missedAtLocal || '',
              r.reason || '',
              r.attorney || '',
              r.paralegal || '',
              r.legalAssistant || '',
              r.line || '',
              quo,
            ];
    lines.push(cells.join(' | '));
  }
  return lines.join('\n');
}

function needsResponseQuoBtn(r) {
  if (!r.link) return '—';
  return `<a href="${escapeHtml(r.link)}" style="display:inline-block;padding:5px 10px;border-radius:6px;background:#0A1C40;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none">Quo</a>`;
}

function needsResponseBadge(text, color, bg) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:${color};background:${bg};white-space:nowrap">${escapeHtml(text)}</span>`;
}

/** HTML for the Missed / Sona Calls table (Quo link only — Slack lives in Case Tracker). */
function missedTableHtml(rows) {
  if (!rows.length) {
    return '<p style="margin:8px 0;color:#667085;font-size:13px;font-style:italic">No missed / Sona client calls in this window.</p>';
  }
  const headerRow =
    '<tr style="background:#f9fafb">' +
    ['Client', 'Phone', 'Callback?', 'Missed at', 'Reason', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo']
      .map(
        (h) =>
          `<th style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085;border-bottom:1px solid #e4e7ec;text-align:left">${h}</th>`
      )
      .join('') +
    '</tr>';
  const bodyRows = rows
    .map((r) => {
      const border = r.callbackRequested ? '#b54708' : '#e4e7ec';
      const cb = r.callbackRequested
        ? needsResponseBadge('Yes', '#b54708', '#fffaeb')
        : '<span style="color:#98a2b3">—</span>';
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;border-left:4px solid ${border};font-weight:600;color:#101828">${escapeHtml(r.contact || '(unknown)')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.phone || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7">${cb}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054;white-space:nowrap">${escapeHtml(r.missedAtLocal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.reason || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.attorney || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.paralegal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.legalAssistant || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.line || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7">${needsResponseQuoBtn(r)}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;border-collapse:separate">${headerRow}${bodyRows}</table>`;
}

/** HTML for the Requested Call Backs table. */
function callbackTableHtml(rows) {
  if (!rows.length) {
    return '<p style="margin:8px 0;color:#667085;font-size:13px;font-style:italic">No outstanding callback requests.</p>';
  }
  const headerRow =
    '<tr style="background:#f9fafb">' +
    ['Client', 'Phone', 'Requested at', 'Why', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo']
      .map(
        (h) =>
          `<th style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085;border-bottom:1px solid #e4e7ec;text-align:left">${h}</th>`
      )
      .join('') +
    '</tr>';
  const bodyRows = rows
    .map(
      (r) => `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;border-left:4px solid #175cd3;font-weight:600;color:#101828">${escapeHtml(r.contact || '(unknown)')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.phone || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054;white-space:nowrap">${escapeHtml(r.missedAtLocal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054;font-size:13px">${escapeHtml(r.callbackWhy || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.attorney || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.paralegal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.legalAssistant || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.line || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7">${needsResponseQuoBtn(r)}</td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;border-collapse:separate">${headerRow}${bodyRows}</table>`;
}

/** HTML for inbound texts that still need a staff response (call or text). */
function smsNeedsResponseTableHtml(rows) {
  if (!rows.length) {
    return '<p style="margin:8px 0;color:#667085;font-size:13px;font-style:italic">No client texts still needing a response.</p>';
  }
  const headerRow =
    '<tr style="background:#f9fafb">' +
    ['Client', 'Phone', 'Text at', 'Preview', 'Attorney', 'Paralegal', 'Legal assistant', 'Quo line', 'Quo']
      .map(
        (h) =>
          `<th style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085;border-bottom:1px solid #e4e7ec;text-align:left">${h}</th>`
      )
      .join('') +
    '</tr>';
  const bodyRows = rows
    .map(
      (r) => `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;border-left:4px solid #067647;font-weight:600;color:#101828">${escapeHtml(r.contact || '(unknown)')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.phone || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054;white-space:nowrap">${escapeHtml(r.missedAtLocal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054;font-size:13px">${escapeHtml(r.smsPreview || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.attorney || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.paralegal || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.legalAssistant || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;color:#344054">${escapeHtml(r.line || '')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7">${needsResponseQuoBtn(r)}</td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;border-collapse:separate">${headerRow}${bodyRows}</table>`;
}

function buildMissedClientCallEmailHtml(rangeLabel, missedRows, callbackRows, smsRows = []) {
  const total = missedRows.length + callbackRows.length + smsRows.length;
  const trackerUrl = CASE_TRACKER_NEEDS_RESPONSE_URL;
  const kpi = (label, value, color, bg) => `
    <td style="width:25%;padding:4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid #e4e7ec;border-radius:10px">
        <tr><td style="padding:14px 12px">
          <div style="font-size:11px;font-weight:700;color:#667085;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(label)}</div>
          <div style="font-size:28px;font-weight:800;color:${color};line-height:1.15;margin-top:4px">${value}</div>
        </td></tr>
      </table>
    </td>`;
  const section = (title, accent, body) => `
    <h3 style="margin:28px 0 10px;font-size:16px;color:#0A1C40;border-left:4px solid ${accent};padding-left:10px">${escapeHtml(title)}</h3>
    ${body}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7">
<tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="720" cellpadding="0" cellspacing="0" style="max-width:720px;width:100%">
  <tr><td style="background:#0A1C40;border-radius:12px 12px 0 0;padding:28px 28px 24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#45C7F0">Client follow-up</div>
    <div style="font-size:26px;font-weight:800;color:#ffffff;margin-top:6px">Needs Response — New Today</div>
    <div style="font-size:13px;color:#d0d5dd;margin-top:8px">${escapeHtml(rangeLabel)}</div>
    <div style="margin-top:16px">
      <a href="${escapeHtml(trackerUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#45C7F0;color:#0A1C40;font-size:13px;font-weight:800;text-decoration:none">Open Needs Response →</a>
    </div>
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 20px 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${kpi('New items', String(total), total ? '#b42318' : '#067647', total ? '#fef3f2' : '#ecfdf3')}
        ${kpi('Missed / Sona', String(missedRows.length), '#b54708', '#fffaeb')}
        ${kpi('Callbacks', String(callbackRows.length), '#175cd3', '#eff8ff')}
        ${kpi('Texts', String(smsRows.length), '#067647', '#ecfdf3')}
      </tr>
    </table>
    <p style="margin:14px 8px 0;font-size:12px;color:#667085;line-height:1.5">
      Only <strong style="color:#344054">new</strong> items are emailed.
      The full open queue stays in <a href="${escapeHtml(trackerUrl)}" style="color:#175cd3;font-weight:600">Case Tracker → Needs response</a>
      (Slack channel links are there) until staff send an outbound text, complete a returned call, or mark the row resolved.
    </p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:8px 20px 20px">
    ${section('1) Missed / Sona Calls', '#b54708', missedTableHtml(missedRows))}
    ${section('2) Requested Call Backs', '#175cd3', callbackTableHtml(callbackRows))}
    ${section('3) Texts Needing Response', '#067647', smsNeedsResponseTableHtml(smsRows))}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e4e7ec;font-size:12px;color:#667085;line-height:1.55">
      <p style="margin:0 0 8px"><strong style="color:#344054">Missed / Sona</strong> — latest activity was a miss or Sona/AI-handled call. Clears when a person answers or we dial out.</p>
      <p style="margin:0 0 8px"><strong style="color:#344054">Callbacks</strong> — firm owes a near-term return call (client asked, or staff promised). Contingent “we’ll update you later” items are not listed.</p>
      <p style="margin:0"><strong style="color:#344054">Texts</strong> — inbound client texts that need staff action. Clears on a connected human call or outbound text.</p>
    </div>
  </td></tr>
  <tr><td style="background:#0A1C40;border-radius:0 0 12px 12px;padding:14px 28px;font-size:11px;color:#98a2b3">
    <a href="${escapeHtml(trackerUrl)}" style="color:#45C7F0;font-weight:700;text-decoration:none">Open full Needs Response queue</a>
    &nbsp;·&nbsp; Ramos James Law · Internal
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * Trailing 24h Client Needs Response report.
 * Pulls calls + SMS from Quo, filters to client contacts (CRM name ends in a
 * case number), and surfaces clients the firm still owes a response:
 * missed / Sona calls, firm-owed callbacks, and inbound texts needing action.
 */
async function runMissedClientCallReport() {
  const { createdAfter, createdBefore } = getTrailing24HoursRange();
  const a = DateTime.fromISO(createdAfter, { zone: 'utc' }).setZone(TIMEZONE);
  const b = DateTime.fromISO(createdBefore, { zone: 'utc' }).setZone(TIMEZONE);
  const rangeLabel = `${a.toFormat("LLL d, h:mm a")} – ${b.toFormat("LLL d, h:mm a")}`;

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Client Needs Response Report (trailing 24h)');
  console.log(`  Window: ${rangeLabel} (${TIMEZONE})`);
  console.log('═'.repeat(52));

  console.log('\n[1/4] Fetching Quo calls + texts (all lines, trailing 24h)...');
  const [{ callData }, contactMap] = await Promise.all([
    runExport({
      apiKey: firmCtx().quoApiKey,
      createdAfter,
      createdBefore,
      weeklyCommunications: true,
      includeMessages: true,
      // Pull transcripts so the LLM can decide whether the firm owes each client a
      // callback (the client asked us to call back, or we promised to). Missed /
      // no-answer calls simply have no transcript and fall to the heuristic below.
      fetchTranscriptForWeekly: true,
      // Pull every line the firm owns — resolving calls often happen on a
      // different line (e.g. miss on RJL Outbound, callback via RJL Main Line,
      // client retry into RJL Transfers). An empty filter = all lines in this
      // firm's Quo workspace. For the env-only default firm we keep [] (all
      // lines) exactly as before; a configured firm scopes to its own lines so
      // firms sharing one Quo key don't cross-contaminate (list ALL of a firm's
      // lines in its phone-numbers field for accurate resolution).
      phoneNumbersFilter: firmCtx().synthetic ? [] : firmCtx().quoPhoneNumbers,
    }),
    fetchContactMap(firmCtx().quoApiKey).catch((err) => {
      console.warn(`  Contact map skipped: ${err.message}`);
      return {};
    }),
  ]);

  // Group EVERY call in the window by phone last-10 first, so resolving calls
  // (callbacks, transfers, etc.) that may have a different/missing contact
  // label are still grouped with their corresponding miss. Then qualify the
  // group as "client" only if at least one call in it has a client-shaped
  // contact name (CRM name ending in a case number).
  //
  // Also merge Quo webhook ledger legs — list-calls drops many completed
  // return/transfer calls that Quo Router still posts to Slack.
  const mergedCalls = await enrichMissedCallsFromLedger(
    callData || [],
    { createdAfter, createdBefore },
    contactMap
  );
  const allCalls = mergedCalls.filter((r) => r.recordType === 'call' || !r.recordType);
  const allSms = (callData || []).filter((r) => r.recordType === 'sms');
  console.log(
    `\n[2/4] ${allCalls.length} call(s), ${allSms.length} text(s) in window (will filter to clients next).`
  );

  /** @type {Map<string, { leadAttorney?: string, paralegal?: string }>} */
  let rosterMap = new Map();
  if (firmCtx().sheets.caseRosterId && allCalls.length) {
    const hasOAuth =
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN;
    if (hasOAuth) {
      try {
        const rosterRows = await fetchSheetData(
          firmCtx().sheets.caseRosterId,
          firmCtx().sheets.caseRosterRange
        );
        rosterMap = rawRowsToCaseRosterMap(rosterRows, firmCtx().sheets.rosterColumns);
        console.log(`  Case roster sheet: ${rosterMap.size} row(s) indexed for attorney/paralegal.`);
      } catch (err) {
        console.warn(`  Case roster fetch failed (report still sends without attorney/paralegal): ${err.message}`);
      }
    } else {
      console.warn(
        '  Case roster sheet is set but Google OAuth env vars are incomplete — attorney/paralegal columns omitted.'
      );
    }
  }

  /** @type {Map<string, string>} */
  let legalAssistantMap = new Map();
  try {
    legalAssistantMap = await fetchCaseTrackerLegalAssistantByCase();
    console.log(`  Legal assistants: ${legalAssistantMap.size} case assignment(s) from Case Tracker.`);
  } catch (err) {
    console.warn(`  Legal assistant lookup failed (report still sends without that column): ${err.message}`);
  }

  // Group every call by the external DIAL-IN number (caller's phone, last 10
  // digits) — regardless of which internal Quo line handled it. We fetch all
  // lines (phoneNumbersFilter: []), so a number's complete activity (misses,
  // callbacks, our outbound from any line) lands in one bucket.
  /** @type {Map<string, object[]>} */
  const byPhone = new Map();
  for (const c of allCalls) {
    // Prefer dial-in phone; fall back to contact id so transfer legs that lost
    // the external number still join the client's timeline.
    const key =
      last10Digits(c.phone) ||
      (c.contactId ? `cid:${c.contactId}` : null) ||
      last10Digits(c.contact);
    if (!key) continue;
    if (!c.contact && contactMap && c.phone) {
      c.contact = lookupContactName(contactMap, c.phone) || c.contact;
      c.contactId = lookupContactId(contactMap, c.phone) || c.contactId;
    }
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(c);
  }
  mergeCallGroupsByContactId(byPhone);

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
    if (!lastCall) continue;
    if (isConnectedHumanCall(lastCall)) continue;
    if (!isMissedInboundCall(lastCall)) continue;
    // Belt-and-suspenders: a later human connect anywhere in the group clears
    // the miss even if sort/timestamps on an older miss look "last".
    const lastTs = String(lastCall.timestamp || '');
    if (group.some((c) => String(c.timestamp || '') > lastTs && isConnectedHumanCall(c))) continue;

    // Prefer the client-formatted contact name (most likely to carry the case
    // number) even if lastCall itself was on a transfer leg without it.
    const displayContact = clientAnchor.contact || lastCall.contact || '';
    const caseId = extractTrailingCaseDigitsFromClientKey(displayContact);
    // A later connected call to another person on this case (co-client) also clears the miss.
    if (laterConnectedCall(callsForCaseNumber(byPhone, caseId), lastCall.timestamp)) continue;
    const rosterHit = caseId ? rosterMap.get(caseId) : null;
    outstanding.push({
      contact: displayContact,
      phone: lastCall.phone || clientAnchor.phone || '',
      missedAtLocal: formatMissedCallTime(lastCall.timestamp),
      missedAtIso: lastCall.timestamp || '',
      reason: classifyMissedReason(lastCall),
      attorney: rosterHit?.leadAttorney || '',
      paralegal: rosterHit?.paralegal || '',
      legalAssistant: legalAssistantForCase(caseId, legalAssistantMap),
      line: lastCall.line || '',
      link: lastCall.link || '',
      kind: 'missed',
      _groupKey: last10Digits(lastCall.phone) || last10Digits(lastCall.contact) || '',
    });
  }

  // Callback-required detection — read each client's most recent substantive
  // call and ask the LLM whether the FIRM still owes them a return call. These
  // become first-class rows on the email (marked 📞), and fall off once we've
  // actually reached the client again. Best-effort — never blocks the report.
  {
    const outstandingByKey = new Map(outstanding.map((r) => [r._groupKey, r]).filter(([k]) => k));

    // One candidate per client: their most recent call that has transcript/summary.
    /** @type {{ key: string, contact: string, anchor: object, convCall: object }[]} */
    const candidates = [];
    for (const [key, group] of byPhone) {
      const clientAnchor = group.find((c) => isClientContactName(c.contact));
      if (!clientAnchor) continue; // client groups only
      // group is already sorted ascending by the outstanding loop above.
      let convCall = null;
      for (let i = group.length - 1; i >= 0; i--) {
        if (callClassifyText(group[i])) { convCall = group[i]; break; }
      }
      if (!convCall) continue; // nothing to classify (pure missed call, no transcript)
      candidates.push({ key, contact: clientAnchor.contact || convCall.contact || '', anchor: clientAnchor, convCall });
    }

    const toClassify = candidates.slice(0, CALLBACK_MAX_CLASSIFY);
    if (candidates.length > toClassify.length) {
      console.warn(`\n  Callback check: ${candidates.length} client calls, classifying first ${toClassify.length} (MISSED_CALLBACK_MAX_CLASSIFY).`);
    } else {
      console.log(`\n  Callback check: classifying ${toClassify.length} client call(s) for firm-owed callbacks...`);
    }

    let added = 0;
    let marked = 0;
    let droppedReturned = 0;
    for (const cand of toClassify) {
      const verdict = await classifyCallbackFromCall(cand.convCall);
      if (!verdict.ok) continue;
      // Fall off if we've actually reached the client again after this call
      // (including when the classifier walked back to an older transcript because
      // the latest miss/no-answer leg had no text).
      const group = byPhone.get(cand.key) || [];
      const caseId = extractTrailingCaseDigitsFromClientKey(cand.contact);
      const caseCalls = callsForCaseNumber(byPhone, caseId);
      const reached = laterConnectedCall(caseCalls.length ? caseCalls : group, cand.convCall.timestamp);
      if (reached) {
        droppedReturned += 1;
        console.log(`    Callback cleared (later connected call on this case) — ${cand.contact}`);
        continue;
      }
      console.log(`    Callback owed — ${cand.contact}: ${verdict.reason || 'n/a'}`);
      const existing = outstandingByKey.get(cand.key);
      if (existing) {
        existing.callbackRequested = true;
        existing.callbackWhy = verdict.reason || '';
        marked += 1;
        continue;
      }
      // New standalone "callback required" row (client isn't a missed-inbound).
      const rosterHit = caseId ? rosterMap.get(caseId) : null;
      outstanding.push({
        contact: cand.contact,
        phone: cand.anchor.phone || cand.convCall.phone || '',
        missedAtLocal: formatMissedCallTime(cand.convCall.timestamp),
        missedAtIso: cand.convCall.timestamp || '',
        reason: 'Callback requested',
        attorney: rosterHit?.leadAttorney || '',
        paralegal: rosterHit?.paralegal || '',
        legalAssistant: legalAssistantForCase(caseId, legalAssistantMap),
        line: cand.convCall.line || '',
        link: cand.convCall.link || cand.anchor.link || '',
        callbackRequested: true,
        callbackWhy: verdict.reason || '',
        kind: 'callback',
        _groupKey: cand.key,
      });
      added += 1;
    }
    console.log(`  Callback-required: ${marked} marked on existing missed rows, ${added} added, ${droppedReturned} already returned.`);
  }

  // Combined call + SMS timelines (also used to clear open Case Tracker rows).
  /** @type {Map<string, object[]>} */
  const byPhoneTouch = new Map();
  for (const [key, group] of byPhone) byPhoneTouch.set(key, [...group]);

  // Texts needing response — merge SMS into call timelines, skip clients already
  // listed for missed/callback. Obvious acks/greetings skip the LLM; everything
  // else is classified like call-back transcripts. A later connected call OR
  // real staff outbound text clears the item (canned auto-replies do not).
  {
    console.log('\n[3/4] Checking inbound client texts that still need a staff response...');
    for (const m of allSms) {
      if (m.phone && contactMap) {
        m.contact = m.contact || lookupContactName(contactMap, m.phone) || m.contact;
        m.contactId = m.contactId || lookupContactId(contactMap, m.phone) || m.contactId;
      }
      const key =
        last10Digits(m.phone) ||
        (m.contactId ? `cid:${m.contactId}` : null) ||
        last10Digits(m.contact);
      if (!key) continue;
      if (!byPhoneTouch.has(key)) byPhoneTouch.set(key, []);
      byPhoneTouch.get(key).push(m);
    }
    mergeCallGroupsByContactId(byPhoneTouch);

    const outstandingKeys = new Set(outstanding.map((r) => r._groupKey).filter(Boolean));
    /** @type {{ key: string, contact: string, anchor: object, sms: object, group: object[] }[]} */
    const smsCandidates = [];
    for (const [key, group] of byPhoneTouch) {
      if (outstandingKeys.has(key)) continue;
      const clientAnchor = group.find((c) => isClientContactName(c.contact));
      if (!clientAnchor) continue;
      const sms = findLatestUnclearedInboundSms(group);
      if (!sms) continue;
      const caseId = extractTrailingCaseDigitsFromClientKey(clientAnchor.contact);
      if (laterConnectedCall(callsForCaseNumber(byPhone, caseId), sms.timestamp)) continue;
      smsCandidates.push({
        key,
        contact: clientAnchor.contact || sms.contact || '',
        anchor: clientAnchor,
        sms,
        group,
      });
    }

    const toClassify = smsCandidates.slice(0, SMS_MAX_CLASSIFY);
    if (smsCandidates.length > toClassify.length) {
      console.warn(
        `  SMS check: ${smsCandidates.length} uncleared inbound texts, classifying first ${toClassify.length} (MISSED_SMS_MAX_CLASSIFY).`
      );
    } else {
      console.log(`  SMS check: classifying ${toClassify.length} uncleared inbound text(s)...`);
    }

    let smsAdded = 0;
    let smsSkipped = 0;
    for (const cand of toClassify) {
      const verdict = await classifySmsNeedsStaffResponse(cand.sms, cand.group);
      if (!verdict.ok) {
        smsSkipped += 1;
        console.log(`    SMS skip — ${cand.contact}: ${verdict.reason || 'n/a'}`);
        continue;
      }
      console.log(`    SMS needs response — ${cand.contact}: ${verdict.reason || 'n/a'}`);
      const caseId = extractTrailingCaseDigitsFromClientKey(cand.contact);
      const rosterHit = caseId ? rosterMap.get(caseId) : null;
      let preview = String(cand.sms.body || '').replace(/\s+/g, ' ').trim();
      if (preview.length > 160) preview = `${preview.slice(0, 157)}...`;
      outstanding.push({
        contact: cand.contact,
        phone: cand.sms.phone || cand.anchor.phone || '',
        missedAtLocal: formatMissedCallTime(cand.sms.timestamp),
        missedAtIso: cand.sms.timestamp || '',
        reason: 'Inbound text needs response',
        attorney: rosterHit?.leadAttorney || '',
        paralegal: rosterHit?.paralegal || '',
        legalAssistant: legalAssistantForCase(caseId, legalAssistantMap),
        line: cand.sms.line || '',
        link: cand.sms.link || cand.anchor.link || '',
        smsPreview: preview,
        callbackWhy: verdict.reason || '',
        details: verdict.reason || '',
        kind: 'sms',
        _groupKey: cand.key,
      });
      smsAdded += 1;
      outstandingKeys.add(cand.key);
    }
    console.log(`  Texts needing response: ${smsAdded} flagged, ${smsSkipped} skipped by classifier.`);
  }

  // Callback-requested clients first, then oldest first within each group.
  outstanding.sort((x, y) => {
    if (Boolean(y.callbackRequested) !== Boolean(x.callbackRequested)) {
      return y.callbackRequested ? 1 : -1;
    }
    return String(x.missedAtIso).localeCompare(String(y.missedAtIso));
  });

  console.log(`\n[4/4] Window detections: ${outstanding.length} (email will be new-to-Case-Tracker only)`);
  for (const r of outstanding) {
    const extra =
      r.kind === 'sms'
        ? ` "${(r.smsPreview || '').slice(0, 80)}"`
        : r.callbackRequested
          ? '  [📞 CALLBACK REQUESTED]'
          : '';
    console.log(`  - [${r.kind}] ${r.contact} (${r.phone}) — ${r.reason} ${r.missedAtLocal}${extra}`);
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
  }

  /** @type {object[]} */
  let emailRows = outstanding;
  try {
    const syncResult = await syncNeedsResponseToCaseTracker(outstanding, rangeLabel, byPhoneTouch);
    emailRows = Array.isArray(syncResult?.emailNew) ? syncResult.emailNew : outstanding;
  } catch (err) {
    console.warn(`  Needs response Case Tracker sync failed: ${err.message}`);
  }

  for (const r of outstanding) delete r._groupKey;

  // Email = newly opened Case Tracker items only. Full open queue (incl. Slack
  // channel links) lives on Case Tracker → Needs response.
  const byTime = (x, y) => String(x.missedAtIso).localeCompare(String(y.missedAtIso));
  const missedRows = emailRows.filter((r) => r.kind === 'missed').sort(byTime);
  const callbackRows = emailRows.filter((r) => r.kind === 'callback').sort(byTime);
  const smsRows = emailRows.filter((r) => r.kind === 'sms').sort(byTime);

  console.log(
    `  Email (new only): Missed/Sona ${missedRows.length} · Callbacks ${callbackRows.length} · Texts ${smsRows.length}`
  );

  const subjectParts = [];
  if (missedRows.length) subjectParts.push(`${missedRows.length} missed/Sona`);
  if (callbackRows.length) subjectParts.push(`${callbackRows.length} callback${callbackRows.length === 1 ? '' : 's'}`);
  if (smsRows.length) subjectParts.push(`${smsRows.length} text${smsRows.length === 1 ? '' : 's'}`);
  const subject = subjectParts.length
    ? `${firmCtx().firmName} — Client Needs Response (new) — ${subjectParts.join(', ')}`
    : `${firmCtx().firmName} — Client Needs Response — no new items`;
  const html = buildMissedClientCallEmailHtml(rangeLabel, missedRows, callbackRows, smsRows);
  const plainText =
    `Client Needs Response Report (new items only)\nWindow: ${rangeLabel}\n` +
    `Full open queue: ${CASE_TRACKER_NEEDS_RESPONSE_URL}\n\n` +
    `1) Missed / Sona Calls (${missedRows.length})\n` +
    (missedRows.length ? `${buildMissedClientCallTable(missedRows, 'missed')}\n` : 'None.\n') +
    `\n2) Requested Call Backs (${callbackRows.length})\n` +
    (callbackRows.length ? `${buildMissedClientCallTable(callbackRows, 'callback')}\n` : 'None.\n') +
    `\n3) Texts Needing Response (${smsRows.length})\n` +
    (smsRows.length ? `${buildMissedClientCallTable(smsRows, 'sms')}\n` : 'None.\n');

  const recipients = firmCtx().missedEmailTo;
  if (!recipients.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured (set MISSED_CLIENT_CALLS_EMAIL_TO or EMAIL_TO + Gmail OAuth) — printing report:\n');
    console.log(plainText);
  } else {
    await sendEmail({ htmlBody: html, plainText, subject, to: recipients });
    console.log(`\n  Sent client needs-response report to: ${recipients.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Client Needs Response Report complete.');
  return { rangeLabel, outstandingCount: outstanding.length, emailCount: emailRows.length, outstanding };
}

// ── Client Language Report (transcript-based EN/ES/both detection) ────────────

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CLIENT_LANGUAGES_HEADER = [
  'Client', 'Case', 'Phone', 'Language', 'Spanish share',
  'Transcripts analyzed', 'Last activity', 'Updated',
];

function clientLanguagesSheetId() {
  return (process.env.GOOGLE_CLIENT_LANGUAGES_SHEET_ID || GOOGLE_WEEKLY_SENTIMENT_SHEET_ID || '').trim();
}

async function writeClientLanguagesSnapshot(rows, publishedAtLocal) {
  const spreadsheetId = clientLanguagesSheetId();
  const hasOAuth =
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN;
  if (!spreadsheetId || !hasOAuth) return false;

  await ensureSheetTab(spreadsheetId, CLIENT_LANGUAGES_TAB);
  const tab = CLIENT_LANGUAGES_TAB;
  const values = [
    CLIENT_LANGUAGES_HEADER,
    ...rows.map((r) => [
      r.clientName, r.caseId, r.phone, r.language, r.spanishShare,
      r.transcriptsAnalyzed, r.lastActivityLocal, publishedAtLocal,
    ]),
  ];
  // Replace the tab contents (snapshot).
  await clearSheetValuesRange(spreadsheetId, `${tab}!A2:Z100000`);
  await updateSheetValues(spreadsheetId, `${tab}!A1`, values);
  return true;
}

/**
 * Scans the trailing N days of **client call transcripts** (SMS is excluded —
 * short replies like "ok"/"gracias" cause false positives) and classifies each
 * client's language as english / spanish / both / unknown. Writes a Google Sheet
 * snapshot (if configured), a CSV, and a summary email.
 */
async function runClientLanguageReport(opts = {}) {
  const days = opts.days != null ? Math.max(1, Math.min(365, Math.floor(Number(opts.days) || 0))) : CLIENT_LANGUAGE_LOOKBACK_DAYS;
  const { createdAfter, createdBefore } = getTrailingDaysRange(days);
  const rangeLabel = buildSentimentTrailingDaysRangeLabel(createdAfter, createdBefore, days);

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Client Language Report (call transcripts only)');
  console.log(`  Lookback: ${days} day(s) · ${rangeLabel}`);
  console.log('═'.repeat(52));

  console.log(`\n[1/3] Fetching client calls WITH transcripts (${days}-day window)...\n`);
  const { callData } = await runExport({
    createdAfter,
    createdBefore,
    weeklyCommunications: true,
    includeMessages: false, // SMS excluded — transcripts are the reliable signal
    fetchTranscriptForWeekly: true, // real transcripts — summaries are English-only
  });

  const groups = groupClientTouchpointsByContact(callData);
  console.log(`\n[2/3] Detecting language for ${groups.size} client(s)...`);

  const rows = [];
  const counts = { english: 0, spanish: 0, both: 0, unknown: 0 };
  for (const [clientKey, items] of groups) {
    const callTexts = items.filter((i) => i.recordType !== 'sms').map((i) => i.transcript).filter((t) => t && t.trim());
    const agg = aggregateLanguages(callTexts);
    counts[agg.language]++;

    const latest = items.reduce((m, i) => (itemTimeMs(i) > itemTimeMs(m) ? i : m), items[0]);
    rows.push({
      clientName: displayClientName(clientKey),
      caseId: extractTrailingCaseDigitsFromClientKey(clientKey) || '',
      phone: (items.find((i) => i.phone)?.phone || '').trim(),
      language: agg.language,
      spanishShare: agg.spanishShare,
      transcriptsAnalyzed: agg.analyzed,
      lastActivityLocal: latest ? formatTimestamp(latest.timestamp) : '',
    });
  }

  rows.sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { sensitivity: 'base' }));

  console.log(
    `\n[3/3] Results — english: ${counts.english} · spanish: ${counts.spanish} · both: ${counts.both} · unknown: ${counts.unknown}`
  );

  // CSV
  const csvName = `quo_client_languages_${createdBefore.slice(0, 10)}.csv`;
  const csvLines = [CLIENT_LANGUAGES_HEADER.map(csvCell).join(',')];
  for (const r of rows) {
    csvLines.push([
      r.clientName, r.caseId, r.phone, r.language, r.spanishShare,
      r.transcriptsAnalyzed, r.lastActivityLocal,
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(csvName, csvLines.join('\n'), 'utf8');
  console.log(`  Wrote ${csvName}`);

  const publishedAtLocal = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm');
  try {
    const wrote = await writeClientLanguagesSnapshot(rows, publishedAtLocal);
    console.log(wrote ? `  Sheet snapshot: wrote ${rows.length} row(s) to "${CLIENT_LANGUAGES_TAB}".` : '  Sheet snapshot skipped (set GOOGLE_CLIENT_LANGUAGES_SHEET_ID + OAuth).');
  } catch (err) {
    console.warn(`  Sheet snapshot failed: ${err.message}`);
  }

  const summary =
    `Client Language Report — ${rows.length} clients (${days}-day lookback)\n` +
    `English: ${counts.english}  ·  Spanish: ${counts.spanish}  ·  Both: ${counts.both}  ·  Unknown: ${counts.unknown}\n` +
    `Window: ${rangeLabel}\n\nDetected from call transcripts only (SMS excluded to avoid false positives; summaries not used). CSV attached.`;

  if (EMAIL_TO.length && EMAIL_CONFIGURED) {
    try {
      await sendEmail({
        htmlBody: `<pre style="font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(summary)}</pre>`,
        plainText: summary,
        subject: `Client Language Report — ${rows.length} clients`,
        attachments: [{ filename: path.basename(csvName), path: csvName }],
      });
      console.log(`  Emailed summary + CSV to: ${EMAIL_TO.join(', ')}`);
    } catch (err) {
      console.warn(`  Email failed: ${err.message}`);
    }
  } else {
    console.log('\n' + summary);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Client Language Report complete.');
  return { rangeLabel, clients: rows.length, counts, csvName };
}

// ── Intake Marketing Insights (voice-of-customer from intake/lead calls) ─────

/** Normalize one enum value against its allowed set (fallback provided). */
function normEnum(field, value, fallback) {
  const allowed = INTAKE_MARKETING_ENUMS[field] || [];
  const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(v) ? v : fallback;
}

function toStrArray(v, cap = 8) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, cap);
}

function normalizeIntakeExtraction(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return {
    call_stage: normEnum('call_stage', obj.call_stage, 'other'),
    referral_source: normEnum('referral_source', obj.referral_source, 'unknown'),
    case_type: normEnum('case_type', obj.case_type, 'unknown'),
    primary_motivation: normEnum('primary_motivation', obj.primary_motivation, 'other'),
    urgency: normEnum('urgency', obj.urgency, 'medium'),
    retained: normEnum('retained', obj.retained, 'unknown'),
    pain_points: toStrArray(obj.pain_points),
    objections: toStrArray(obj.objections),
    decision_factors: toStrArray(obj.decision_factors),
    competitor_mentions: toStrArray(obj.competitor_mentions, 5),
    geography: String(obj.geography || '').trim().slice(0, 80),
    notable_quote: String(obj.notable_quote || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

/**
 * First-contact candidate calls for intake analysis.
 *
 * We can't tell leads from clients by the CRM name: a lead who signs within the
 * window gets a case number, so name-based filtering would drop exactly the
 * leads who converted. Instead we take the **earliest transcript call per phone
 * number** in the window (each caller's first substantive conversation) and let
 * the LLM classify call_stage from the transcript. Existing clients whose intake
 * predates the window surface as "existing_client" and are dropped downstream.
 */
function firstContactCalls(callData) {
  const byPhone = new Map();
  for (const c of callData || []) {
    if (c.recordType !== 'call' || !String(c.transcript || '').trim()) continue;
    const key = last10Digits(c.phone) || last10Digits(c.contact) || c.contactId || c.link;
    if (!key) continue;
    const prev = byPhone.get(key);
    // Keep the earliest (ISO timestamps sort lexicographically).
    if (!prev || String(c.timestamp || '') < String(prev.timestamp || '')) byPhone.set(key, c);
  }
  return [...byPhone.values()];
}

/** One LLM batch → array of normalized extractions aligned to `calls`. */
async function extractIntakeMarketingBatch(calls, transcriptMaxChars) {
  const items = calls.map((c) => ({
    line: c.line,
    timestamp: c.timestamp,
    summary: c.summary,
    transcript: c.transcript,
    transcriptMaxChars,
  }));
  const prompt = buildIntakeMarketingBatchPrompt({ COMPANY_NAME: firmCtx().firmName, items });
  const text = await runChatCompletion(
    prompt,
    OPENAI_MONTHLY_EXTRACTION_MAX_TOKENS,
    `Intake marketing batch (${calls.length})`,
    { jsonObject: true, throwOnEmpty: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownJsonFence(text));
  } catch {
    return calls.map(() => null);
  }
  const arr = Array.isArray(parsed?.extractions) ? parsed.extractions : Array.isArray(parsed) ? parsed : [];
  return calls.map((_, i) => normalizeIntakeExtraction(arr[i]));
}

function tallyEnum(rows, field) {
  const counts = new Map();
  for (const r of rows) {
    const v = r.extraction[field];
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function tallyArrayField(rows, field, topN = 12) {
  const counts = new Map();
  for (const r of rows) {
    for (const raw of r.extraction[field] || []) {
      const key = String(raw).toLowerCase().trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
}

function pairsToMd(pairs, total) {
  if (!pairs.length) return '_(none)_';
  return pairs
    .map(([k, n]) => `- ${k}: **${n}**${total ? ` (${Math.round((n / total) * 100)}%)` : ''}`)
    .join('\n');
}

/**
 * Intake Marketing Insights. Analyzes each caller's first transcript call in the
 * trailing N days, has the LLM classify intake/new-lead vs existing-client (so
 * leads who since signed are still counted), and mines the intake calls for
 * referral sources, motivations, objections, case types, language, geography and
 * competitors — then writes a marketing brief (email + CSV, optional Slack).
 */
async function runIntakeMarketingReport(opts = {}) {
  const days = opts.days != null
    ? Math.max(1, Math.min(365, Math.floor(Number(opts.days) || 0)))
    : Math.max(1, parseInt(process.env.MARKETING_LOOKBACK_DAYS || '30', 10) || 30);
  const maxCalls = Math.max(0, parseInt(process.env.MARKETING_MAX_CALLS || '500', 10) || 500);
  let batchSize = parseInt(process.env.MARKETING_EXTRACTION_BATCH_SIZE || '15', 10);
  if (!Number.isFinite(batchSize) || batchSize < 1) batchSize = 15;
  batchSize = Math.min(40, batchSize);
  const transcriptCap = Number.isFinite(MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS) && MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS > 0
    ? Math.max(MONTHLY_BATCH_TRANSCRIPT_MAX_CHARS, 2500) : 2500;

  const { createdAfter, createdBefore } = getTrailingDaysRange(days);
  const rangeLabel = buildSentimentTrailingDaysRangeLabel(createdAfter, createdBefore, days);

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Intake Marketing Insights (lead / prospective-client call transcripts)');
  console.log(`  Lookback: ${days} day(s) · ${rangeLabel}`);
  console.log('═'.repeat(52));

  console.log(`\n[1/4] Fetching calls WITH transcripts (${days}-day window)...\n`);
  const { callData } = await runExport({
    apiKey: firmCtx().quoApiKey,
    phoneNumbersFilter: firmCtx().quoPhoneNumbers,
    createdAfter,
    createdBefore,
    weeklyCommunications: true,
    includeMessages: false,
    fetchTranscriptForWeekly: true,
  });

  // Candidates = each caller's first transcript call in the window (most recent first).
  let candidates = firstContactCalls(callData)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  console.log(`\n[2/4] First-contact calls with transcripts (unique callers): ${candidates.length}`);
  if (maxCalls > 0 && candidates.length > maxCalls) {
    candidates = candidates.slice(0, maxCalls);
    console.log(`  MARKETING_MAX_CALLS=${maxCalls} — analyzing the ${maxCalls} most recent.`);
  }
  let intake = candidates;

  if (!OPENAI_API_KEY) {
    console.log('\n[3/4] Skipped — no OPENAI_API_KEY.');
    return { rangeLabel, calls: intake.length, analyzed: 0 };
  }
  if (!intake.length) {
    console.log('\n[3/4] No intake calls to analyze — nothing to report.');
    return { rangeLabel, calls: 0, analyzed: 0 };
  }

  console.log(`\n[3/4] Extracting + classifying (${batchSize}/batch)...`);
  /** @type {{ call: object, extraction: object }[]} */
  const allExtracted = [];
  for (let start = 0; start < intake.length; start += batchSize) {
    const batch = intake.slice(start, start + batchSize);
    process.stdout.write(`  [${start + 1}-${start + batch.length}/${intake.length}] ... `);
    let extractions;
    try {
      extractions = await extractIntakeMarketingBatch(batch, transcriptCap);
    } catch (err) {
      console.log(`failed: ${err.message}`);
      extractions = batch.map(() => null);
    }
    let ok = 0;
    batch.forEach((call, i) => {
      const ex = extractions[i];
      if (ex) {
        ex.language = detectLanguage(call.transcript); // deterministic, don't trust LLM
        allExtracted.push({ call, extraction: ex });
        ok++;
      }
    });
    console.log(`${ok}/${batch.length} extracted`);
    await sleep(SENTIMENT_LLM_DELAY_MS);
  }

  // Keep only genuine intake/new-lead conversations (existing-client calls dropped).
  const rows = allExtracted.filter((r) => r.extraction.call_stage === 'intake_new_lead');
  const droppedClient = allExtracted.filter((r) => r.extraction.call_stage === 'existing_client').length;
  const droppedOther = allExtracted.length - rows.length - droppedClient;
  console.log(
    `  Classified: ${rows.length} intake/new-lead · dropped ${droppedClient} existing-client · ${droppedOther} other.`
  );

  if (!rows.length) {
    console.log('\n[4/4] No intake/new-lead calls to report on.');
    return { rangeLabel, calls: intake.length, analyzed: 0 };
  }

  // Deterministic tallies (authoritative numbers for the brief).
  const n = rows.length;
  const langCounts = { english: 0, spanish: 0, both: 0, unknown: 0 };
  for (const r of rows) langCounts[r.extraction.language] = (langCounts[r.extraction.language] || 0) + 1;

  const talliesMarkdown = [
    `**Intake calls analyzed:** ${n}`,
    `\n**Language (of the call):** English ${langCounts.english} · Spanish ${langCounts.spanish} · Unknown ${langCounts.unknown || 0}`,
    `\n**Referral source (how they found the firm):**\n${pairsToMd(tallyEnum(rows, 'referral_source'), n)}`,
    `\n**Case type:**\n${pairsToMd(tallyEnum(rows, 'case_type'), n)}`,
    `\n**Primary motivation:**\n${pairsToMd(tallyEnum(rows, 'primary_motivation'), n)}`,
    `\n**Urgency:**\n${pairsToMd(tallyEnum(rows, 'urgency'), n)}`,
    `\n**Outcome (as heard on the call):**\n${pairsToMd(tallyEnum(rows, 'retained'), n)}`,
    `\n**Top objections / hesitations:**\n${pairsToMd(tallyArrayField(rows, 'objections'), 0)}`,
    `\n**Top pain points / fears:**\n${pairsToMd(tallyArrayField(rows, 'pain_points'), 0)}`,
    `\n**Top decision factors (why this firm):**\n${pairsToMd(tallyArrayField(rows, 'decision_factors'), 0)}`,
    `\n**Competitors mentioned:**\n${pairsToMd(tallyArrayField(rows, 'competitor_mentions', 10), 0)}`,
    `\n**Geographies mentioned:**\n${pairsToMd(tallyArrayField(rows, 'geography', 10), 0)}`,
  ].join('\n');

  const samplesMarkdown = rows
    .filter((r) => r.extraction.notable_quote)
    .slice(0, 30)
    .map((r) => `- (${r.extraction.case_type}, ${r.extraction.referral_source}) "${r.extraction.notable_quote}"`)
    .join('\n') || '_(no quotes captured)_';

  console.log('\n[4/4] Writing marketing brief...');
  let bodyMd;
  try {
    bodyMd = await runChatCompletion(
      buildIntakeMarketingBriefPrompt({
        COMPANY_NAME: firmCtx().firmName,
        rangeLabel,
        callCount: n,
        talliesMarkdown,
        samplesMarkdown,
      }),
      OPENAI_MONTHLY_AGGREGATE_MAX_TOKENS,
      'Intake marketing brief',
      { throwOnEmpty: true }
    );
  } catch (err) {
    console.warn(`  Brief generation failed: ${err.message}`);
    bodyMd = `# Intake Marketing Insights\n\n_(Brief generation failed: ${err.message})_\n\n## Raw tallies\n\n${talliesMarkdown}`;
  }

  // CSV of per-call extractions
  const csvName = `quo_intake_marketing_${createdBefore.slice(0, 10)}.csv`;
  const csvHeader = ['time', 'line', 'language', 'referral_source', 'case_type', 'primary_motivation', 'urgency', 'retained', 'geography', 'pain_points', 'objections', 'decision_factors', 'competitor_mentions', 'notable_quote'];
  const csvLines = [csvHeader.map(csvCell).join(',')];
  for (const r of rows) {
    const e = r.extraction;
    csvLines.push([
      r.call.timestamp || '', r.call.line || '', e.language, e.referral_source, e.case_type,
      e.primary_motivation, e.urgency, e.retained, e.geography,
      e.pain_points.join('; '), e.objections.join('; '), e.decision_factors.join('; '),
      e.competitor_mentions.join('; '), e.notable_quote,
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(csvName, csvLines.join('\n'), 'utf8');
  console.log(`  Wrote ${csvName}`);

  const subject = `${firmCtx().firmName} — Intake Marketing Insights (${n} calls, ${days}d)`;
  const marketingTo = (process.env.MARKETING_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const recipients = marketingTo.length ? marketingTo : firmCtx().emailTo;

  if (recipients.length && EMAIL_CONFIGURED) {
    try {
      await sendEmail({
        htmlBody: buildMonthlyInsightsEmailHtml(bodyMd, rangeLabel),
        plainText: bodyMd,
        subject,
        attachments: [{ filename: path.basename(csvName), path: csvName }],
        to: recipients,
      });
      console.log(`  Emailed brief + CSV to: ${recipients.join(', ')}`);
    } catch (err) {
      console.warn(`  Email failed: ${err.message}`);
    }
  } else {
    console.log('\n' + bodyMd);
  }

  // Optional Slack summary
  const mktChannel = (process.env.MARKETING_SLACK_CHANNEL || '').trim();
  if (mktChannel && firmCtx().slackBotToken) {
    try {
      const topRef = tallyEnum(rows, 'referral_source').slice(0, 3).map(([k, c]) => `${k} (${c})`).join(', ');
      const topCase = tallyEnum(rows, 'case_type').slice(0, 3).map(([k, c]) => `${k} (${c})`).join(', ');
      await postSlackMessage({
        token: firmCtx().slackBotToken,
        channel: mktChannel,
        text: `📊 Intake Marketing Insights — ${n} calls (${days}d)\nTop sources: ${topRef}\nTop case types: ${topCase}\nLanguage: EN ${langCounts.english} · ES ${langCounts.spanish}\nFull brief emailed${recipients.length ? ` to ${recipients.join(', ')}` : ''}.`,
      });
      console.log(`  Posted summary to #${mktChannel}.`);
    } catch (err) {
      console.warn(`  Slack post failed: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Intake Marketing Insights complete.');
  return { rangeLabel, calls: intake.length, analyzed: n, csvName };
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

  // Disbursement (money/closure) vs ongoing (active case). Defaults to ongoing
  // so we never mislabel an active-case client as a money client.
  const case_stage = String(obj.case_stage || '').trim().toLowerCase() === 'disbursement'
    ? 'disbursement'
    : 'ongoing';

  return {
    review_score,
    confidence,
    qualified: obj.qualified === true,
    case_stage,
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
    COMPANY_NAME: firmCtx().firmName,
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

/** Intro / summary message posted before the per-bucket sections. */
function buildReviewIntroMessage(meta) {
  const { rangeLabel, dateLabel, candidateCount, qualifiedCount, ongoingCount, disbursementCount, reportedCount, canApprove } = meta;
  const approveHint = canApprove
    ? `React :${REVIEW_APPROVE_EMOJI}: (or reply *approve*) on a card to text that client their review link.`
    : '_Approval-to-send is off until the review store + Quo sending are configured._';
  const contextText =
    `Active in last 24h: *${candidateCount}*  ·  Positive: *${qualifiedCount}* ` +
    `(ongoing *${ongoingCount}* · disbursement *${disbursementCount}*)  ·  Showing *${reportedCount}*  ·  ${rangeLabel}`;
  return {
    text: `⭐ Review Intelligence — ${dateLabel} — ${reportedCount} candidate(s)`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⭐ Review Intelligence — ${dateLabel}`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] },
      { type: 'section', text: { type: 'mrkdwn', text: `${approveHint}\n_Money/closure clients are ranked separately from active-case clients so they don't crowd out ongoing-case reviews._` } },
    ],
  };
}

/** Header for one bucket section (ongoing vs disbursement). */
function buildReviewSectionHeader(bucket) {
  const { title, sel, poolCount } = bucket;
  let note;
  if (!sel.items.length) {
    note = poolCount
      ? `_${poolCount} positive, but none this bucket today._`
      : '_None today._';
  } else if (sel.fallbackBest) {
    note = `_No one cleared the bar (score ≥ ${REVIEW_REPORT_MIN_SCORE} + High) — showing this bucket's best positive moment._`;
  } else {
    note = `_${sel.items.length} cleared the bar (score ≥ ${REVIEW_REPORT_MIN_SCORE} + High)._`;
  }
  return {
    text: `${title} — ${sel.items.length} shown`,
    blocks: [
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n${note}` } },
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

/**
 * Action buttons for a review card: Send branded page, Send <platform> (one per
 * configured platform), and Do not send. Clicking one texts the client the right
 * link via the /slack/interactivity handler. Returned as a Block Kit actions
 * block, or null when approval-to-send isn't available.
 */
function buildReviewActionButtons(o, opts = {}) {
  if (!opts.canApprove || !o.reviewRequestId || !o.reviewToken) return null;
  // action_id must be unique among the buttons in a message, or Slack rejects
  // the whole post — so suffix it with the destination.
  const btn = (label, dest, style) => ({
    type: 'button',
    action_id: `review_dest:${dest}`,
    text: { type: 'plain_text', text: label, emoji: true },
    value: JSON.stringify({ t: o.reviewToken, d: dest }),
    ...(style ? { style } : {}),
  });
  const elements = [btn('Send branded page', 'branded', 'primary')];
  for (const p of opts.platforms || []) elements.push(btn(`Send ${p.label}`, p.key));
  elements.push(btn('Do not send', 'cancel', 'danger'));
  return { type: 'actions', elements };
}

/** One self-contained message per candidate, so a ✅ reaction maps to that client. */
function buildReviewCandidateMessage(o, idx, opts = {}) {
  const name = o.clientName || o.clientKey;
  const caseCell = o.caseId ? `Case *${o.caseId}*` : '_no case #_';
  const reasons = (o.reasoning.length ? o.reasoning : o.positive_signals).map((r) => `• ${r}`).join('\n');
  const linkLine = o.reviewLink ? `\n*Review link:* ${o.reviewLink}` : '';
  const approveLine = o.reviewRequestId && o.phone
    ? `\n_React :${REVIEW_APPROVE_EMOJI}: or reply *approve* to text this link to ${o.phone}._`
    : o.reviewRequestId
      ? '\n_No client phone on file — send the link manually._'
      : '';
  const belowBarLine = o.belowBar
    ? `⚠️ _Below the usual bar (score ≥ ${REVIEW_REPORT_MIN_SCORE} + High) — surfaced as this bucket's best positive moment. Use your judgment before sending._\n`
    : '';
  const bucketTag = o.bucket === 'disbursement' ? '💰 Disbursement/closure' : '🟢 Ongoing case';
  const text =
    `*${idx + 1}. ${name}*  ·  ${caseCell}  ·  ${bucketTag}\n` +
    belowBarLine +
    `Score: *${o.review_score}/100*   ·   Confidence: ${reviewConfidenceEmoji(o.confidence)} *${o.confidence}*\n` +
    `*Why they were selected:*\n${reasons || '• Positive signals across recent conversations.'}` +
    linkLine + approveLine;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  const actions = buildReviewActionButtons(o, opts);
  if (actions) blocks.push(actions);
  return {
    text: `${idx + 1}. ${name} — review candidate (${o.review_score}/100)`,
    blocks,
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
    apiKey: firmCtx().quoApiKey,
    phoneNumbersFilter: firmCtx().quoPhoneNumbers,
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

  // Disbursement (money/closure) clients naturally skew very positive, so they'd
  // dominate a single ranking. Score them in a SEPARATE pool from ongoing-case
  // clients. Each pool surfaces its own threshold hits (score ≥ bar + High); a
  // pool with no hit still surfaces its single best (flagged below-bar), so
  // ongoing-case clients are always represented even on a big disbursement day.
  const minConfRank = reviewConfidenceRank(REVIEW_REPORT_MIN_CONFIDENCE);
  const clearsBar = (o) => o.review_score >= REVIEW_REPORT_MIN_SCORE && reviewConfidenceRank(o.confidence) <= minConfRank;

  const selectBucket = (pool) => {
    const hits = pool.filter(clearsBar).slice(0, REVIEW_REPORT_LIMIT);
    if (hits.length) return { items: hits, fallbackBest: false };
    if (REVIEW_REPORT_ALWAYS_SHOW_BEST && pool.length) {
      pool[0].belowBar = true;
      return { items: [pool[0]], fallbackBest: true };
    }
    return { items: [], fallbackBest: false };
  };

  // opportunities is already sorted best-first, so each filtered pool is too.
  const ongoingPool = opportunities.filter((o) => o.case_stage !== 'disbursement');
  const disbursementPool = opportunities.filter((o) => o.case_stage === 'disbursement');
  const ongoingSel = selectBucket(ongoingPool);
  const disbursementSel = selectBucket(disbursementPool);
  ongoingSel.items.forEach((o) => { o.bucket = 'ongoing'; });
  disbursementSel.items.forEach((o) => { o.bucket = 'disbursement'; });

  // Ongoing first so money clients never sit at the very top of the report.
  const buckets = [
    { key: 'ongoing', title: '🟢 Ongoing-case candidates', sel: ongoingSel, poolCount: ongoingPool.length },
    { key: 'disbursement', title: '💰 Disbursement / closure candidates', sel: disbursementSel, poolCount: disbursementPool.length },
  ];
  const reportItems = buckets.flatMap((b) => b.sel.items);
  const surfaced = new Set(reportItems);

  let firm = null;
  try {
    firm = (await firmStore.getFirmById(firmCtx().id)) || (await firmStore.getDefaultFirm());
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
          firmId: firmCtx().id,
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

  const slackToken = firmCtx().slackBotToken;
  const reviewChannel = firmCtx().reviewSlackChannel;
  console.log(
    `\n[5/5] Posting daily Slack report to #${reviewChannel} (${reportItems.length} shown; ${disqualifiedCount} disqualified)...`
  );

  const canApprove = requestsOn && quoSend.isConfigured({ apiKey: firmCtx().quoApiKey, from: firmCtx().quoSendFrom });
  const meta = {
    rangeLabel,
    dateLabel,
    candidateCount: candidates.length,
    qualifiedCount: opportunities.length,
    ongoingCount: ongoingPool.length,
    disbursementCount: disbursementPool.length,
    reportedCount: reportItems.length,
    canApprove,
  };

  // Which direct-platform buttons to show — only platforms this firm has a URL for.
  const reviewCfg = firmStore.landingConfigForFirm(firm);
  const availablePlatforms = [
    { key: 'google', label: 'Google', urlKey: 'googleReviewUrl' },
    { key: 'facebook', label: 'Facebook', urlKey: 'facebookReviewUrl' },
    { key: 'apple', label: 'Apple', urlKey: 'appleReviewUrl' },
    { key: 'yelp', label: 'Yelp', urlKey: 'yelpReviewUrl' },
  ].filter((p) => /^https?:\/\//i.test(String(reviewCfg[p.urlKey] || '').trim()));
  const cardOpts = { canApprove, platforms: availablePlatforms };

  if (!slackToken) {
    console.log('  Slack not configured (SLACK_BOT_TOKEN) — printing report:\n');
    if (!reportItems.length) {
      console.log(buildReviewEmptyMessage(meta).text);
    } else {
      console.log(buildReviewIntroMessage(meta).text);
      for (const b of buckets) {
        console.log('\n' + buildReviewSectionHeader(b).text);
        b.sel.items.forEach((o, i) => console.log(buildReviewCandidateMessage(o, i, cardOpts).text + (o.reviewLink ? `  ${o.reviewLink}` : '')));
      }
    }
  } else {
    try {
      if (!reportItems.length) {
        const empty = buildReviewEmptyMessage(meta);
        await postSlackMessage({ token: slackToken, channel: reviewChannel, text: empty.text, blocks: empty.blocks });
      } else {
        const intro = buildReviewIntroMessage(meta);
        await postSlackMessage({ token: slackToken, channel: reviewChannel, text: intro.text, blocks: intro.blocks });
        // Each bucket: a section header, then one message per candidate (its ts
        // maps back to the review request for ✅ approval).
        for (const b of buckets) {
          const header = buildReviewSectionHeader(b);
          await postSlackMessage({ token: slackToken, channel: reviewChannel, text: header.text, blocks: header.blocks });
          for (let i = 0; i < b.sel.items.length; i++) {
            const o = b.sel.items[i];
            // One card failing must not abort the rest of the report.
            try {
              const msg = buildReviewCandidateMessage(o, i, cardOpts);
              const posted = await postSlackMessage({ token: slackToken, channel: reviewChannel, text: msg.text, blocks: msg.blocks });
              if (o.reviewRequestId && posted?.ts) {
                await reviewRequests.setSlackMessage(o.reviewRequestId, posted.channel || reviewChannel, posted.ts);
              }
            } catch (err) {
              console.warn(`  Could not post/map card for ${o.clientName}: ${err.message}`);
            }
          }
        }
      }
      console.log(`  Posted ${reportItems.length} candidate message(s) across 2 buckets to #${reviewChannel}.`);
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
    apiKey: firmCtx().quoApiKey,
    phoneNumbersFilter: firmCtx().quoPhoneNumbers,
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
  const dailySlackToken = firmCtx().slackBotToken;
  const dailySlackChannel = firmCtx().slackChannel;
  console.log(`\n[3/6] Fetching #${dailySlackChannel} (same window as calls; threads=${slackThreads})...`);
  let slackText = '(Slack not configured — set SLACK_BOT_TOKEN to enable.)';
  if (dailySlackToken) {
    try {
      const slackMessages = await fetchSlackMessages(
        dailySlackToken,
        dailySlackChannel,
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
  if (firmCtx().sheets.sheetsId) {
    try {
      const { text, totalRows } = await getLeadPipelineText(
        firmCtx().sheets.sheetsId,
        firmCtx().sheets.sheetsRange,
        undefined,
        { callData, slackText },
        firmCtx().sheets.columns
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
  if (!firmCtx().emailTo.length || !EMAIL_CONFIGURED) {
    console.log('  Email not configured — printing report:\n');
    console.log('\n--- Daily Intake & Lead Report ---\n');
    console.log(leadAnalysis);
  } else {
    const leadSubject = `${firmCtx().firmName} — Daily Intake & Lead Report — ${dayOfWeek}, ${dateLabel}`;
    const leadHtml = buildEmailHtml(leadAnalysis, stats, dateLabel);
    await sendEmail({
      htmlBody: leadHtml,
      plainText: leadAnalysis,
      subject: leadSubject,
      attachments: [{ filename: path.basename(csvFilename), path: csvFilename }],
    });
    console.log(`  Sent to: ${firmCtx().emailTo.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Done.');
  return { csvFilename, leadAnalysis, stats };
}

// ── Yesterday Call Stats email ────────────────────────────────────────────────
// Recreates the Quo dashboard's Incoming Call Outcomes chart + per-user table
// for a single day, comparing to the same weekday one week ago. All filters
// (excluded inboxes, included users) and recipients are admin-configurable.

const CALL_OUTCOME_ORDER = [
  'Answered by user',
  'Answered by agent',
  'Voicemail',
  'Forwarded',
  'Missed',
  'Abandoned',
  'Agent abandoned',
  'Other',
];

const MISSED_KPI_BUCKETS = new Set(['Missed', 'Voicemail', 'Answered by agent', 'Agent abandoned']);

/** Bucket one INCOMING call into a dashboard outcome (best-effort from status). */
function callOutcomeBucket(c) {
  const status = String(c.status || '').toLowerCase();
  const agent = Boolean(c.aiHandled);
  if (status.includes('voicemail')) return 'Voicemail';
  if (status.includes('forward')) return 'Forwarded';
  if (agent || status === 'ai-handled' || status.includes('ai-agent')) return 'Answered by agent';
  if (status === 'completed' || status === 'answered') {
    // API often returns forwarded taps as completed with no answeredBy.
    if (!c.answeredBy) return 'Forwarded';
    return 'Answered by user';
  }
  if (status.includes('abandon')) return agent ? 'Agent abandoned' : 'Abandoned';
  if (status === 'no-answer' || status.includes('miss') || status === 'busy' || status === 'declined') {
    return agent ? 'Agent abandoned' : 'Missed';
  }
  return 'Other';
}

function formatCallDuration(totalSec) {
  const s = Math.round(Number(totalSec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** "▲240%" / "▼10%" / "±0%" / "▲ new" / "" comparing cur to prev. */
function pctChangeLabel(cur, prev) {
  const a = Number(cur) || 0;
  const b = Number(prev) || 0;
  if (a === 0 && b === 0) return '';
  if (b === 0) return '▲ new';
  const pct = Math.round(((a - b) / b) * 100);
  if (pct === 0) return '±0%';
  return `${pct > 0 ? '▲' : '▼'}${Math.abs(pct)}%`;
}

/** Fetch per-person available-missed counts from quo-router for a time window. */
async function fetchAvailabilityMisses(createdAfter, createdBefore) {
  if (!QUO_ROUTER_URL || !QUO_ROUTER_REPORT_TOKEN) return null;
  const url = new URL(
    `${QUO_ROUTER_URL}/api/reports/${encodeURIComponent(QUO_ROUTER_FIRM_ID)}/availability-misses`
  );
  if (createdAfter) url.searchParams.set('createdAfter', createdAfter);
  if (createdBefore) url.searchParams.set('createdBefore', createdBefore);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${QUO_ROUTER_REPORT_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`quo-router availability-misses ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function personNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Same person, different labels (Slack vs Quo seat). First key is the report display name.
 * Do not put bare "valeria" here — that collides with Valeria Flores.
 */
const AVAILABILITY_PERSON_ALIASES = [
  ['claudia chang', 'claudia', 'valeria chang'],
  // Shared Quo logins used for answered/outbound; Slack phone-staff uses the person name.
  ['jackie', 'legal assistant'],
  ['roman', 'intake specialist'],
];

const AVAILABILITY_DISPLAY_NAMES = {
  'claudia chang': 'Claudia Chang',
  jackie: 'Jackie',
  roman: 'Roman',
};

function availabilityCanonicalName(name) {
  const key = personNameKey(name);
  if (!key) return '';
  for (const group of AVAILABILITY_PERSON_ALIASES) {
    if (group.includes(key)) return group[0];
  }
  return key;
}

function availabilityDisplayName(canonicalKey, fallbackName) {
  if (AVAILABILITY_DISPLAY_NAMES[canonicalKey]) return AVAILABILITY_DISPLAY_NAMES[canonicalKey];
  return fallbackName || canonicalKey;
}

/**
 * Collapse Slack/Quo nicknames for the same person before matching Call Stats rows.
 * Duplicate Phone Staff rows for one person use max(count) so one miss is not doubled.
 */
function consolidateAvailabilityByUser(byUser) {
  const byCanonical = new Map();
  for (const u of byUser || []) {
    const canonical = availabilityCanonicalName(u.name || u.slackUserId);
    if (!canonical) continue;
    const count = Number(u.count) || 0;
    const prev = byCanonical.get(canonical);
    if (!prev) {
      byCanonical.set(canonical, {
        slackUserId: u.slackUserId,
        name: availabilityDisplayName(canonical, u.name || u.slackUserId),
        count,
        onDuty: Boolean(u.onDuty),
      });
      continue;
    }
    prev.count = Math.max(prev.count, count);
    prev.onDuty = prev.onDuty || Boolean(u.onDuty);
    prev.name = availabilityDisplayName(canonical, prev.name);
  }
  return [...byCanonical.values()];
}

/**
 * Map quo-router byUser counts onto Call Stats user rows by display name.
 * Tries full-name match, then unique first-name match.
 */
function availabilityCountByUserName(byUser) {
  const map = new Map(); // lowercased full name → count
  const first = new Map(); // first name → [{ full, count }]
  for (const u of consolidateAvailabilityByUser(byUser)) {
    const full = personNameKey(u.name || u.slackUserId);
    if (!full) continue;
    const count = Number(u.count) || 0;
    map.set(full, count);
    for (const group of AVAILABILITY_PERSON_ALIASES) {
      if (group[0] === full) {
        for (const alias of group) map.set(alias, count);
      }
    }
    const fn = full.split(/\s+/)[0];
    if (!first.has(fn)) first.set(fn, []);
    first.get(fn).push({ full, count });
  }
  return { map, first };
}

function lookupAvailabilityCount(name, index) {
  if (!index) return 0;
  const full = availabilityCanonicalName(name) || personNameKey(name);
  if (index.map.has(full)) return index.map.get(full);
  const raw = personNameKey(name);
  if (raw && index.map.has(raw)) return index.map.get(raw);
  const fn = full.split(/\s+/)[0];
  const candidates = index.first.get(fn) || [];
  if (candidates.length === 1) return candidates[0].count;
  return 0;
}

/** Attach availableMissed (+ prev) onto userRows; append phone-staff-only people. */
function mergeAvailabilityIntoUserRows(userRows, curMisses, prevMisses) {
  const curUsers = consolidateAvailabilityByUser(curMisses?.byUser);
  const prevUsers = consolidateAvailabilityByUser(prevMisses?.byUser);
  const curIdx = availabilityCountByUserName(curUsers);
  const prevIdx = availabilityCountByUserName(prevUsers);
  const usedKeys = new Set();
  const markUsed = (name) => {
    const canonical = availabilityCanonicalName(name);
    usedKeys.add(canonical);
    for (const group of AVAILABILITY_PERSON_ALIASES) {
      if (group[0] === canonical) {
        for (const alias of group) usedKeys.add(alias);
      }
    }
  };
  for (const row of userRows) {
    row.availableMissed = lookupAvailabilityCount(row.name, curIdx);
    row.prev.availableMissed = lookupAvailabilityCount(row.name, prevIdx);
    markUsed(row.name);
    const fn = personNameKey(row.name).split(/\s+/)[0];
    const hit = (curIdx.first.get(fn) || []).find((c) => c.count === row.availableMissed);
    if (hit) markUsed(hit.full);
    // Quo seat labels → person names (Valeria Chang, Legal Assistant, Intake Specialist).
    const canonical = availabilityCanonicalName(row.name);
    if (AVAILABILITY_DISPLAY_NAMES[canonical]) {
      row.name = AVAILABILITY_DISPLAY_NAMES[canonical];
    }
  }
  // If Quo had both a seat login and a person login, collapse to one By User row.
  {
    const byCanonical = new Map();
    const merged = [];
    for (const row of userRows) {
      const key = availabilityCanonicalName(row.name);
      const prev = byCanonical.get(key);
      if (!prev) {
        byCanonical.set(key, row);
        merged.push(row);
        continue;
      }
      prev.total += row.total || 0;
      prev.outgoing += row.outgoing || 0;
      prev.answered += row.answered || 0;
      prev.seconds += row.seconds || 0;
      prev.messages += row.messages || 0;
      prev.availableMissed = Math.max(prev.availableMissed || 0, row.availableMissed || 0);
      prev.onDuty = Boolean(prev.onDuty || row.onDuty);
      if (prev.prev && row.prev) {
        prev.prev.total += row.prev.total || 0;
        prev.prev.outgoing += row.prev.outgoing || 0;
        prev.prev.answered += row.prev.answered || 0;
        prev.prev.seconds += row.prev.seconds || 0;
        prev.prev.messages += row.prev.messages || 0;
        prev.prev.availableMissed = Math.max(prev.prev.availableMissed || 0, row.prev.availableMissed || 0);
      }
      if (AVAILABILITY_DISPLAY_NAMES[key]) prev.name = AVAILABILITY_DISPLAY_NAMES[key];
    }
    userRows.length = 0;
    userRows.push(...merged);
  }
  // Topic-duty / available-miss people with no Quo answered/outbound activity.
  // Includes on-duty roster users even when their available-missed count is 0.
  for (const u of curUsers) {
    const full = availabilityCanonicalName(u.name || u.slackUserId);
    if (!full || usedKeys.has(full)) continue;
    const fn = full.split(/\s+/)[0];
    if ([...usedKeys].some((k) => k.split(/\s+/)[0] === fn && lookupAvailabilityCount(k, curIdx) > 0)) {
      continue;
    }
    markUsed(full);
    userRows.push({
      name: availabilityDisplayName(full, u.name || u.slackUserId),
      total: 0,
      outgoing: 0,
      answered: 0,
      seconds: 0,
      messages: 0,
      availableMissed: Number(u.count) || 0,
      onDuty: Boolean(u.onDuty),
      prev: {
        total: 0,
        outgoing: 0,
        answered: 0,
        seconds: 0,
        messages: 0,
        availableMissed: lookupAvailabilityCount(u.name || u.slackUserId, prevIdx),
      },
    });
  }
  for (const row of userRows) {
    if (row.onDuty != null) continue;
    const full = availabilityCanonicalName(row.name);
    const hit = curUsers.find((u) => availabilityCanonicalName(u.name || u.slackUserId) === full);
    row.onDuty = Boolean(hit?.onDuty);
  }
  userRows.sort(
    (a, b) =>
      b.answered - a.answered ||
      b.availableMissed - a.availableMissed ||
      b.total - a.total
  );
  const prevByName = new Map(
    prevUsers.map((u) => [availabilityCanonicalName(u.name || u.slackUserId), Number(u.count) || 0])
  );
  const availabilityByUser = [...userRows]
    .filter((u) => (u.availableMissed || 0) > 0 || (u.prev?.availableMissed || 0) > 0 || u.onDuty)
    .map((u) => ({
      name: u.name,
      count: Number(u.availableMissed) || 0,
      prev: Number(u.prev?.availableMissed) || prevByName.get(availabilityCanonicalName(u.name)) || 0,
      onDuty: Boolean(u.onDuty),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    userRows,
    totalAvailableMissed: Number(curMisses?.availableButDidNotAnswerCount) || 0,
    prevTotalAvailableMissed: Number(prevMisses?.availableButDidNotAnswerCount) || 0,
    eventsWithAvailableStaff: Number(curMisses?.eventsWithAvailableStaff) || 0,
    eventCount: Number(curMisses?.eventCount) || 0,
    availabilityByUser,
  };
}

/** Aggregate raw call/message records into outcome + per-user tallies. */
function aggregateCallStats({ calls, messages, volumeExcludeLines, ignoreIncomingLines }) {
  // Auto-forward line (RJL Outbound): omit INCOMING only. Outbound calls, talk
  // time, and sent messages on that line are real staff work and still count.
  const ignoreIn = new Set(
    (ignoreIncomingLines || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  );
  const isIgnoredIncomingLine = (c) => ignoreIn.has(String(c.lineName || '').trim().toLowerCase());
  // Transfer lines are excluded from INCOMING VOLUME (a transferred call already
  // counted once on the line it arrived on, so counting the transfer leg would
  // double-count it) but still count for PER-USER attribution — the person who
  // picks up a transferred call really did answer that client.
  const volExclude = new Set(
    (volumeExcludeLines || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  );
  const isVolumeExcluded = (c) => volExclude.has(String(c.lineName || '').trim().toLowerCase());

  const outcomes = {};
  let totalIncoming = 0;
  let ignoredInbound = 0;
  let missedKnown = 0;
  let missedUnknown = 0;
  for (const c of calls) {
    if (!isIncomingDirection(c.direction)) continue;
    if (isIgnoredIncomingLine(c)) {
      ignoredInbound += 1;
      continue;
    }
    if (isVolumeExcluded(c)) continue;
    totalIncoming += 1;
    const b = callOutcomeBucket(c);
    outcomes[b] = (outcomes[b] || 0) + 1;
    if (MISSED_KPI_BUCKETS.has(b)) {
      if (c.knownContact) missedKnown += 1;
      else missedUnknown += 1;
    }
  }
  /** Answered-call counts per Quo line — diagnoses where answered calls land. */
  const answeredByLine = {};
  /** @type {Map<string, { outgoing: number, answered: number, seconds: number, messages: number }>} */
  const perUser = new Map();
  const ensure = (id) => {
    if (!perUser.has(id)) perUser.set(id, { outgoing: 0, answered: 0, seconds: 0, messages: 0 });
    return perUser.get(id);
  };
  for (const c of calls) {
    const inbound = isIncomingDirection(c.direction);
    if (inbound && isIgnoredIncomingLine(c)) continue;
    const completed = ['completed', 'answered'].includes(String(c.status || '').toLowerCase());
    // Attribute by the direction-specific actor: who ANSWERED an inbound call vs
    // who PLACED an outbound one. `userId` is the line/route owner, not the
    // person who handled the call, so it's only a last-resort fallback outbound.
    // Agent (Sona) answers aren't a person's work — they're already in the
    // Missed Calls KPI, and counting them would invent a phantom "user".
    if (inbound && c.aiHandled) continue;
    const actorId = inbound ? c.answeredBy : (c.initiatedBy || c.userId);
    if (!actorId) continue; // forwarded / unattributed calls aren't per-user
    if (!inbound) {
      const u = ensure(actorId);
      u.outgoing += 1;
      u.seconds += Number(c.duration || 0);
    } else if (completed) {
      const u = ensure(actorId);
      u.answered += 1;
      u.seconds += Number(c.duration || 0);
      const ln = c.lineName || '(unknown line)';
      answeredByLine[ln] = (answeredByLine[ln] || 0) + 1;
    }
  }
  for (const m of messages) {
    if (!m.userId || isIncomingDirection(m.direction)) continue; // sent = outgoing
    ensure(m.userId).messages += 1;
  }
  return { outcomes, totalIncoming, perUser, answeredByLine, ignoredInbound, missedKnown, missedUnknown };
}

/**
 * Missed-calls secondary count: Missed + Voicemail + Answered by agent +
 * Agent abandoned. The headline goal is answered-by-user % of incoming.
 */
function missedCallsTotal(agg) {
  const o = agg.outcomes || {};
  return (o['Missed'] || 0) + (o['Voicemail'] || 0) + (o['Answered by agent'] || 0) + (o['Agent abandoned'] || 0);
}

function answeredByUserCount(agg) {
  return (agg.outcomes && agg.outcomes['Answered by user']) || 0;
}

function filterCallsByLineNames(calls, lineNames) {
  const set = new Set((lineNames || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  if (!set.size) return [];
  return (calls || []).filter((c) => set.has(String(c.lineName || '').trim().toLowerCase()));
}

function buildIncomingOutcomesTable(curAgg, prevAgg, view = {}) {
  const totalIn = curAgg.totalIncoming || 0;
  const shareOf = (n) => (totalIn ? `${Math.round((n / totalIn) * 100)}%` : '—');
  const outcomeRows = CALL_OUTCOME_ORDER
    .map((b) => ({ b, cur: curAgg.outcomes[b] || 0, prev: prevAgg.outcomes[b] || 0 }))
    .filter((r) => r.cur || r.prev)
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.b)}</td><td class="num">${r.cur}</td>` +
        `<td class="num">${shareOf(r.cur)}</td>` +
        `<td class="num">${r.prev}</td><td class="num chg">${escapeHtml(pctChangeLabel(r.cur, r.prev))}</td></tr>`
    )
    .join('');
  return `<table>
    <tr><th>Incoming call outcome</th><th class="num">${escapeHtml(view.periodCol || 'Yesterday')}</th><th class="num">% of total</th><th class="num">${escapeHtml(view.compareCol || 'Same day last wk')}</th><th class="num">Change</th></tr>
    ${outcomeRows || '<tr><td colspan="5" class="note">No incoming calls.</td></tr>'}
    <tr class="total"><td>Total incoming</td><td class="num">${curAgg.totalIncoming || 0}</td><td class="num">${totalIn ? '100%' : '—'}</td><td class="num">${prevAgg.totalIncoming || 0}</td><td class="num chg">${escapeHtml(pctChangeLabel(curAgg.totalIncoming || 0, prevAgg.totalIncoming || 0))}</td></tr>
  </table>`;
}

function statsCallerPhone(c) {
  if (c && c.callerPhone) return c.callerPhone;
  if (c && isIncomingDirection(c.direction) && c.from) return c.from;
  const parts = Array.isArray(c && c.participants) ? c.participants : [];
  return parts[0] || '';
}

function tagStatsCallsKnownContact(calls, contactMap) {
  for (const c of calls || []) {
    const phone = statsCallerPhone(c);
    c.callerPhone = phone;
    c.knownContact = Boolean(lookupContactName(contactMap, phone) || lookupContactId(contactMap, phone));
  }
}

function buildCallStatsEmailHtml(dayLabel, curAgg, prevAgg, userRows, meta, missed, view = {}) {
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; background: #ffffff; }
    h2 { margin: 0 0 2px; } h3 { margin: 26px 0 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 10px; background: #ffffff; }
    th, td { border: 1px solid #d0d7de; padding: 7px 10px; text-align: left; font-size: 14px; background: #ffffff; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    .chg { color: #57606a; font-size: 12px; }
    .note { color: #57606a; font-size: 12px; margin-top: 8px; }
    .total td { font-weight: 700; }
    th.hi { font-weight: 800; border-bottom: 2px solid #111; }
    td.hi { font-weight: 800; font-size: 16px; }
  `.trim();

  const outcomeTable = buildIncomingOutcomesTable(curAgg, prevAgg, view);
  const leadsAgg = (meta && meta.leadsCur) || { outcomes: {}, totalIncoming: 0 };
  const leadsPrevAgg = (meta && meta.leadsPrev) || { outcomes: {}, totalIncoming: 0 };
  const leadsLines = (meta && meta.leadsLines) || [];
  const leadsAnswered = answeredByUserCount(leadsAgg);
  const leadsIn = leadsAgg.totalIncoming || 0;
  const leadsPct = leadsIn ? `${Math.round((leadsAnswered / leadsIn) * 100)}%` : '—';
  const leadsOutcomeTable = leadsLines.length
    ? `<h3>Incoming Call Outcomes — ${escapeHtml(leadsLines.join(' + '))}</h3>
    <p class="note" style="margin:0 0 4px">Lead-related inboxes only. Overall numbers above stay the primary goal. Answered by user: <strong>${escapeHtml(leadsPct)}</strong>${leadsIn ? ` (${leadsAnswered} of ${leadsIn})` : ''}.</p>
    ${buildIncomingOutcomesTable(leadsAgg, leadsPrevAgg, view)}`
    : '';

  const cell = (cur, prev, cls = '') =>
    `<td class="num${cls}">${cur}<div class="chg">${escapeHtml(pctChangeLabel(cur, prev))}</div></td>`;
  const showAvail = meta.availabilityConfigured === true;
  const userBody = userRows.length
    ? userRows
        .map(
          (u) =>
            `<tr><td>${escapeHtml(u.name)}</td>` +
            cell(u.total, u.prev.total) +
            cell(u.outgoing, u.prev.outgoing) +
            cell(u.answered, u.prev.answered, ' hi') +
            (showAvail ? cell(u.availableMissed || 0, u.prev?.availableMissed || 0) : '') +
            `<td class="num">${escapeHtml(formatCallDuration(u.seconds))}<div class="chg">${escapeHtml(pctChangeLabel(u.seconds, u.prev.seconds))}</div></td>` +
            cell(u.messages, u.prev.messages) +
            `</tr>`
        )
        .join('')
    : `<tr><td colspan="${showAvail ? 7 : 6}" class="note">No matching users with activity.</td></tr>`;
  const userTable = `<table>
    <tr><th>User</th><th class="num">Total calls</th><th class="num">Outgoing</th><th class="num hi">Answered</th>${showAvail ? '<th class="num">Available missed</th>' : ''}<th class="num">Time on calls</th><th class="num">Sent messages</th></tr>
    ${userBody}
  </table>`;

  const goal = Number(missed.goal) || 85;
  const total = missed.curIn || 0;
  const answered = missed.answered || 0;
  const pct = total ? (answered / total) * 100 : null;
  const metGoal = pct != null && pct >= goal;
  const missedColor = pct == null ? '#57606a' : (metGoal ? '#067647' : '#b42318');
  const pctLabel = pct == null ? '—' : `${Math.round(pct)}%`;
  const prevPct = missed.prevIn ? Math.round(((missed.prevAnswered || 0) / missed.prevIn) * 100) : null;
  const vsLast = pct != null && prevPct != null
    ? `${pctChangeLabel(Math.round(pct), prevPct)} vs last wk (${prevPct}%)`
    : '';
  const ofIncoming = total ? `${answered} of ${total} incoming` : '';
  const missedCallout = `<div style="border:2px solid ${missedColor};border-radius:8px;padding:12px 16px;margin-top:14px;max-width:540px">
      <div style="font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:.5px">Answered by user</div>
      <div style="margin-top:4px"><span style="font-size:36px;font-weight:800;color:${missedColor}">${escapeHtml(pctLabel)}</span>
        <span style="font-size:14px;font-weight:600;color:#57606a;margin-left:6px">${escapeHtml(ofIncoming)}${ofIncoming && vsLast ? ' · ' : ''}${escapeHtml(vsLast)}</span></div>
      <div style="font-size:13px;color:${missedColor};font-weight:600;margin-top:2px">Goal: ${goal}%+ answered by user &mdash; ${pct == null ? 'no incoming' : (metGoal ? 'on target ✓' : 'below goal')}</div>
      <div style="font-size:13px;color:#57606a;margin-top:10px;padding-top:8px;border-top:1px solid #d0d7de">Missed calls (Missed + Voicemail + Answered by agent + Agent abandoned): <strong>${missed.cur}</strong>${missed.prev != null ? ` <span class="chg">· last wk ${missed.prev}</span>` : ''}</div>
      ${missed.known != null ? `<div style="font-size:13px;color:#57606a;margin-top:4px">Of these: <strong>${missed.known}</strong> known contacts · <strong>${missed.unknown}</strong> not in contacts${missed.prevKnown != null ? ` <span class="chg">· last wk ${missed.prevKnown} known / ${missed.prevUnknown} not in contacts</span>` : ''}</div>` : ''}
      ${showAvail && meta.totalAvailableMissed != null ? `<div style="font-size:13px;color:#57606a;margin-top:8px;padding-top:8px;border-top:1px solid #d0d7de">Available missed calls (on that day's Slack topic Inbound/LAs, active, free): <strong>${meta.totalAvailableMissed}</strong>${meta.prevTotalAvailableMissed != null ? ` <span class="chg">· last wk ${meta.prevTotalAvailableMissed}</span>` : ''}${meta.eventsWithAvailableStaff != null ? ` · across <strong>${meta.eventsWithAvailableStaff}</strong> missed/Sona event(s)` : ''}${meta.eventCount != null ? ` · <strong>${meta.eventCount}</strong> missed/Sona event(s) total` : ''}</div>` : ''}
    </div>`;

  const availRows = Array.isArray(meta.availabilityByUser) ? meta.availabilityByUser : [];
  const availBody = availRows.length
    ? availRows
        .map(
          (u) =>
            `<tr><td>${escapeHtml(u.name)}${u.onDuty ? '' : ' <span class="chg">(not on topic)</span>'}</td>` +
            cell(u.count || 0, u.prev || 0) +
            `</tr>`
        )
        .join('')
    : '<tr><td colspan="2" class="note">No available-but-did-not-answer counts in this window.</td></tr>';
  const availSection = showAvail
    ? `<h3>Available but did not answer <span style="font-weight:400;font-size:13px;color:#57606a">— on Inbound/LAs topic, Slack-active, free when a missed or Sona call happened (person × event)</span></h3>
    <table>
      <tr><th>Person</th><th class="num">Available missed</th></tr>
      ${availBody}
      <tr class="total"><td>Total (person × event)</td><td class="num">${meta.totalAvailableMissed || 0}<div class="chg">${escapeHtml(pctChangeLabel(meta.totalAvailableMissed || 0, meta.prevTotalAvailableMissed || 0))}</div></td></tr>
    </table>
    <p class="note" style="margin-top:6px">${meta.eventsWithAvailableStaff || 0} of ${meta.eventCount || 0} missed/Sona event(s) had at least one available person.</p>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <h2>${escapeHtml(view.title || 'Yesterday Call Stats')}</h2>
    <p style="margin:2px 0 0;color:#57606a;font-size:13px">${escapeHtml(view.subtitle || `${dayLabel} · vs same weekday last week`)}</p>

    ${missedCallout}

    ${availSection}

    <h3>Incoming Call Outcomes</h3>
    ${outcomeTable}

    <h3>By User <span style="font-weight:400;font-size:13px;color:#57606a">— sorted by Answered calls${showAvail ? '; Available missed = on topic duty (Inbound/LAs), Slack-active, free when a call was missed' : ''}</span></h3>
    ${userTable}

    ${leadsOutcomeTable}

    <div class="note" style="margin-top:20px;border-top:1px solid #d0d7de;padding-top:10px">
      <p>Incoming inboxes: ${escapeHtml((meta.includedLines || []).join(', ') || 'none')}.${(meta.outboundAlsoLines || []).length ? ` Outgoing calls and sent messages also include ${escapeHtml(meta.outboundAlsoLines.join(', '))}.` : ''} Each number's change is vs the same weekday one week ago.</p>
    </div>
  </body></html>`;
}

function isoTs(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function lineMapFromStats(data) {
  const map = { ...(data.lineById || {}) };
  for (const c of data.calls || []) {
    if (c.phoneNumberId && c.lineName) map[c.phoneNumberId] = c.lineName;
  }
  return map;
}

function statsCallFromLedger(row, lineById) {
  const pnId = row.phone_number_id || '';
  const parts = row.participants && typeof row.participants === 'object' ? row.participants : {};
  const externals = Array.isArray(parts.external) ? parts.external : [];
  const inbound = /^(incoming|inbound)$/i.test(String(row.direction || ''));
  const callerPhone = inbound
    ? (parts.from || externals[0] || '')
    : '';
  return {
    id: row.call_id,
    phoneNumberId: pnId,
    lineName: row.line_name || lineById[pnId] || '',
    participants: externals.length ? externals : (parts.workspace || []),
    answeredBy: row.answered_by || null,
    initiatedBy: row.initiated_by || null,
    userId: row.user_id || null,
    direction: row.direction || '',
    status: row.status || '',
    aiHandled: row.ai_handled ? 'ai-agent' : null,
    duration: Number(row.duration_sec || 0),
    createdAt: isoTs(row.created_at),
    answeredAt: isoTs(row.answered_at) || null,
    forwardedFrom: row.forwarded_from || null,
    forwardedTo: row.forwarded_to || null,
    from: parts.from || null,
    to: parts.to || null,
    callerPhone,
  };
}

/**
 * Quo list-calls drops auto-forward / transfer legs. Merge webhook ledger rows
 * for the same window so Main Line answers and Intake transfer legs show up.
 */
async function enrichStatsFromLedger(data, window, excludeLineNames) {
  if (!pg.isEnabled()) return data;
  try {
    await pg.ensureSchema();
    const exclude = new Set((excludeLineNames || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    const lineById = lineMapFromStats(data);
    const callKey = (id, pn) => `${id || ''}::${pn || ''}`;
    const byKey = new Map((data.calls || []).map((c) => [callKey(c.id, c.phoneNumberId), c]));
    const ledgerCalls = await pg.listQuoCallsInWindow(window.createdAfter, window.createdBefore);
    let added = 0;
    let patched = 0;
    for (const row of ledgerCalls) {
      const mapped = statsCallFromLedger(row, lineById);
      if (exclude.has(String(mapped.lineName || '').trim().toLowerCase())) continue;
      if (!mapped.lineName) continue;
      const key = callKey(mapped.id, mapped.phoneNumberId);
      const existing = byKey.get(key);
      if (existing) {
        let changed = false;
        if (!existing.answeredBy && mapped.answeredBy) {
          existing.answeredBy = mapped.answeredBy;
          changed = true;
        }
        if (!existing.initiatedBy && mapped.initiatedBy) {
          existing.initiatedBy = mapped.initiatedBy;
          changed = true;
        }
        if ((mapped.duration || 0) > (existing.duration || 0)) {
          existing.duration = mapped.duration;
          changed = true;
        }
        if (mapped.status && mapped.status !== existing.status) {
          existing.status = mapped.status;
          changed = true;
        }
        if (!existing.callerPhone && mapped.callerPhone) {
          existing.callerPhone = mapped.callerPhone;
          changed = true;
        }
        if (changed) patched += 1;
        continue;
      }
      if (!mapped.id) continue;
      data.calls.push(mapped);
      byKey.set(key, mapped);
      added += 1;
    }
    const ledgerMsgs = await pg.listQuoMessagesInWindow(window.createdAfter, window.createdBefore);
    const seenMsgIds = new Set((data.messages || []).map((m) => m.id).filter(Boolean));
    const seenMsg = new Set(
      (data.messages || []).map((m) => `${m.phoneNumberId || ''}::${isoTs(m.createdAt)}::${m.userId || ''}`)
    );
    let msgAdded = 0;
    for (const row of ledgerMsgs) {
      const pnId = row.phone_number_id || '';
      const lineName = lineById[pnId] || '';
      if (exclude.has(String(lineName).trim().toLowerCase())) continue;
      const messageId = row.message_id || '';
      if (messageId && seenMsgIds.has(messageId)) continue;
      const msg = {
        id: messageId || null,
        phoneNumberId: pnId,
        lineName,
        userId: row.user_id || null,
        direction: row.direction || '',
        createdAt: isoTs(row.created_at),
      };
      const k = `${msg.phoneNumberId}::${msg.createdAt}::${msg.userId || ''}`;
      if (!messageId && seenMsg.has(k)) continue;
      if (messageId) seenMsgIds.add(messageId);
      seenMsg.add(k);
      data.messages.push(msg);
      msgAdded += 1;
    }
    if (added || patched || msgAdded) {
      console.log(`  [stats] webhook ledger: +${added} call(s), patched ${patched}, +${msgAdded} message(s) (${ledgerCalls.length} ledger call rows)`);
    } else if (ledgerCalls.length) {
      console.log(`  [stats] webhook ledger: ${ledgerCalls.length} call row(s) already present in the API fetch`);
    } else {
      console.log('  [stats] webhook ledger: no rows in this window (Quo → /webhooks/quo not yet recording)');
    }
  } catch (err) {
    console.warn(`  [stats] webhook ledger merge skipped: ${err.message}`);
  }
  return data;
}

function callStatsWindows(slotId, now = DateTime.now().setZone(TIMEZONE)) {
  const slot = firmStore.callStatsSlot(slotId);
  const clock = firmStore.callStatsSlotClock(firmCtx(), slot.id);
  if (slot.window === 'today_so_far') {
    const dayStart = now.startOf('day');
    const dayEnd = dayStart.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
    const prevStart = dayStart.minus({ days: 7 });
    const prevEnd = prevStart.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
    const through = firmStore.clockLabel(clock);
    return {
      slot,
      clock,
      dayStart,
      dayEnd,
      prevStart,
      prevEnd,
      dayLabel: dayStart.toFormat('cccc, LLL d, yyyy'),
      title: `Call Stats — so far today`,
      subtitle: `${dayStart.toFormat('cccc, LLL d, yyyy')} · midnight–${through} · vs same hours last week`,
      periodCol: 'So far today',
      compareCol: 'Same hours last wk',
      windowNote: `today so far through ${through}`,
    };
  }
  const dayStart = now.startOf('day').minus({ days: 1 });
  const dayEnd = dayStart.plus({ days: 1 });
  const prevStart = dayStart.minus({ days: 7 });
  const prevEnd = prevStart.plus({ days: 1 });
  return {
    slot,
    clock,
    dayStart,
    dayEnd,
    prevStart,
    prevEnd,
    dayLabel: dayStart.toFormat('cccc, LLL d, yyyy'),
    title: 'Yesterday Call Stats',
    subtitle: `${dayStart.toFormat('cccc, LLL d, yyyy')} · vs same weekday last week`,
    periodCol: 'Yesterday',
    compareCol: 'Same day last wk',
    windowNote: 'full prior day',
  };
}

/**
 * Call stats email — incoming-call-outcomes + per-user table. `opts.slot` is
 * morning (prior calendar day), midday, or afternoon (today so far through the
 * configured clock). Recipients are the list for that slot.
 */
async function runDailyCallStatsReport(opts = {}) {
  const slotId = firmStore.callStatsSlot(opts.slot).id;
  const weekendCoverage = firmStore.callStatsCoverageIsWeekend(slotId);
  const recipients = firmStore.callStatsEffectiveRecipients(firmCtx(), slotId);
  if (opts.scheduled && !recipients.length) {
    console.log(
      weekendCoverage
        ? `  Call stats ${slotId}: weekend coverage and no weekend recipients — skipping.`
        : `  Call stats ${slotId}: no recipients — skipping.`
    );
    return;
  }

  // Windows are derived in the local zone so a DST change can't shift them.
  const win = callStatsWindows(slotId);
  const cur = { createdAfter: win.dayStart.toUTC().toISO(), createdBefore: win.dayEnd.toUTC().toISO() };
  const prev = { createdAfter: win.prevStart.toUTC().toISO(), createdBefore: win.prevEnd.toUTC().toISO() };
  const dayLabel = win.dayLabel;

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  ${win.title}  [${win.slot.label}]`);
  console.log(`  Day: ${win.subtitle}${weekendCoverage ? '  [weekend coverage list]' : ''}`);
  console.log(`  Window:  ${win.dayStart.toFormat('LLL d, h:mm a')} – ${win.dayEnd.toFormat('LLL d, h:mm a')} ${TIMEZONE} (${win.windowNote})`);
  console.log(`  Compare: ${win.prevStart.toFormat('ccc, LLL d, h:mm a')} – ${win.prevEnd.toFormat('LLL d, h:mm a')} ${TIMEZONE}`);
  console.log('═'.repeat(52));

  const excludeLineNames = firmCtx().statsExcludeInboxes;
  const includeUsers = firmCtx().statsIncludeUsers;
  const apiKey = firmCtx().quoApiKey;

  console.log(`\n[1/3] Fetching ${win.windowNote} (excluding inboxes: ${excludeLineNames.join(', ') || 'none'})...`);
  const curData = await enrichStatsFromLedger(
    await fetchDailyCallStats({ apiKey, ...cur, excludeLineNames }),
    cur,
    excludeLineNames
  );
  console.log(`  ${curData.calls.length} call(s), ${curData.messages.length} message(s) across ${curData.includedLines.length} inbox(es).`);
  console.log('\n[2/3] Fetching same weekday last week (for comparison)...');
  const prevData = await enrichStatsFromLedger(
    await fetchDailyCallStats({ apiKey, ...prev, excludeLineNames }),
    prev,
    excludeLineNames
  );
  console.log(`  ${prevData.calls.length} call(s), ${prevData.messages.length} message(s).`);

  let contactLookupOk = false;
  try {
    const contactMap = await fetchContactMap(apiKey);
    tagStatsCallsKnownContact(curData.calls, contactMap);
    tagStatsCallsKnownContact(prevData.calls, contactMap);
    contactLookupOk = true;
    const knownN = curData.calls.filter((c) => c.knownContact).length;
    console.log(`  Quo contacts: ${knownN} of ${curData.calls.length} call(s) matched a saved contact.`);
  } catch (err) {
    console.warn(`  [stats] contact lookup skipped: ${err.message}`);
  }

  const transferLines = firmCtx().statsTransferInboxes;
  const ignoreIncomingLines = firmCtx().statsIgnoreIncomingInboxes;
  const leadsLines = firmCtx().statsLeadsInboxes;
  const curAgg = aggregateCallStats({ ...curData, volumeExcludeLines: transferLines, ignoreIncomingLines });
  const prevAgg = aggregateCallStats({ ...prevData, volumeExcludeLines: transferLines, ignoreIncomingLines });
  const curLeadsAgg = aggregateCallStats({
    calls: filterCallsByLineNames(curData.calls, leadsLines),
    messages: [],
    volumeExcludeLines: transferLines,
    ignoreIncomingLines,
  });
  const prevLeadsAgg = aggregateCallStats({
    calls: filterCallsByLineNames(prevData.calls, leadsLines),
    messages: [],
    volumeExcludeLines: transferLines,
    ignoreIncomingLines,
  });
  console.log(`  Ignoring incoming on: ${ignoreIncomingLines.join(', ') || 'none'} (dropped ${curAgg.ignoredInbound || 0} inbound; outbound + sent messages still count)`);
  console.log(`  Answered calls by line: ${Object.entries(curAgg.answeredByLine).map(([l, n]) => `${l}=${n}`).join(' · ') || 'none'}`);
  console.log(`  (transfer lines counted for per-user answered, excluded from incoming volume: ${transferLines.join(', ') || 'none'})`);

  // Merge the userId→name maps from both windows for display.
  const userMap = { ...prevData.userMap, ...curData.userMap };
  const includeSet = new Set(includeUsers.map((n) => n.toLowerCase()));
  const usersFilterActive = includeSet.size > 0;
  const allIds = new Set([...curAgg.perUser.keys(), ...prevAgg.perUser.keys()]);
  // If an actor id has no name in the workspace user map, the name-based include
  // filter would silently drop that person's calls — surface it rather than
  // quietly reporting zeros.
  const unresolvedIds = [...allIds].filter((id) => !userMap[id]);
  if (unresolvedIds.length) {
    const detail = unresolvedIds.slice(0, 6).map((id) => {
      const c = curAgg.perUser.get(id) || { outgoing: 0, answered: 0 };
      return `${id} (answered ${c.answered}, out ${c.outgoing})`;
    });
    console.warn(`  Note: ${unresolvedIds.length} user id(s) had call activity but no name in the Quo user map — excluded by the user filter: ${detail.join(' · ')}`);
  }
  const zero = { outgoing: 0, answered: 0, seconds: 0, messages: 0 };
  const userRows = [];
  for (const id of allIds) {
    const name = userMap[id] || id;
    if (usersFilterActive && !includeSet.has(String(name).toLowerCase())) continue;
    const c = curAgg.perUser.get(id) || zero;
    const p = prevAgg.perUser.get(id) || zero;
    userRows.push({
      name,
      total: c.outgoing + c.answered,
      outgoing: c.outgoing,
      answered: c.answered,
      seconds: c.seconds,
      messages: c.messages,
      prev: { total: p.outgoing + p.answered, outgoing: p.outgoing, answered: p.answered, seconds: p.seconds, messages: p.messages },
    });
  }
  // Answered is the number the team is coached on, so lead with it.
  userRows.sort((a, b) => b.answered - a.answered || b.total - a.total);

  let curMisses = null;
  let prevMisses = null;
  let availabilityConfigured = Boolean(QUO_ROUTER_URL && QUO_ROUTER_REPORT_TOKEN);
  if (availabilityConfigured) {
    try {
      console.log('\n[2b/3] Fetching available-missed counts from quo-router...');
      curMisses = await fetchAvailabilityMisses(cur.createdAfter, cur.createdBefore);
      prevMisses = await fetchAvailabilityMisses(prev.createdAfter, prev.createdBefore);
      console.log(
        `  Available missed (person×event): ${curMisses?.availableButDidNotAnswerCount ?? 0}` +
          ` across ${curMisses?.eventsWithAvailableStaff ?? 0} event(s)` +
          ` (last wk ${prevMisses?.availableButDidNotAnswerCount ?? 0})`
      );
    } catch (err) {
      console.warn(`  [stats] quo-router availability skipped: ${err.message}`);
      availabilityConfigured = false;
    }
  } else {
    console.log('\n[2b/3] Skipping available-missed counts (set QUO_ROUTER_URL + QUO_ROUTER_REPORT_TOKEN)');
  }
  const availMerged = mergeAvailabilityIntoUserRows(userRows, curMisses, prevMisses);

  const missed = {
    cur: missedCallsTotal(curAgg),
    prev: missedCallsTotal(prevAgg),
    curIn: curAgg.totalIncoming,
    prevIn: prevAgg.totalIncoming,
    answered: answeredByUserCount(curAgg),
    prevAnswered: answeredByUserCount(prevAgg),
    goal: firmStore.callStatsSlotGoal(firmCtx(), slotId),
    known: contactLookupOk ? curAgg.missedKnown : null,
    unknown: contactLookupOk ? curAgg.missedUnknown : null,
    prevKnown: contactLookupOk ? prevAgg.missedKnown : null,
    prevUnknown: contactLookupOk ? prevAgg.missedUnknown : null,
  };

  const answeredPct = missed.curIn ? Math.round((missed.answered / missed.curIn) * 100) : null;
  const prevAnsweredPct = missed.prevIn ? Math.round((missed.prevAnswered / missed.prevIn) * 100) : null;
  console.log(`\n[3/3] ANSWERED BY USER: ${answeredPct == null ? '—' : answeredPct + '%'} (${missed.answered} of ${missed.curIn}, goal ${missed.goal}%+, last wk ${prevAnsweredPct == null ? '—' : prevAnsweredPct + '%'})`);
  console.log(`  Missed calls (Missed+Voicemail+Agent-answered+Agent-abandoned): ${missed.cur} (last wk ${missed.prev})`);
  if (contactLookupOk) {
    console.log(`  Of these: ${missed.known} known contacts · ${missed.unknown} not in contacts (last wk ${missed.prevKnown} known / ${missed.prevUnknown} not in contacts)`);
  }
  if (availabilityConfigured) {
    console.log(
      `  Available missed calls: ${availMerged.totalAvailableMissed} (last wk ${availMerged.prevTotalAvailableMissed})`
    );
  }
  const leadsAnsweredN = answeredByUserCount(curLeadsAgg);
  const leadsInN = curLeadsAgg.totalIncoming || 0;
  console.log(`  Incoming: ${curAgg.totalIncoming} (last wk ${prevAgg.totalIncoming}) · users in table: ${userRows.length}`);
  console.log(`  Leads+Intake (${leadsLines.join(', ') || 'none'}): ${leadsInN} incoming, answered by user ${leadsInN ? Math.round((leadsAnsweredN / leadsInN) * 100) : 0}% (${leadsAnsweredN})`);
  for (const b of CALL_OUTCOME_ORDER) {
    if (curAgg.outcomes[b]) console.log(`   ${b}: ${curAgg.outcomes[b]}`);
  }
  for (const u of userRows) {
    console.log(
      `   - ${u.name}: total ${u.total}, out ${u.outgoing}, answered ${u.answered}` +
        (availabilityConfigured ? `, available missed ${u.availableMissed || 0}` : '') +
        `, ${formatCallDuration(u.seconds)}, msgs ${u.messages}`
    );
  }

  const ignoreIncomingSet = new Set(ignoreIncomingLines.map((s) => String(s).trim().toLowerCase()));
  const incomingLines = (curData.includedLines || []).filter(
    (n) => !ignoreIncomingSet.has(String(n).trim().toLowerCase())
  );
  const meta = {
    includedLines: incomingLines,
    outboundAlsoLines: ignoreIncomingLines,
    leadsLines,
    leadsCur: curLeadsAgg,
    leadsPrev: prevLeadsAgg,
    availabilityConfigured,
    totalAvailableMissed: availabilityConfigured ? availMerged.totalAvailableMissed : null,
    prevTotalAvailableMissed: availabilityConfigured ? availMerged.prevTotalAvailableMissed : null,
    eventsWithAvailableStaff: availabilityConfigured ? availMerged.eventsWithAvailableStaff : null,
    eventCount: availabilityConfigured ? availMerged.eventCount : null,
    availabilityByUser: availabilityConfigured ? availMerged.availabilityByUser : [],
  };
  const html = buildCallStatsEmailHtml(dayLabel, curAgg, prevAgg, userRows, meta, missed, win);
  const plainLines = [
    `${win.title} — ${win.subtitle}`,
    '',
    `** ANSWERED BY USER: ${answeredPct == null ? '—' : answeredPct + '%'} ** (${missed.answered} of ${missed.curIn} incoming) — goal ${missed.goal}%+ (last wk ${prevAnsweredPct == null ? '—' : prevAnsweredPct + '%'})`,
    `  Missed calls (Missed + Voicemail + Answered by agent + Agent abandoned): ${missed.cur} (last wk ${missed.prev})`,
    ...(missed.known != null
      ? [`  Of these: ${missed.known} known contacts · ${missed.unknown} not in contacts (last wk ${missed.prevKnown} known / ${missed.prevUnknown} not in contacts)`]
      : []),
    ...(availabilityConfigured
      ? [
          `  Available missed calls: ${availMerged.totalAvailableMissed} (last wk ${availMerged.prevTotalAvailableMissed}) across ${availMerged.eventsWithAvailableStaff} of ${availMerged.eventCount} missed/Sona event(s)`,
          '  Available but did not answer (by person):',
          ...(availMerged.availabilityByUser || []).map(
            (u) => `    ${u.name}: ${u.count} (last wk ${u.prev || 0})`
          ),
        ]
      : []),
    '',
    'Incoming Call Outcomes:',
    ...CALL_OUTCOME_ORDER.filter((b) => curAgg.outcomes[b] || prevAgg.outcomes[b]).map((b) => {
      const n = curAgg.outcomes[b] || 0;
      const share = curAgg.totalIncoming ? `${Math.round((n / curAgg.totalIncoming) * 100)}%` : '—';
      return `  ${b}: ${n} (${share} of total, last wk ${prevAgg.outcomes[b] || 0})`;
    }),
    `  Total incoming: ${curAgg.totalIncoming} (last wk ${prevAgg.totalIncoming})`,
    '',
    'By User — sorted by ANSWERED (answered / available missed / total / outgoing / time / sent msgs):',
    ...userRows.map(
      (u) =>
        `  ${u.name}: answered ${u.answered}` +
        (availabilityConfigured ? ` · available missed ${u.availableMissed || 0}` : '') +
        ` · ${u.total} total / ${u.outgoing} out / ${formatCallDuration(u.seconds)} / ${u.messages} msgs`
    ),
    '',
    `Incoming Call Outcomes — ${leadsLines.join(' + ') || 'Leads + Intake'}:`,
    `  Answered by user: ${leadsInN ? Math.round((leadsAnsweredN / leadsInN) * 100) : 0}% (${leadsAnsweredN} of ${leadsInN})`,
    ...CALL_OUTCOME_ORDER.filter((b) => curLeadsAgg.outcomes[b] || prevLeadsAgg.outcomes[b]).map((b) => {
      const n = curLeadsAgg.outcomes[b] || 0;
      const share = curLeadsAgg.totalIncoming ? `${Math.round((n / curLeadsAgg.totalIncoming) * 100)}%` : '—';
      return `  ${b}: ${n} (${share} of total, last wk ${prevLeadsAgg.outcomes[b] || 0})`;
    }),
    `  Total incoming: ${curLeadsAgg.totalIncoming} (last wk ${prevLeadsAgg.totalIncoming})`,
  ];
  const plainText = plainLines.join('\n');
  const subject = `${firmCtx().firmName} — ${win.title} — ${dayLabel}`;

  if (!recipients.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured (set this send’s recipients in admin, or STATS_EMAIL_TO + Gmail OAuth) — printing report:\n');
    console.log(plainText);
  } else {
    await sendEmail({ htmlBody: html, plainText, subject, to: recipients });
    console.log(
      `\n  Sent ${win.title} [${slotId}${weekendCoverage ? ', weekend coverage' : ''}] to: ${recipients.join(', ')}`
    );
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`${win.title} complete.`);
}

function intakeGradingBand(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 70) return 'coaching needed';
  return 'priority coaching';
}

function intakeGradingBandColor(band) {
  const b = String(band || '').toLowerCase();
  if (b.includes('excellent')) return '#067647';
  if (b.includes('good')) return '#175cd3';
  if (b.includes('priority')) return '#b42318';
  if (b.includes('coaching')) return '#b54708';
  return '#57606a';
}

function intakeGradingBandBg(band) {
  const b = String(band || '').toLowerCase();
  if (b.includes('excellent')) return '#ecfdf3';
  if (b.includes('good')) return '#eff8ff';
  if (b.includes('priority')) return '#fef3f2';
  if (b.includes('coaching')) return '#fffaeb';
  return '#f6f8fa';
}

function intakeCallType(grade) {
  return String(grade && grade.classification && grade.classification.call_type || '')
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

/** New-lead interactions we publish grades for (Intake / Leads lines only). */
function isScoreableNewLeadCallType(callType) {
  const ct = String(callType || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (['existing_client', 'known_lead', 'administrative'].includes(ct)) return false;
  return ['new_lead', 'contract_follow_up', 'referral_or_decline', 'unknown', ''].includes(ct);
}

function intakeGradeTrack(grade) {
  const raw = String(grade && grade.classification && grade.classification.track || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (raw === 'injury_lead' || raw === 'pi_lead' || raw === 'qualified_lead') return 'injury_lead';
  if (raw === 'other' || raw === 'non_pi' || raw === 'not_a_lead') return 'other';
  const ct = intakeCallType(grade);
  const path = String(grade && grade.classification && grade.classification.case_path || '').toLowerCase();
  if (['existing_client', 'administrative', 'known_lead'].includes(ct) || /referral|admin|existing/.test(ct)) {
    return 'other';
  }
  if (ct === 'new_lead' || ct === 'contract_follow_up') {
    return path === 'declined' ? 'other' : 'injury_lead';
  }
  if (path === 'declined') return 'other';
  if (path === 'signable' || path === 'undecided') return 'injury_lead';
  return 'other';
}

function formatIntakeFlag(f) {
  if (!f) return '';
  if (typeof f === 'string') return f.replace(/_/g, ' ');
  const type = f.type || f.flag || f.id || '';
  return String(type).replace(/_/g, ' ');
}

function avgInts(nums) {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function isIntakeGradingLine(line, lineSet) {
  const n = String(line || '').trim().toLowerCase();
  if (!n) return false;
  if (lineSet.size && lineSet.has(n)) return true;
  return /\b(lead|intake)s?\b/.test(n);
}

function looksLikeQuoUserId(v) {
  return /^US[A-Z0-9]+$/i.test(String(v || '').trim());
}

/** Quo display names often append "ES 1752" / extension digits — strip for matching & display. */
function cleanQuoDisplayName(name) {
  return String(name || '')
    .replace(/\s+ES\s+\d{3,}\s*$/i, '')
    .replace(/\s+#?\d{3,5}\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First names / full names used to match agent self-intros in transcripts. */
const RJL_STAFF_NAME_HINTS = [
  'Cody Garza', 'Ariel Allen', 'Ryan Toomey', 'Jorge Barros', 'Erin',
  'Adrian', 'Jocelyn', 'Aibeth', 'Ivette', 'Yvette',
  'Roman', 'Liz', 'Giselle', 'Samari', 'Sam', 'Santiago Ortiz', 'Santiago',
  'Jackie', 'Claudia', 'Claudia Chang', 'Valeria', 'Valeria Chang', 'Valeria Flores', 'Valerie', 'Valery',
  'Intake', 'Paralegal',
];

function staffNamesForMatching(userMap) {
  const fromQuo = Object.values(userMap || {})
    .map(cleanQuoDisplayName)
    .filter((n) => n && !looksLikeQuoUserId(n) && n.length >= 2);
  const seen = new Set();
  const out = [];
  for (const n of [...fromQuo, ...RJL_STAFF_NAME_HINTS]) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prefer the staff name the agent used on the call (vs Quo account label).
 * Matches intros like "this is Santiago", "hablas con Liz", "mi nombre es Roman".
 */
function matchHandlerFromTranscript(transcript, staffNames) {
  const text = String(transcript || '');
  if (!text || !staffNames?.length) return null;
  const head = text.slice(0, 3500);
  for (const name of staffNames) {
    if (!name || name.length < 2) continue;
    const esc = escapeRegExp(name);
    const intro = new RegExp(
      `(?:this is|i(?:'m| am)|my name is|speaking(?: with)?|` +
        `hablas?\\s+con|le\\s+habla|mi\\s+nombre\\s+es|soy)\\s+${esc}\\b` +
        `|\\b${esc}\\s+(?:speaking|here|con\\s+usted)`,
      'i'
    );
    if (intro.test(head) || intro.test(text)) return cleanQuoDisplayName(name);
  }
  for (const name of staffNames) {
    const parts = String(name).trim().split(/\s+/);
    if (parts.length < 2) continue;
    const esc = escapeRegExp(name);
    if (new RegExp(`\\b${esc}\\b`, 'i').test(head)) return cleanQuoDisplayName(name);
  }
  return null;
}

function lineFallbackHandlerName(line) {
  const n = String(line || '').trim();
  if (/intake/i.test(n)) return 'Intake';
  if (/lead/i.test(n)) return 'Leads';
  if (/paralegal/i.test(n)) return n;
  return n || 'Unknown';
}

/**
 * Who handled the recording.
 * Priority: staff name from transcript (vs staff / Quo user list) → line label (Intake / Leads).
 * Do not use Quo answeredBy display names — those often look like the contact, not the agent.
 */
function resolveIntakeHandler(c, userMap, staffNames) {
  const inbound = isIncomingDirection(c.direction);
  let handlerId = null;
  if (inbound) {
    handlerId = c.answeredBy || c.userId || null;
  } else {
    handlerId = c.initiatedBy || c.userId || null;
  }

  const names = staffNames || staffNamesForMatching(userMap);
  const fromTranscript = matchHandlerFromTranscript(c.transcript, names);
  const fromLine = lineFallbackHandlerName(c.line);
  const handlerName = fromTranscript || fromLine;

  return {
    handlerId: handlerId || (fromTranscript ? 'transcript' : 'line'),
    handlerName,
    handlerSource: fromTranscript ? 'transcript' : 'line',
  };
}

function normalizeIntakeGrade(obj, callId) {
  if (!obj || typeof obj !== 'object') return null;
  let status = String(obj.grading_status || '').toLowerCase();
  if (!['graded', 'insufficient_evidence', 'out_of_scope'].includes(status)) {
    status = obj.overall_score == null ? 'insufficient_evidence' : 'graded';
  }
  let score = obj.overall_score;
  if (score != null) {
    score = Number(score);
    if (!Number.isFinite(score)) score = null;
    else score = Math.max(0, Math.min(100, Math.round(score)));
  }
  if (status === 'graded' && score == null) status = 'insufficient_evidence';
  const flags = Array.isArray(obj.critical_flags) ? obj.critical_flags : [];
  const classification = obj.classification && typeof obj.classification === 'object' ? { ...obj.classification } : {};
  const grade = {
    call_id: String(obj.call_id || callId || ''),
    grading_status: status,
    overall_score: status === 'graded' ? score : null,
    score_band: status === 'graded' ? String(obj.score_band || intakeGradingBand(score) || '') : null,
    classification,
    coverage: obj.coverage == null || obj.coverage === '' ? null : Number(obj.coverage),
    confidence: obj.confidence || null,
    categories: Array.isArray(obj.categories) ? obj.categories : [],
    critical_flags: flags,
    strengths: Array.isArray(obj.strengths) ? obj.strengths.slice(0, 3).map((s) => String(s || '').trim()).filter(Boolean) : [],
    coaching_priorities: Array.isArray(obj.coaching_priorities)
      ? obj.coaching_priorities.slice(0, 3).map((s) => String(s || '').trim()).filter(Boolean)
      : [],
    summary: String(obj.summary || '').trim(),
  };
  classification.track = intakeGradeTrack(grade);
  return grade;
}

async function gradeOneIntakeCall(call) {
  const prompt = buildIntakeGradingPrompt({ call });
  const text = await runChatCompletion(
    prompt,
    OPENAI_INTAKE_GRADING_MAX_TOKENS,
    `Intake grade ${call.id || call.phone || ''}`,
    { jsonObject: true, throwOnEmpty: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownJsonFence(text));
  } catch {
    return null;
  }
  return normalizeIntakeGrade(parsed, call.id);
}

function intakeScoreCell(score, band) {
  if (score == null) return '<span style="color:#667085">—</span>';
  const color = intakeGradingBandColor(band);
  return `<span style="font-size:22px;font-weight:800;color:${color};line-height:1">${score}</span>`;
}

function intakeBadge(label, color, bg) {
  return `<span style="display:inline-block;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.02em;color:${color};background:${bg};white-space:nowrap">${escapeHtml(label)}</span>`;
}

function buildIntakeCallCard(r) {
  const track = intakeGradeTrack(r.grade);
  const band = (r.grade && r.grade.score_band) || intakeGradingBand(r.grade && r.grade.overall_score) || '';
  const color = intakeGradingBandColor(band);
  const bg = intakeGradingBandBg(band);
  const score = r.grade && r.grade.overall_score != null ? r.grade.overall_score : null;
  const who = r.contact || r.phone || 'Unknown caller';
  const dir = isIncomingDirection(r.direction) ? 'Inbound' : 'Outbound';
  const coaching = (r.grade.coaching_priorities || []).slice(0, 2);
  const flags = (r.grade.critical_flags || []).map(formatIntakeFlag).filter(Boolean);
  const trackBadge = track === 'injury_lead'
    ? intakeBadge('Injury lead', '#175cd3', '#eff8ff')
    : intakeBadge('Other / non-PI', '#344054', '#f2f4f7');
  const bandBadge = band ? intakeBadge(band.replace(/_/g, ' '), color, bg) : '';
  const coachingHtml = coaching.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px">${coaching.map((c) => `
        <tr>
          <td style="width:10px;vertical-align:top;color:${color};font-weight:800;padding:0 6px 4px 0">›</td>
          <td style="font-size:13px;color:#344054;line-height:1.45;padding:0 0 4px">${escapeHtml(c)}</td>
        </tr>`).join('')}</table>`
    : '';
  const flagHtml = flags.length
    ? `<div style="margin-top:8px">${flags.map((f) => intakeBadge(f, '#b42318', '#fef3f2')).join(' ')}</div>`
    : '';
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:#ffffff;border:1px solid #e4e7ec;border-radius:10px;border-left:5px solid ${color}">
    <tr>
      <td style="width:72px;padding:16px 8px 16px 16px;vertical-align:top;text-align:center">
        ${intakeScoreCell(score, band)}
        <div style="font-size:10px;color:#667085;margin-top:4px;text-transform:uppercase;letter-spacing:0.04em">score</div>
      </td>
      <td style="padding:16px 16px 16px 8px;vertical-align:top">
        <div style="font-size:15px;font-weight:700;color:#101828">${escapeHtml(r.handlerName)}</div>
        <div style="font-size:12px;color:#667085;margin:2px 0 8px">${escapeHtml(formatTimestamp(r.timestamp))} · ${escapeHtml(dir)} · ${escapeHtml(r.line || '')} · ${escapeHtml(formatCallDuration(r.duration))}</div>
        <div style="margin-bottom:8px">${trackBadge} ${bandBadge}</div>
        <div style="font-size:13px;font-weight:600;color:#344054;margin-bottom:4px">${escapeHtml(who)}${r.contact && r.phone ? ` <span style="font-weight:400;color:#667085">${escapeHtml(r.phone)}</span>` : ''}</div>
        <div style="font-size:13px;color:#344054;line-height:1.5">${escapeHtml(r.grade.summary || '—')}</div>
        ${coachingHtml}
        ${flagHtml}
        <div style="margin-top:12px"><a href="${escapeHtml(r.link || '#')}" style="display:inline-block;padding:7px 12px;border-radius:6px;background:#0A1C40;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none">Open in Quo →</a></div>
      </td>
    </tr>
  </table>`;
}

function buildIntakeGradingEmailHtml(dayLabel, windowNote, userSummaries, rows, excluded, inboxes) {
  const injuryRows = rows.filter((r) => intakeGradeTrack(r.grade) === 'injury_lead');
  const otherRows = rows.filter((r) => intakeGradeTrack(r.grade) !== 'injury_lead');
  const injuryAvg = avgInts(injuryRows.map((r) => r.grade.overall_score).filter((n) => Number.isFinite(n)));
  const otherAvg = avgInts(otherRows.map((r) => r.grade.overall_score).filter((n) => Number.isFinite(n)));
  const flagCount = rows.reduce((n, r) => n + (r.grade.critical_flags || []).length, 0);
  const kpi = (label, value, sub, color) => `
    <td style="width:25%;padding:4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e4e7ec;border-radius:10px">
        <tr><td style="padding:14px 12px">
          <div style="font-size:11px;font-weight:700;color:#667085;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(label)}</div>
          <div style="font-size:28px;font-weight:800;color:${color || '#0A1C40'};line-height:1.15;margin-top:4px">${value}</div>
          <div style="font-size:12px;color:#667085;margin-top:4px">${escapeHtml(sub)}</div>
        </td></tr>
      </table>
    </td>`;

  const handlerRows = userSummaries.length
    ? userSummaries.map((u) => {
        const bandColor = intakeGradingBandColor(u.band);
        const injuryTxt = u.injury.n ? `<span style="font-weight:800;color:${intakeGradingBandColor(intakeGradingBand(u.injury.avg))}">${u.injury.avg}</span> <span style="color:#667085">(${u.injury.n})</span>` : '<span style="color:#98a2b3">—</span>';
        const otherTxt = u.other.n ? `<span style="font-weight:800;color:${intakeGradingBandColor(intakeGradingBand(u.other.avg))}">${u.other.avg}</span> <span style="color:#667085">(${u.other.n})</span>` : '<span style="color:#98a2b3">—</span>';
        return `<tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;font-weight:600;color:#101828">${escapeHtml(u.name)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;text-align:right">${injuryTxt}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;text-align:right">${otherTxt}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7;text-align:right">${u.flags || '—'}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #f2f4f7">${u.band ? intakeBadge(u.band, bandColor, intakeGradingBandBg(u.band)) : '—'}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" style="padding:16px;color:#667085">No scoreable intake calls in this window.</td></tr>';

  const section = (title, blurb, list) => `
    <h3 style="margin:28px 0 6px;font-size:16px;color:#0A1C40">${escapeHtml(title)}</h3>
    <p style="margin:0 0 12px;font-size:12px;color:#667085">${escapeHtml(blurb)}</p>
    ${list.length ? list.map(buildIntakeCallCard).join('') : `<p style="color:#667085;font-size:13px">None in this window.</p>`}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7">
<tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
  <tr><td style="background:#0A1C40;border-radius:12px 12px 0 0;padding:28px 28px 24px">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#45C7F0">Intake Quality Briefing</div>
    <div style="font-size:26px;font-weight:800;color:#ffffff;margin-top:6px">Call Grading</div>
    <div style="font-size:14px;color:#d0d5dd;margin-top:6px">${escapeHtml(dayLabel)}</div>
    <div style="font-size:12px;color:#98a2b3;margin-top:2px">${escapeHtml(windowNote)}</div>
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 20px 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${kpi('Injury-lead avg', injuryAvg == null ? '—' : injuryAvg, `${injuryRows.length} qualified PI / consults`, intakeGradingBandColor(intakeGradingBand(injuryAvg)))}
        ${kpi('Other-call avg', otherAvg == null ? '—' : otherAvg, `${otherRows.length} non-PI / not a lead`, intakeGradingBandColor(intakeGradingBand(otherAvg)))}
        ${kpi('Graded', String(rows.length), `Injury ${injuryRows.length} · Other ${otherRows.length}`, '#0A1C40')}
        ${kpi('Flags', String(flagCount), 'Items needing review', flagCount ? '#b42318' : '#067647')}
      </tr>
    </table>
    <p style="margin:14px 8px 0;font-size:12px;color:#667085;line-height:1.5">
      Injury leads are graded on qualification, value, and next-step conversion.
      Other calls are graded on correct scope, respectful decline, and referral handling — not contract pitching.
    </p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:8px 20px 20px">
    <h3 style="margin:16px 0 8px;font-size:16px;color:#0A1C40">Team snapshot</h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-radius:10px;overflow:hidden">
      <tr style="background:#f9fafb">
        <th align="left" style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085">Handler</th>
        <th align="right" style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085">Injury avg (n)</th>
        <th align="right" style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085">Other avg (n)</th>
        <th align="right" style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085">Flags</th>
        <th align="left" style="padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#667085">Band</th>
      </tr>
      ${handlerRows}
    </table>
    ${section(
      'Injury leads & consultations',
      'Goal: qualify the injury, present RJL value, and advance a contract or same-day attorney review.',
      injuryRows
    )}
    ${section(
      'Other calls (not a PI lead)',
      'Goal: confirm the matter is out of scope (or escalate if it might be PI), explain clearly, and offer an approved referral.',
      otherRows
    )}
    <p style="margin:24px 0 0;font-size:12px;color:#667085;line-height:1.55">
      Inboxes included: ${escapeHtml((inboxes || []).join(', ') || 'Leads, Intake')}.
      Only <strong>new</strong> intake leads are scored.
      Excluded too short / no transcript / Sona: ${excluded.short}.
      Skipped existing client / known lead: ${excluded.notNewLead || 0}.
      Out of scope or insufficient evidence: ${excluded.unscored}.
      Calls under ${INTAKE_GRADING_MIN_SECONDS}s are not scored.
    </p>
  </td></tr>
  <tr><td style="background:#0A1C40;border-radius:0 0 12px 12px;padding:14px 28px;font-size:11px;color:#98a2b3">Ramos James Law · Internal coaching report</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * Nightly intake QA: grade Leads + Intake calls (inbound and outbound) by handler.
 * Injury leads and other/non-PI calls use different scorecards. Skip short recordings.
 */
async function runIntakeGradingReport(opts = {}) {
  const recipients = firmCtx().intakeGradingEmailTo || [];
  if (opts.scheduled && !recipients.length) {
    console.log('  Intake grading: no recipients — skipping.');
    return;
  }

  const now = DateTime.now().setZone(TIMEZONE);
  const clock = firmStore.resolveClockTime(firmCtx().intakeGradingTime, '6:00 PM');
  const dayStart = now.startOf('day');
  const dayEnd = opts.scheduled
    ? dayStart.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 })
    : now;
  const createdAfter = dayStart.toUTC().toISO();
  const createdBefore = dayEnd.toUTC().toISO();
  const dayLabel = dayStart.toFormat('cccc, LLL d, yyyy');
  const windowNote = `${dayStart.toFormat('h:mm a')} – ${dayEnd.toFormat('h:mm a')} ${TIMEZONE}`;
  const leadsLines = firmCtx().statsLeadsInboxes;
  const lineSet = new Set(leadsLines.map((s) => String(s).trim().toLowerCase()));

  console.log(`\n${'═'.repeat(52)}`);
  console.log('  Intake Call Grading');
  console.log(`  ${dayLabel} · ${windowNote}`);
  console.log(`  Inboxes: ${leadsLines.join(', ') || 'none'}`);
  console.log('═'.repeat(52));

  if (!OPENAI_API_KEY) {
    console.log('  OPENAI_API_KEY is not set — cannot grade calls.');
    return;
  }

  console.log('\n[1/3] Fetching today\'s intake calls with transcripts...');
  const [{ callData }, userMap] = await Promise.all([
    runExport({
      apiKey: firmCtx().quoApiKey,
      phoneNumbersFilter: leadsLines.length ? leadsLines : firmCtx().quoPhoneNumbers,
      createdAfter,
      createdBefore,
      weeklyCommunications: true,
      includeMessages: false,
      fetchTranscriptForWeekly: true,
      skipWeeklyMonthlyExtra: true,
    }),
    fetchWorkspaceUserMap(firmCtx().quoApiKey).catch((err) => {
      console.warn(`  User map skipped: ${err.message}`);
      return {};
    }),
  ]);

  const excluded = { short: 0, unscored: 0, notNewLead: 0 };
  const staffNames = staffNamesForMatching(userMap);
  const candidates = [];
  for (const c of callData || []) {
    if (c.recordType === 'sms') continue;
    if (!isIntakeGradingLine(c.line, lineSet)) continue;
    if (c.aiHandled) {
      excluded.short += 1;
      continue;
    }
    const dur = Number(c.duration || 0);
    const tr = String(c.transcript || '').trim();
    if (!Number.isFinite(dur) || dur < INTAKE_GRADING_MIN_SECONDS || tr.length < INTAKE_GRADING_MIN_TRANSCRIPT_CHARS) {
      excluded.short += 1;
      continue;
    }
    const handler = resolveIntakeHandler(c, userMap, staffNames);
    candidates.push({
      ...c,
      handlerId: handler.handlerId,
      handlerName: handler.handlerName,
      handlerSource: handler.handlerSource,
      duration: dur,
    });
  }
  candidates.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  const toGrade = candidates.slice(0, INTAKE_GRADING_MAX_CALLS);
  if (candidates.length > toGrade.length) {
    console.warn(`  Capped at ${INTAKE_GRADING_MAX_CALLS} calls (${candidates.length} qualified).`);
  }
  const handlerCounts = {};
  let inboundN = 0;
  let outboundN = 0;
  for (const c of toGrade) {
    handlerCounts[c.handlerName] = (handlerCounts[c.handlerName] || 0) + 1;
    if (isIncomingDirection(c.direction)) inboundN += 1;
    else outboundN += 1;
  }
  console.log(`  ${toGrade.length} call(s) to grade · inbound ${inboundN} · outbound ${outboundN} · excluded too short/Sona: ${excluded.short}`);
  console.log(`  Handlers: ${Object.entries(handlerCounts).map(([n, k]) => `${n}=${k}`).join(' · ') || 'none'}`);

  console.log('\n[2/3] Grading with the RJL intake rubric (new leads only)...');
  const graded = [];
  for (let i = 0; i < toGrade.length; i++) {
    const call = toGrade[i];
    process.stdout.write(`  [${i + 1}/${toGrade.length}] ${call.handlerName} ${formatCallDuration(call.duration)} ... `);
    try {
      const grade = await gradeOneIntakeCall(call);
      if (!grade) {
        excluded.unscored += 1;
        console.log('parse-failed');
        continue;
      }
      const ct = intakeCallType(grade);
      if (!isScoreableNewLeadCallType(ct) || grade.grading_status === 'out_of_scope') {
        excluded.notNewLead += 1;
        console.log(`skip ${ct || grade.grading_status || 'not-new-lead'}`);
        continue;
      }
      if (grade.grading_status !== 'graded') {
        excluded.unscored += 1;
        console.log(grade.grading_status);
        continue;
      }
      graded.push({ ...call, grade });
      console.log(`${grade.overall_score} ${grade.score_band || ''} (${call.handlerSource || 'quo'})`);
    } catch (err) {
      excluded.unscored += 1;
      console.log(`error: ${err.message}`);
    }
  }

  const byUser = new Map();
  for (const r of graded) {
    if (!byUser.has(r.handlerName)) {
      byUser.set(r.handlerName, { name: r.handlerName, injury: [], other: [], flags: 0 });
    }
    const u = byUser.get(r.handlerName);
    const track = intakeGradeTrack(r.grade);
    (track === 'injury_lead' ? u.injury : u.other).push(r.grade.overall_score);
    u.flags += (r.grade.critical_flags || []).length;
  }
  const userSummaries = [...byUser.values()]
    .map((u) => {
      const injuryAvg = avgInts(u.injury);
      const otherAvg = avgInts(u.other);
      const headline = injuryAvg != null ? injuryAvg : otherAvg;
      return {
        name: u.name,
        graded: u.injury.length + u.other.length,
        injury: { n: u.injury.length, avg: injuryAvg },
        other: { n: u.other.length, avg: otherAvg },
        avg: headline,
        band: intakeGradingBand(headline),
        flags: u.flags,
      };
    })
    .sort((a, b) => (b.injury.avg ?? -1) - (a.injury.avg ?? -1) || (b.avg ?? -1) - (a.avg ?? -1) || b.graded - a.graded);

  console.log('\n[3/3] Handler averages:');
  for (const u of userSummaries) {
    console.log(
      `   - ${u.name}: injury ${u.injury.avg ?? '—'} (${u.injury.n}) · other ${u.other.avg ?? '—'} (${u.other.n}) · ${u.flags} flag(s)`
    );
  }

  const html = buildIntakeGradingEmailHtml(dayLabel, windowNote, userSummaries, graded, excluded, leadsLines);
  const plainLines = [
    `Intake Call Grading — ${dayLabel}`,
    windowNote,
    '',
    'Summary by person:',
    ...userSummaries.map(
      (u) =>
        `  ${u.name}: injury ${u.injury.avg ?? '—'} (${u.injury.n}) · other ${u.other.avg ?? '—'} (${u.other.n}) · ${u.flags} flags`
    ),
    '',
    'Graded calls:',
    ...graded.map((r) => {
      const track = intakeGradeTrack(r.grade);
      return `  [${track === 'injury_lead' ? 'injury' : 'other'}] ${r.handlerName} · ${r.grade.overall_score} ${r.grade.score_band || ''} · ${r.contact || r.phone} · ${r.link}`;
    }),
    '',
    `Excluded too short / no transcript / Sona: ${excluded.short}`,
    `Skipped existing client / known lead / not a new intake: ${excluded.notNewLead}`,
    `Out of scope or insufficient evidence: ${excluded.unscored}`,
  ];
  const csvLines = [
    ['handler', 'track', 'score', 'band', 'time', 'inbox', 'direction', 'contact', 'phone', 'duration_sec', 'flags', 'summary', 'quo_link'].join(','),
    ...graded.map((r) =>
      [
        r.handlerName,
        intakeGradeTrack(r.grade),
        r.grade.overall_score,
        r.grade.score_band || '',
        r.timestamp || '',
        r.line || '',
        r.direction || '',
        r.contact || '',
        r.phone || '',
        r.duration,
        (r.grade.critical_flags || []).length,
        String(r.grade.summary || '').replace(/"/g, '""'),
        r.link || '',
      ]
        .map((v) => `"${String(v == null ? '' : v)}"`)
        .join(',')
    ),
  ];
  const subject = `${firmCtx().firmName} — Intake Call Grading — ${dayLabel}`;

  if (!recipients.length || !EMAIL_CONFIGURED) {
    console.log('\n  Email not configured (set Intake grading recipients in admin) — printing report:\n');
    console.log(plainLines.join('\n'));
  } else {
    await sendEmail({
      htmlBody: html,
      plainText: plainLines.join('\n'),
      subject,
      to: recipients,
      attachments: [
        {
          filename: `intake-grading-${dayStart.toFormat('yyyy-LL-dd')}.csv`,
          content: csvLines.join('\n'),
        },
      ],
    });
    console.log(`\n  Sent intake grading to: ${recipients.join(', ')}`);
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log('Intake Call Grading complete.');
}

if (require.main === module) {
  const arg = process.argv[2];
  let run = runDailyReport;
  if (arg === '--weekly' || arg === 'weekly') run = runWeeklyClientSentimentReport;
  if (arg === '--monthly' || arg === 'monthly') run = runMonthlyNewsletterInsightsReport;
  if (
    arg === '--missed' ||
    arg === 'missed' ||
    arg === '--needs-response' ||
    arg === 'needs-response' ||
    arg === 'needs'
  ) {
    run = runMissedClientCallReport;
  }
  if (arg === '--review' || arg === 'review') run = runReviewIntelligenceReport;
  if (arg === '--language' || arg === 'language') run = runClientLanguageReport;
  if (arg === '--marketing' || arg === 'marketing') run = runIntakeMarketingReport;
  if (arg === '--callstats' || arg === 'callstats') run = runDailyCallStatsReport;
  if (arg === '--intake-grading' || arg === 'intake-grading' || arg === 'grading') run = runIntakeGradingReport;
  if (arg === '--clear-needs' || arg === 'clear-needs') {
    runNeedsResponseClearSweep().catch((err) => {
      console.error('\nError:', err.response?.data || err.message);
      process.exit(1);
    });
  } else {
    // Optional: `node report.js daily --firm <id>` scopes to one firm; otherwise all active firms.
    const firmFlag = process.argv.indexOf('--firm');
    const firmId = firmFlag !== -1 ? process.argv[firmFlag + 1] : undefined;
    const slotFlag = process.argv.indexOf('--slot');
    const slotFromFlag = slotFlag !== -1 ? process.argv[slotFlag + 1] : undefined;
    const slotFromPos = ['morning', 'midday', 'afternoon'].includes(process.argv[3]) ? process.argv[3] : undefined;
    const slot = slotFromFlag || slotFromPos;
    runForAllFirms(run, { ...(firmId ? { firmId } : {}), ...(slot ? { slot } : {}) }).catch((err) => {
      console.error('\nError:', err.response?.data || err.message);
      process.exit(1);
    });
  }
}

module.exports = {
  runDailyReport,
  runWeeklyClientSentimentReport,
  runMonthlyNewsletterInsightsReport,
  runMissedClientCallReport,
  runNeedsResponseClearSweep,
  clearNeedsResponseForTouch,
  runReviewIntelligenceReport,
  runClientLanguageReport,
  runIntakeMarketingReport,
  runDailyCallStatsReport,
  runIntakeGradingReport,
  aggregateCallStats,
  buildCallStatsEmailHtml,
  buildIntakeGradingEmailHtml,
  runForAllFirms,
};
