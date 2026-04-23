require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// ── Config (module-level defaults, overridable via runExport options) ─────────

const API_KEY = process.env.QUO_API_KEY;

const PHONE_NUMBERS_FILTER = process.env.QUO_PHONE_NUMBERS
  ? process.env.QUO_PHONE_NUMBERS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

/**
 * Extra line names / E.164 / PN ids merged into `QUO_PHONE_NUMBERS` for **weekly + monthly** only when that filter is set.
 * Default list: RJL Outbound (+15125005266) and RJL Transfers (+15126300907). Set `QUO_PHONE_NUMBERS_WEEKLY_MONTHLY_EXTRA=` (empty) to disable.
 */
function getWeeklyMonthlyPhoneExtraTokens() {
  const raw = process.env.QUO_PHONE_NUMBERS_WEEKLY_MONTHLY_EXTRA;
  if (raw === '') return [];
  if (raw === undefined) {
    return ['RJL Outbound', '+15125005266', 'RJL Transfers', '+15126300907'];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const CREATED_AFTER  = process.env.QUO_CREATED_AFTER?.trim()  || null;
const CREATED_BEFORE = process.env.QUO_CREATED_BEFORE?.trim() || null;
const MAX_RESULTS    = Math.min(Math.max(parseInt(process.env.QUO_MAX_RESULTS || '100', 10), 1), 100);
const OUTPUT_FILE    = 'quo_transcripts.csv';

const REQUEST_DELAY_MS = 120;

/** Total HTTP attempts per request (initial try + retries) for transient OpenPhone failures. */
const OPENPHONE_MAX_RETRIES = (() => {
  const n = parseInt(process.env.OPENPHONE_MAX_RETRIES || '5', 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(10, n);
})();

const OPENPHONE_RETRY_BASE_MS = (() => {
  const n = parseInt(process.env.OPENPHONE_RETRY_BASE_MS || '600', 10);
  if (!Number.isFinite(n) || n < 50) return 600;
  return Math.min(30_000, n);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shouldRetryOpenPhoneRequest(err) {
  const status = err?.response?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  if (status >= 400 && status < 500) return false;
  const code = err?.code || err?.cause?.code;
  if (
    typeof code === 'string' &&
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)
  ) {
    return true;
  }
  const msg = String(err?.message || '');
  if (/socket hang up|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

function makeClient(apiKey) {
  const client = axios.create({
    baseURL: 'https://api.openphone.com',
    headers: { Authorization: apiKey },
  });

  client.interceptors.response.use(
    (res) => res,
    async (err) => {
      const cfg = err.config;
      if (!cfg || cfg.signal?.aborted) return Promise.reject(err);

      const prev = Number(cfg.__openPhoneRetryCount || 0);
      if (prev >= OPENPHONE_MAX_RETRIES - 1 || !shouldRetryOpenPhoneRequest(err)) {
        return Promise.reject(err);
      }

      cfg.__openPhoneRetryCount = prev + 1;
      const backoff = OPENPHONE_RETRY_BASE_MS * 2 ** prev + Math.floor(Math.random() * 300);
      const path = cfg.url || '';
      console.warn(
        `[OpenPhone] ${err.code || err.response?.status || 'request failed'} ${path} — backoff ${backoff}ms (retry ${cfg.__openPhoneRetryCount}/${OPENPHONE_MAX_RETRIES - 1})`
      );
      await sleep(backoff);
      return client.request(cfg);
    }
  );

  return client;
}

function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '""')
    .trim();
}

function csvRow(fields) {
  return fields.map((f) => `"${cleanText(f)}"`).join(',');
}

/**
 * Canonical phone keys so contact `ph.value` matches call `participants`
 * (e.g. +15127973873 vs 5127973873 vs +1 512-797-3873).
 */
function phoneLookupKeys(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const digits = s.replace(/\D/g, '');
  const keys = new Set();
  keys.add(s);
  if (digits.length === 10) {
    keys.add(`+1${digits}`);
    keys.add(`1${digits}`);
    keys.add(digits);
  } else if (digits.length === 11 && digits.startsWith('1')) {
    keys.add(`+${digits}`);
    keys.add(digits);
    keys.add(digits.slice(1));
  } else if (digits.length > 0) {
    keys.add(`+${digits}`);
  }
  return [...keys];
}

function lookupContactName(contactMap, phone) {
  if (!phone) return '';
  for (const k of phoneLookupKeys(phone)) {
    const n = contactMap[k];
    if (n) return n;
  }
  return '';
}

// ── API functions ─────────────────────────────────────────────────────────────

async function listPhoneNumbers(client) {
  const res = await client.get('/v1/phone-numbers');
  return res.data.data || [];
}

function matchesFilter(pn, filters) {
  if (!filters?.length) return true;
  return filters.some(
    (f) =>
      pn.id === f ||
      pn.number === f ||
      pn.formattedNumber === f ||
      pn.name?.toLowerCase() === f.toLowerCase()
  );
}

/**
 * @param {object} cfg
 * @param {boolean} [cfg.listConversationsByActivity] - If true, use OpenPhone **updatedAfter** / **updatedBefore**
 *   (conversation last touched in the window). If false, use **createdAfter** / **createdBefore** (thread creation only).
 *   Weekly/monthly should use activity so long-running client threads with new calls are not dropped.
 */
async function fetchAllConversations(client, phoneNumberIds, cfg) {
  const conversations = [];
  let pageToken = null;
  let page = 0;

  do {
    page++;
    const params = { maxResults: cfg.maxResults };
    if (phoneNumberIds?.length)  params.phoneNumbers  = phoneNumberIds;
    if (cfg.listConversationsByActivity) {
      if (cfg.createdAfter)  params.updatedAfter  = cfg.createdAfter;
      if (cfg.createdBefore) params.updatedBefore = cfg.createdBefore;
    } else {
      if (cfg.createdAfter)  params.createdAfter  = cfg.createdAfter;
      if (cfg.createdBefore) params.createdBefore = cfg.createdBefore;
    }
    if (pageToken)               params.pageToken     = pageToken;

    const res = await client.get('/v1/conversations', { params });
    const batch = res.data.data || [];
    conversations.push(...batch);
    pageToken = res.data.nextPageToken || null;
    console.log(`  Conversations page ${page}: ${batch.length} (total: ${conversations.length})`);

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return conversations;
}

async function fetchCallsForConversation(client, phoneNumberId, participant, cfg) {
  const calls = [];
  let pageToken = null;

  do {
    const params = {
      phoneNumberId,
      participants: [participant],
      maxResults: cfg.maxResults,
    };
    if (cfg.createdAfter)  params.createdAfter  = cfg.createdAfter;
    if (cfg.createdBefore) params.createdBefore = cfg.createdBefore;
    if (pageToken)         params.pageToken     = pageToken;

    const res = await client.get('/v1/calls', { params });
    const batch = res.data.data || [];
    calls.push(...batch);
    pageToken = res.data.nextPageToken || null;

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return calls;
}

/** SMS / MMS in the same date window as calls (Quo / OpenPhone Messages API). */
async function fetchMessagesForConversation(client, phoneNumberId, participant, cfg) {
  const messages = [];
  let pageToken = null;

  do {
    const params = {
      phoneNumberId,
      participants: [participant],
      maxResults: cfg.maxResults,
    };
    if (cfg.createdAfter) params.createdAfter = cfg.createdAfter;
    if (cfg.createdBefore) params.createdBefore = cfg.createdBefore;
    if (pageToken) params.pageToken = pageToken;

    const res = await client.get('/v1/messages', { params });
    const batch = res.data.data || [];
    messages.push(...batch);
    pageToken = res.data.nextPageToken || null;

    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  return messages;
}

async function fetchTranscript(client, callId) {
  try {
    const res = await client.get(`/v1/call-transcripts/${callId}`);
    const data = res.data?.data;
    if (!data) return null;
    if (data.status === 'absent' || data.status === 'failed') return null;

    const dialogue = data.dialogue;
    if (!Array.isArray(dialogue) || dialogue.length === 0) return null;

    return dialogue.map((seg) => seg.content || '').filter(Boolean).join(' ');
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) return null;
    throw err;
  }
}

async function fetchSummary(client, callId) {
  try {
    const res = await client.get(`/v1/call-summaries/${callId}`);
    const data = res.data?.data;
    if (!data) return '';
    if (data.status === 'absent' || data.status === 'failed') return '';

    const summary = data.summary;
    if (!summary) return '';
    if (Array.isArray(summary)) return summary.join(' ');
    return String(summary);
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) return '';
    throw err;
  }
}

async function buildContactMap(client) {
  const map = {};
  let pageToken = null;
  let total = 0;
  let contactsWithPhone = 0;

  do {
    const params = { maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;

    const res = await client.get('/v1/contacts', { params });
    const batch = res.data.data || [];
    total += batch.length;

    for (const c of batch) {
      const df = c.defaultFields || {};
      const name = [df.firstName, df.lastName].filter(Boolean).join(' ') || df.company || '';
      if (!name) continue;
      const phs = df.phoneNumbers || [];
      if (!phs.some((p) => p.value)) continue;
      contactsWithPhone++;
      for (const ph of phs) {
        if (!ph.value) continue;
        for (const k of phoneLookupKeys(ph.value)) {
          map[k] = name;
        }
      }
    }

    pageToken = res.data.nextPageToken || null;
    if (pageToken) await sleep(REQUEST_DELAY_MS);
  } while (pageToken);

  console.log(`Loaded ${total} contacts (${contactsWithPhone} with phone numbers).`);
  return map;
}

function extractInlineTranscript(call) {
  if (call.transcript && typeof call.transcript === 'string') return call.transcript;
  for (const messages of [call.messages, call.conversation?.messages]) {
    if (Array.isArray(messages) && messages.length > 0) {
      const text = messages.map((m) => m.text || m.content || m.body || '').filter(Boolean).join(' ');
      if (text) return text;
    }
  }
  return null;
}

function getExternalPhone(call, ownNumber) {
  const participants = call.participants || [];
  return participants.find((p) => p !== ownNumber) || participants[0] || '';
}

// ── Core export function ──────────────────────────────────────────────────────

/**
 * Fetches calls and returns structured data + CSV lines.
 * Can be called programmatically with options, or via main() from the CLI.
 *
 * @param {object} options
 * @param {string}   [options.apiKey]             - override QUO_API_KEY
 * @param {string[]} [options.phoneNumbersFilter] - override QUO_PHONE_NUMBERS
 * @param {string}   [options.createdAfter]        - override QUO_CREATED_AFTER
 * @param {string}   [options.createdBefore]       - override QUO_CREATED_BEFORE
 * @param {number}   [options.maxResults]          - override QUO_MAX_RESULTS
 * @param {boolean}  [options.weeklyCommunications] - include every call (missed/Sona/etc.) + optional SMS; sentiment uses summaries, not full transcripts
 * @param {boolean}  [options.monthlyNewsletter]   - monthly theme extraction: keep calls with summary and/or transcript; skip transcript API unless fetchTranscriptForMonthly
 * @param {boolean}  [options.includeMessages]     - with weeklyCommunications, also pull /v1/messages for each conversation
 * @param {boolean}  [options.fetchTranscriptForWeekly] - if false (default), skip GET call-transcripts in weekly mode (summary + metadata only)
 * @param {boolean}  [options.fetchTranscriptForMonthly] - if true, also GET call-transcripts in monthly mode (default false = summary-first)
 * @returns {{ csvLines: string[], callData: object[], totalFetched: number, totalSaved: number }}
 */
async function runExport(options = {}) {
  const apiKey      = options.apiKey            ?? API_KEY;
  let pnFilter      = options.phoneNumbersFilter ?? PHONE_NUMBERS_FILTER;
  const weeklyComm  = Boolean(options.weeklyCommunications);
  const monthlyComm = Boolean(options.monthlyNewsletter);
  const includeMsgs = Boolean(options.includeMessages);
  const fetchWeeklyTranscripts = options.fetchTranscriptForWeekly === true;
  const fetchMonthlyTranscripts = options.fetchTranscriptForMonthly === true;
  const defaultExport = !weeklyComm && !monthlyComm;
  const cfg = {
    createdAfter:  options.createdAfter  ?? CREATED_AFTER,
    createdBefore: options.createdBefore ?? CREATED_BEFORE,
    maxResults:    options.maxResults    ?? MAX_RESULTS,
    /** See fetchAllConversations — avoids missing numbers whose Quo thread predates the report window. */
    listConversationsByActivity: weeklyComm || monthlyComm,
  };

  if (!apiKey) throw new Error('QUO_API_KEY is not set.');

  const client = makeClient(apiKey);

  // Weekly/monthly: always include outbound + transfer lines when a subset filter is used (daily unchanged).
  if ((weeklyComm || monthlyComm) && pnFilter?.length) {
    const extra = getWeeklyMonthlyPhoneExtraTokens();
    if (extra.length) {
      pnFilter = [...new Set([...pnFilter, ...extra])];
    }
  }

  // Resolve phone numbers
  let phoneNumbers = await listPhoneNumbers(client);

  if (pnFilter) {
    phoneNumbers = phoneNumbers.filter((pn) => matchesFilter(pn, pnFilter));
    if (phoneNumbers.length === 0) {
      throw new Error(`None of the specified QUO_PHONE_NUMBERS were found in the workspace.`);
    }
  }

  if (phoneNumbers.length === 0) throw new Error('No phone numbers found in the workspace.');

  const phoneNumberIds = phoneNumbers.map((pn) => pn.id);
  const phoneNumberMap = Object.fromEntries(
    phoneNumbers.map((pn) => [pn.id, { number: pn.number || pn.formattedNumber || '', name: pn.name || '' }])
  );

  console.log(
    `Processing ${phoneNumbers.length} line(s): ` +
    phoneNumbers.map((pn) => `${pn.name || pn.number} (${pn.number})`).join(', ')
  );

  // Load contacts
  console.log('\nLoading contacts...');
  let contactMap = {};
  try {
    contactMap = await buildContactMap(client);
  } catch (err) {
    console.warn('Could not load contacts:', err.response?.data?.message || err.message);
  }

  // Fetch conversations
  console.log('\nFetching all conversations...');
  const conversations = await fetchAllConversations(client, phoneNumberIds, cfg);
  console.log(`Found ${conversations.length} conversation(s) total.\n`);

  // Iterate conversations → calls → (transcripts + summaries); optional SMS for weekly sentiment
  const csvLines = [csvRow(['timestamp', 'line', 'phone', 'contact', 'duration', 'summary', 'transcript', 'link'])];
  const callData = [];
  let totalFetched = 0;
  let totalSaved = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const lineInfo  = phoneNumberMap[conv.phoneNumberId] || {};
    const ownNumber = lineInfo.number || '';
    const lineName  = lineInfo.name || ownNumber;
    const participant = (conv.participants || []).find((p) => p !== ownNumber);

    if (!participant) continue;

    process.stdout.write(`[${i + 1}/${conversations.length}] ${participant} ... `);

    let calls;
    try {
      calls = await fetchCallsForConversation(client, conv.phoneNumberId, participant, cfg);
    } catch (err) {
      console.log(`error: ${err.response?.data?.message || err.message}`);
      continue;
    }

    await sleep(REQUEST_DELAY_MS);
    totalFetched += calls.length;
    let savedThisConv = 0;

    for (const call of calls) {
      let transcript = extractInlineTranscript(call);

      if (defaultExport) {
        if (!transcript) transcript = await fetchTranscript(client, call.id);
        if (!transcript || transcript.trim() === '') continue;
      } else if (weeklyComm) {
        if (fetchWeeklyTranscripts && (!transcript || !transcript.trim())) {
          transcript = await fetchTranscript(client, call.id);
        }
        if (!transcript || typeof transcript !== 'string') transcript = '';
      } else {
        if (fetchMonthlyTranscripts && (!transcript || !transcript.trim())) {
          transcript = await fetchTranscript(client, call.id);
        }
        if (!transcript || typeof transcript !== 'string') transcript = '';
      }

      const summary = await fetchSummary(client, call.id);

      if (monthlyComm) {
        const sumT = String(summary || '').trim();
        const trT = String(transcript || '').trim();
        if (!sumT && !trT) continue;
      }

      const timestamp = call.answeredAt || call.createdAt || '';
      const phone     = getExternalPhone(call, ownNumber);
      const contact   = lookupContactName(contactMap, phone);
      const duration  = call.duration ?? '';
      const link      = `https://my.openphone.com/inbox/${conv.phoneNumberId}/c/${conv.id}?at=${call.id}`;

      const baseRow = {
        recordType: 'call',
        timestamp,
        line: lineName,
        phone,
        contact,
        duration,
        summary,
        transcript,
        link,
        status: call.status,
        direction: call.direction,
        aiHandled: call.aiHandled || null,
      };

      if (defaultExport) {
        csvLines.push(csvRow([timestamp, lineName, phone, contact, duration, summary, transcript, link]));
        callData.push(baseRow);
        totalSaved++;
        savedThisConv++;
      } else if (monthlyComm) {
        csvLines.push(
          csvRow([
            timestamp,
            lineName,
            phone,
            contact,
            duration,
            summary,
            transcript || '(no transcript — monthly uses summary)',
            link,
          ])
        );
        callData.push(baseRow);
        totalSaved++;
        savedThisConv++;
      } else {
        csvLines.push(
          csvRow([
            timestamp,
            lineName,
            phone,
            contact,
            duration,
            summary,
            transcript || '(no transcript — weekly bundle)',
            link,
          ])
        );
        callData.push(baseRow);
        totalSaved++;
        savedThisConv++;
      }

      await sleep(REQUEST_DELAY_MS);
    }

    if (weeklyComm && includeMsgs) {
      let msgs = [];
      try {
        msgs = await fetchMessagesForConversation(client, conv.phoneNumberId, participant, cfg);
      } catch (err) {
        console.log(`messages error: ${err.response?.data?.message || err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
      const phone = participant;
      const contact = lookupContactName(contactMap, phone);
      const convLink = `https://my.openphone.com/inbox/${conv.phoneNumberId}/c/${conv.id}`;
      for (const msg of msgs) {
        const body =
          msg.text ||
          msg.message ||
          msg.body ||
          (Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join(' ') : '') ||
          '';
        const ts = msg.createdAt || msg.updatedAt || '';
        callData.push({
          recordType: 'sms',
          timestamp: ts,
          line: lineName,
          phone,
          contact,
          duration: '',
          summary: '',
          transcript: '',
          body: String(body).trim(),
          direction: msg.direction || '',
          link: convLink,
          status: 'message',
        });
        totalSaved++;
        savedThisConv++;
      }
    }

    console.log(
      `${calls.length} calls, ${savedThisConv} row${savedThisConv === 1 ? '' : 's'}${
        weeklyComm ? ' (weekly mode)' : monthlyComm ? ' (monthly summary mode)' : ''
      }`
    );
  }

  return { csvLines, callData, totalFetched, totalSaved };
}

// ── Standalone CLI entry point ─────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('Error: QUO_API_KEY is not set. Copy .env.example to .env and add your key.');
    process.exit(1);
  }

  try {
    const { csvLines, totalFetched, totalSaved } = await runExport();
    fs.writeFileSync(OUTPUT_FILE, csvLines.join('\n'), 'utf8');
    console.log('\n════════════════════════════════');
    console.log(`Total calls fetched:     ${totalFetched}`);
    console.log(`Total transcripts saved: ${totalSaved}`);
    console.log(`Output file:             ${OUTPUT_FILE}`);
  } catch (err) {
    console.error('\nError:', err.response?.data || err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { runExport };
