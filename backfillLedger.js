/**
 * Hydrate quo_calls + quo_messages from the Quo API starting July 1, 2026
 * (America/Chicago). Lists conversations touched since that date, then fetches
 * each (line × counterparty) pair — OpenPhone requires both phoneNumberId and
 * participants on /v1/calls and /v1/messages.
 *
 * When Case Tracker Supabase env is present, only client phones are fetched.
 *
 * Usage:
 *   railway run -- node backfillLedger.js
 *
 * Env:
 *   LEDGER_BACKFILL_SINCE=2026-07-01T05:00:00.000Z
 *   LEDGER_BACKFILL_CALLS_ONLY=1
 */
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const pg = require('./pgStore');

const SINCE = process.env.LEDGER_BACKFILL_SINCE?.trim() || '2026-07-01T05:00:00.000Z';
const CALLS_ONLY = /^(1|true|yes)$/i.test(process.env.LEDGER_BACKFILL_CALLS_ONLY || '');
const MAX_RESULTS = 100;
const REQUEST_DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(apiKey) {
  return axios.create({
    baseURL: 'https://api.openphone.com',
    headers: { Authorization: apiKey },
    paramsSerializer: { indexes: null },
  });
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw || '').trim().startsWith('+') && digits.length >= 10) return `+${digits}`;
  return '';
}

function samePhone(a, b) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return Boolean(left && right && left === right);
}

function counterparties(participants, ownNumber) {
  const all = (Array.isArray(participants) ? participants : []).map(normalizePhone).filter(Boolean);
  const others = all.filter((p) => !samePhone(p, ownNumber));
  return [...new Set(others.length ? others : all)];
}

async function getWithRetry(client, path, params, attempt = 0) {
  try {
    await sleep(REQUEST_DELAY_MS);
    return await client.get(path, { params });
  } catch (err) {
    const status = err.response?.status;
    const retryAfter = Number(err.response?.headers?.['retry-after'] || 0);
    const msg = String(err.response?.data?.message || err.message || '');
    if ((status === 429 || /rate limit/i.test(msg)) && attempt < 10) {
      const waitMs = Math.max(retryAfter * 1000, 2500 * (attempt + 1));
      console.warn(`  rate limit · waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      return getWithRetry(client, path, params, attempt + 1);
    }
    throw err;
  }
}

async function listPhoneNumbers(client) {
  const out = [];
  let pageToken = null;
  do {
    const params = { maxResults: MAX_RESULTS };
    if (pageToken) params.pageToken = pageToken;
    const res = await getWithRetry(client, '/v1/phone-numbers', params);
    out.push(...(res.data.data || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function fetchAllConversations(client, createdAfter) {
  const conversations = [];
  let pageToken = null;
  let page = 0;
  do {
    page += 1;
    const params = { maxResults: MAX_RESULTS, updatedAfter: createdAfter };
    if (pageToken) params.pageToken = pageToken;
    const res = await getWithRetry(client, '/v1/conversations', params);
    const batch = res.data.data || [];
    conversations.push(...batch);
    pageToken = res.data.nextPageToken || null;
    console.log(`  conversations page ${page}: ${batch.length} (total ${conversations.length})`);
  } while (pageToken);
  return conversations;
}

async function fetchPagedPair(client, path, phoneNumberId, participant, createdAfter) {
  const rows = [];
  let pageToken = null;
  do {
    const params = {
      phoneNumberId,
      participants: [participant],
      maxResults: MAX_RESULTS,
      createdAfter,
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await getWithRetry(client, path, params);
    rows.push(...(res.data.data || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return rows;
}

async function loadCaseTrackerPhones() {
  const url = (
    process.env.CASE_TRACKER_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  ).trim();
  const key = (
    process.env.CASE_TRACKER_SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();
  if (!url || !key || /SENSITIVE/i.test(url) || /SENSITIVE/i.test(key)) {
    return [];
  }

  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const phones = new Set();

  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('case_tracker_entries')
      .select('client_phone')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = data || [];
    for (const row of page) {
      const phone = normalizePhone(row.client_phone);
      if (phone) phones.add(phone);
    }
    if (page.length < 1000) break;
    from += page.length;
  }

  from = 0;
  for (;;) {
    const { data, error } = await admin.from('case_quo_contacts').select('phone').range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = data || [];
    for (const row of page) {
      const phone = normalizePhone(row.phone);
      if (phone) phones.add(phone);
    }
    if (page.length < 1000) break;
    from += page.length;
  }

  return phones;
}

function callToRow(call, phoneNumberId) {
  const participants = Array.isArray(call.participants) ? call.participants.filter(Boolean) : [];
  return {
    call_id: call.id,
    phone_number_id: phoneNumberId || call.phoneNumberId || '',
    org_id: call.orgId || null,
    conversation_id: call.conversationId || null,
    direction: call.direction || '',
    status: call.status || '',
    user_id: call.userId || null,
    answered_by: call.answeredBy || null,
    initiated_by: call.initiatedBy || null,
    duration_sec: call.duration == null ? null : Number(call.duration),
    created_at: call.createdAt || null,
    answered_at: call.answeredAt || null,
    completed_at: call.completedAt || null,
    forwarded_from: call.forwardedFrom || null,
    forwarded_to: call.forwardedTo || null,
    ai_handled: Boolean(call.aiHandled) || String(call.status || '').toLowerCase() === 'ai-handled',
    has_voicemail: Boolean(call.hasVoicemail || call.voicemail),
    participants: {
      workspace: participants,
      external: [],
      from: call.from || null,
      to: call.to || null,
    },
    last_event_type: 'ledger_backfill',
    payload_json: { data: { object: call } },
  };
}

function messageToRow(message, phoneNumberId) {
  return {
    message_id: message.id,
    phone_number_id: phoneNumberId || message.phoneNumberId || '',
    direction: message.direction || '',
    status: message.status || '',
    user_id: message.userId || null,
    created_at: message.createdAt || null,
    payload_json: { data: { object: message } },
  };
}

async function main() {
  const apiKey = process.env.QUO_API_KEY?.trim();
  if (!apiKey) throw new Error('QUO_API_KEY is required');
  if (!pg.isEnabled()) throw new Error('DATABASE_URL is required');

  await pg.ensureSchema();
  console.log(`Ledger backfill since ${SINCE}`);

  const client = makeClient(apiKey);
  const lines = await listPhoneNumbers(client);
  const numberMap = Object.fromEntries(
    lines.map((pn) => [pn.id, pn.number || pn.formattedNumber || ''])
  );
  console.log(`  lines: ${lines.length}`);

  let clientPhones = new Set();
  try {
    clientPhones = await loadCaseTrackerPhones();
  } catch (err) {
    console.warn(`  Case Tracker phones unavailable: ${err.message}`);
  }
  if (clientPhones.size) {
    console.log(`  filtering to ${clientPhones.size} Case Tracker client phones`);
  } else {
    console.log('  no Case Tracker phone filter — fetching every conversation pair');
  }

  const conversations = await fetchAllConversations(client, SINCE);
  const pairs = [];
  const pairKeys = new Set();
  for (const conv of conversations) {
    const phoneNumberId = conv.phoneNumberId;
    if (!phoneNumberId || !numberMap[phoneNumberId]) continue;
    const others = counterparties(conv.participants, numberMap[phoneNumberId]);
    for (const participant of others) {
      if (clientPhones.size && !clientPhones.has(participant)) continue;
      const key = `${phoneNumberId}|${participant}`;
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push({ phoneNumberId, participant });
    }
  }
  console.log(`  pairs to fetch: ${pairs.length}`);

  let callsUpserted = 0;
  let messagesUpserted = 0;
  let pairErrors = 0;

  for (let i = 0; i < pairs.length; i += 1) {
    const { phoneNumberId, participant } = pairs[i];
    if (i % 25 === 0 || i === pairs.length - 1) {
      console.log(
        `  pair ${i + 1}/${pairs.length} · calls ${callsUpserted} · texts ${messagesUpserted} · errors ${pairErrors}`
      );
    }
    try {
      const calls = await fetchPagedPair(client, '/v1/calls', phoneNumberId, participant, SINCE);
      for (const call of calls) {
        if (await pg.upsertQuoCall(callToRow(call, phoneNumberId))) callsUpserted += 1;
      }
      if (!CALLS_ONLY) {
        const messages = await fetchPagedPair(
          client,
          '/v1/messages',
          phoneNumberId,
          participant,
          SINCE
        );
        for (const message of messages) {
          if (await pg.upsertQuoMessage(messageToRow(message, phoneNumberId))) {
            messagesUpserted += 1;
          }
        }
      }
    } catch (err) {
      pairErrors += 1;
      console.warn(
        `  failed ${numberMap[phoneNumberId] || phoneNumberId} × ${participant}: ${
          err.response?.data?.message || err.message
        }`
      );
    }
  }

  const totalCalls = await pg.countQuoCalls();
  console.log(
    JSON.stringify({
      ok: true,
      since: SINCE,
      conversations: conversations.length,
      pairs: pairs.length,
      pairErrors,
      callsUpserted,
      messagesUpserted,
      quo_calls_total: totalCalls,
    })
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
