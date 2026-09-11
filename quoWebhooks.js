const crypto = require('crypto');
const axios = require('axios');
const pg = require('./pgStore');

const CALL_EVENTS = new Set([
  'call.completed',
  'call.answered',
  'call.missed',
  'call.forwarded',
]);
const MESSAGE_EVENTS = new Set(['message.delivered', 'message.received']);
/** Events the current Quo Settings → Webhooks UI actually offers. */
const V1_CALL_EVENTS = ['call.completed'];
const V1_MESSAGE_EVENTS = ['message.delivered', 'message.received'];

function headerValue(headers, name) {
  const v = headers[name] || headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function allowUnsigned() {
  return /^(1|true|yes)$/i.test(String(process.env.QUO_WEBHOOK_ALLOW_UNSIGNED || ''));
}

function envSigningKeys() {
  return String(process.env.QUO_WEBHOOK_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Newer Quo API: HMAC-SHA256 over `{id}.{timestamp}.{rawBody}` (whsec_ key). */
function svixSignatureValid(rawBody, headers, secret) {
  if (!secret) return false;
  const webhookId = headerValue(headers, 'webhook-id');
  const webhookTimestamp = headerValue(headers, 'webhook-timestamp');
  const webhookSignature = headerValue(headers, 'webhook-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  const ts = Number(webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;
  const secretBase64 = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  const secretBytes = Buffer.from(secretBase64, 'base64');
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const provided = String(webhookSignature)
    .split(' ')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [version, signature] = entry.split(',');
      return version === 'v1' ? signature : null;
    })
    .filter(Boolean);
  return provided.some((sig) => {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/**
 * Current Quo Settings UI (legacy OpenPhone):
 * `openphone-signature: hmac;1;<timestamp>;<base64 hmac>`
 * signed data = `${timestamp}.${rawBody}`, key = base64-decoded signing secret.
 */
function openPhoneSignatureValid(rawBody, headers, secret) {
  if (!secret) return false;
  const header = headerValue(headers, 'openphone-signature');
  if (!header) return false;
  const parts = String(header).split(';');
  if (parts.length < 4) return false;
  const timestamp = parts[2];
  const signature = parts.slice(3).join(';');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Header timestamp is often milliseconds.
  const ageSec = Math.abs(Date.now() - (ts > 1e12 ? ts : ts * 1000)) / 1000;
  if (ageSec > 5 * 60) return false;
  const keyBytes = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const signedData = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', keyBytes).update(signedData).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signatureValid(rawBody, headers, secret) {
  return svixSignatureValid(rawBody, headers, secret) || openPhoneSignatureValid(rawBody, headers, secret);
}

async function verifyDelivery(rawBody, headers) {
  const keys = [...envSigningKeys()];
  if (pg.isEnabled()) {
    try {
      keys.push(...(await pg.listWebhookSigningKeys()));
    } catch {
      /* schema may not be ready yet */
    }
  }
  const unique = [...new Set(keys)];
  if (!unique.length) {
    if (allowUnsigned()) return { ok: true, unsigned: true };
    return { ok: false, reason: 'no webhook signing key (set QUO_WEBHOOK_KEY or let the app create the subscription)' };
  }
  if (unique.some((k) => signatureValid(rawBody, headers, k))) return { ok: true };
  if (allowUnsigned()) return { ok: true, unsigned: true };
  return { ok: false, reason: 'invalid webhook signature' };
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/** Normalize 2026-03-30 envelope and older OpenPhone `{ type, data.object }` payloads. */
function normalizeEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const type = body.type || body.eventType || body.event || '';
  const data = body.data || {};
  const resource = data.resource || data.object || body.object || {};
  const context = data.context || {};
  const participants = resource.participants || context.participants || {};
  const workspace = Array.isArray(participants.workspace)
    ? participants.workspace
    : Array.isArray(participants)
      ? participants
      : [];
  const external = Array.isArray(participants.external) ? participants.external : [];
  return {
    deliveryId: body.id || null,
    type: String(type),
    resource,
    context,
    workspace,
    external,
    raw: body,
  };
}

function inferCallStatus(r, eventType, direction) {
  const raw = String(r.status || '').toLowerCase();
  if (eventType === 'call.missed') return 'missed';
  if (eventType === 'call.forwarded' || raw.includes('forward') || r.forwardedTo) {
    if (direction === 'incoming' && !r.answeredAt && r.forwardedTo) return 'forwarded';
    if (raw.includes('forward')) return 'forwarded';
  }
  if (raw === 'ai-handled' || r.aiHandled === 'ai-agent') return 'ai-handled';
  if (direction === 'incoming') {
    if (r.answeredAt) return raw === 'answered' ? 'answered' : raw || 'answered';
    if (r.voicemail || r.hasVoicemail) return 'voicemail';
    if (!raw || raw === 'completed' || raw === 'no-answer' || raw === 'unanswered') return 'missed';
  }
  return raw || 'completed';
}

function mapCallRow(evt) {
  const r = evt.resource || {};
  const c = evt.context || {};
  const direction = r.direction || (evt.type === 'call.forwarded' ? 'incoming' : '');
  const inbound = /^(incoming|inbound)$/i.test(direction);
  const external = evt.external.length
    ? evt.external
    : [inbound ? r.from : r.to].filter(Boolean);
  const workspace = evt.workspace.length
    ? evt.workspace
    : [inbound ? r.to : r.from].filter(Boolean);
  return {
    call_id: r.id || r.callId || c.activityId,
    phone_number_id: c.phoneNumberId || r.phoneNumberId || '',
    org_id: c.orgId,
    conversation_id: c.conversationId || r.conversationId,
    direction,
    status: inferCallStatus(r, evt.type, direction),
    user_id: c.userId || r.userId,
    answered_by: r.answeredByUserId || r.answeredBy || null,
    initiated_by: r.initiatedBy || null,
    duration_sec: r.duration == null ? null : r.duration,
    created_at: r.createdAt,
    answered_at: r.answeredAt,
    completed_at: r.completedAt,
    forwarded_from: r.forwardedFrom,
    forwarded_to: r.forwardedTo,
    ai_handled: String(r.status || '').toLowerCase() === 'ai-handled' || Boolean(r.aiHandled) || r.aiHandled === 'ai-agent',
    has_voicemail: Boolean(r.hasVoicemail || r.voicemail),
    participants: { workspace, external, from: r.from || null, to: r.to || null },
    last_event_type: evt.type,
    payload_json: evt.raw,
  };
}

function mapMessageRow(evt) {
  const r = evt.resource || {};
  const c = evt.context || {};
  return {
    message_id: r.id,
    phone_number_id: c.phoneNumberId || r.phoneNumberId,
    direction: r.direction,
    status: r.status,
    user_id: c.userId || r.userId,
    created_at: r.createdAt,
    payload_json: evt.raw,
  };
}

async function persistEvent(evt) {
  if (!evt?.type) return { stored: false, reason: 'no event type' };
  if (CALL_EVENTS.has(evt.type)) {
    const row = mapCallRow(evt);
    if (!row.call_id) return { stored: false, reason: 'call event missing id' };
    await pg.upsertQuoCall(row);
    return { stored: true, kind: 'call', callId: row.call_id, status: row.status };
  }
  if (MESSAGE_EVENTS.has(evt.type)) {
    const row = mapMessageRow(evt);
    if (!row.message_id) return { stored: false, reason: 'message event missing id' };
    await pg.upsertQuoMessage(row);
    return { stored: true, kind: 'message', messageId: row.message_id };
  }
  return { stored: false, reason: `ignored ${evt.type}` };
}

async function handleRawDelivery(rawBody, headers) {
  if (!pg.isEnabled()) {
    return { status: 503, body: { error: 'DATABASE_URL is not set — webhook ledger needs Railway Postgres' } };
  }
  const verified = await verifyDelivery(rawBody, headers);
  if (!verified.ok) return { status: 401, body: { error: verified.reason } };

  let parsed;
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    return { status: 400, body: { error: 'bad json' } };
  }

  const evt = normalizeEvent(parsed);
  const deliveryId = headerValue(headers, 'webhook-id') || evt?.deliveryId;
  if (deliveryId) {
    const fresh = await pg.recordWebhookDelivery(deliveryId, evt?.type || '');
    if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  }

  const result = await persistEvent(evt);
  if (result.stored) {
    console.log(
      `[quo webhook] ${evt.type} ${result.kind === 'call' ? result.callId : result.messageId}` +
        (result.status ? ` ${result.status}` : '')
    );
  } else if (result.reason && !String(result.reason).startsWith('ignored')) {
    console.warn(`[quo webhook] ${result.reason}`);
  }
  return { status: 200, body: { ok: true, ...result } };
}

function publicWebhookUrl() {
  const explicit = String(process.env.QUO_WEBHOOK_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//, '');
  if (host) return `https://${host}/webhooks/quo`;
  return '';
}

function openPhoneClient(apiKey) {
  return axios.create({
    baseURL: 'https://api.openphone.com',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

/**
 * Create (or reuse) a Quo webhook pointed at this Railway service.
 * The signing key is stored in Postgres; copy it to QUO_WEBHOOK_KEY if you want
 * verification to work before the next process restart.
 */
async function ensureRegistered(apiKey) {
  const url = publicWebhookUrl();
  if (!url) {
    console.log('  Quo webhook: no public URL (set QUO_WEBHOOK_URL or RAILWAY_PUBLIC_DOMAIN) — skipping subscribe.');
    return null;
  }
  if (!pg.isEnabled()) {
    console.log('  Quo webhook: DATABASE_URL not set — endpoint will 503 until Postgres is attached.');
    return null;
  }
  if (!apiKey) {
    console.log('  Quo webhook: no API key — create the subscription in Quo (url: ' + url + ').');
    return null;
  }

  await pg.ensureSchema();
  const existing = await pg.findWebhookEndpointByUrl(url);
  if (existing) {
    console.log(`  Quo webhook: already subscribed → ${url} (${existing.id})`);
    return existing;
  }

  const client = openPhoneClient(apiKey);
  const created = [];
  for (const [path, events] of [
    ['/v1/webhooks/calls', V1_CALL_EVENTS],
    ['/v1/webhooks/messages', V1_MESSAGE_EVENTS],
  ]) {
    try {
      const listed = await client.get(path);
      const hooks = listed.data?.data || listed.data || [];
      const match = (Array.isArray(hooks) ? hooks : []).find((h) => h.url === url || h.url === `${url}/`);
      if (match) {
        await pg.saveWebhookEndpoint({
          id: match.id,
          url,
          signing_key: match.key || match.signingKey || '',
          events: (match.events || events).join(','),
        });
        console.log(`  Quo webhook: found ${path} ${match.id} → ${url}`);
        created.push(match);
        continue;
      }
    } catch (err) {
      console.warn(`  Quo webhook: list ${path} failed (${err.response?.data?.message || err.message})`);
    }
    try {
      const res = await client.post(path, { url, events, resourceIds: ['*'] });
      const hook = res.data?.data || res.data;
      await pg.saveWebhookEndpoint({
        id: hook.id,
        url,
        signing_key: hook.key || hook.signingKey || '',
        events: events.join(','),
      });
      console.log(`  Quo webhook: created ${path} ${hook.id} → ${url}`);
      if (hook.key || hook.signingKey) {
        console.log(`  Quo webhook: store signing key as QUO_WEBHOOK_KEY: ${hook.key || hook.signingKey}`);
      }
      created.push(hook);
    } catch (err) {
      console.warn(`  Quo webhook: create ${path} failed: ${err.response?.status} ${JSON.stringify(err.response?.data) || err.message}`);
    }
  }
  if (!created.length) {
    console.log(`  Quo webhook: create it in Quo Settings → Webhooks → ${url}`);
    console.log('  Check: call.completed, message.delivered, message.received. Then Reveal signing secret → QUO_WEBHOOK_KEY.');
  }
  return created[0] || null;
}

module.exports = {
  handleRawDelivery,
  ensureRegistered,
  publicWebhookUrl,
  verifyDelivery,
  persistEvent,
  normalizeEvent,
};
