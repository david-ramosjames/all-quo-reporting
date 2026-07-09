const crypto = require('crypto');
const reviewRequests = require('./reviewRequests');
const firmStore = require('./firmStore');
const quoSend = require('./quoSend');
const { postSlackMessage } = require('./slack');

/**
 * Slack Events API handler for the approval-to-send workflow.
 *
 * Review Intelligence posts one Slack message per review candidate. When a staff
 * member reacts with ✅ (REVIEW_APPROVE_EMOJI) or replies "approve" in the
 * thread, Slack pushes the event here; we map the message back to its
 * review_request and text the client their link via Quo — once (idempotent).
 *
 * Requires SLACK_SIGNING_SECRET (to verify requests) and SLACK_BOT_TOKEN.
 * Slack app setup: enable Event Subscriptions → request URL /slack/events,
 * subscribe to `reaction_added` and `message.channels`, scopes
 * `reactions:read` + `channels:history` (+ `chat:write`), then reinstall.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const APPROVE_EMOJI = (process.env.REVIEW_APPROVE_EMOJI || 'white_check_mark').replace(/:/g, '').trim();
const APPROVE_TEXT_RE = /\b(approve|approved|send it|send|yes|do it)\b/i;

function isEnabled() {
  return Boolean(SLACK_BOT_TOKEN && SIGNING_SECRET);
}

/** Verify Slack's v0 request signature over the raw body. */
function verifySignature(rawBody, timestamp, signature) {
  if (!SIGNING_SECRET || !timestamp || !signature) return false;
  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex');
  const a = Buffer.from(mine);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function reviewPublicBase(firm) {
  const dom = firm && firm.review_domain ? String(firm.review_domain).trim() : '';
  if (dom) return `https://${dom.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const env = (process.env.REVIEW_PUBLIC_BASE_URL || '').trim();
  return env ? env.replace(/\/+$/, '') : '';
}

async function reply(channel, threadTs, text) {
  try {
    await postSlackMessage({ token: SLACK_BOT_TOKEN, channel, text, threadTs });
  } catch {
    /* non-fatal */
  }
}

/**
 * Core approval → send. Maps a Slack message (channel+ts) to a review_request,
 * claims it atomically, sends the SMS, marks it sent, and replies in-thread.
 */
async function approveAndSend({ channel, messageTs, approvedBy }) {
  const req = await reviewRequests.getBySlackMessage(channel, messageTs);
  if (!req) return; // not one of our candidate messages
  if (req.sent_at) {
    await reply(channel, messageTs, '↩️ Already sent — skipping.');
    return;
  }
  if (!req.client_phone) {
    await reply(channel, messageTs, '⚠️ No client phone on file — send the link manually.');
    return;
  }
  if (!quoSend.isConfigured()) {
    await reply(channel, messageTs, '⚠️ Quo sending isn’t configured (QUO_API_KEY + QUO_SEND_FROM).');
    return;
  }

  // Atomically claim: only the first approver proceeds.
  const claimed = await reviewRequests.approveForSend(req.id, approvedBy || 'slack');
  if (!claimed) {
    await reply(channel, messageTs, '↩️ Already handled.');
    return;
  }

  try {
    const firm = (await firmStore.getFirmById(req.firm_id)) || (await firmStore.getDefaultFirm());
    const cfg = firmStore.landingConfigForFirm(firm);
    const base = reviewPublicBase(firm);
    const link = base ? `${base}/r/${req.token}` : `/r/${req.token}`;
    const text = quoSend.buildReviewSmsText({
      firstName: req.client_first_name,
      firmName: firm.firm_name,
      link,
      template: cfg.smsTemplate,
    });
    await quoSend.sendSms({ to: req.client_phone, content: text });
    await reviewRequests.markSent(req.id);
    await reply(channel, messageTs, `✅ Texted the review link to ${req.client_phone}.`);
  } catch (err) {
    await reply(channel, messageTs, `❌ Send failed: ${err.message}`);
  }
}

/** Process one Slack event (async, after we've already 200'd). */
async function processEvent(event) {
  if (!event || typeof event !== 'object') return;

  if (event.type === 'reaction_added') {
    if (event.reaction !== APPROVE_EMOJI) return;
    if (!event.item || event.item.type !== 'message') return;
    await approveAndSend({ channel: event.item.channel, messageTs: event.item.ts, approvedBy: event.user });
    return;
  }

  if (event.type === 'message') {
    // Only plain thread replies from humans; ignore edits, deletes, and bots.
    if (event.subtype || event.bot_id) return;
    if (!event.thread_ts || event.thread_ts === event.ts) return;
    if (!APPROVE_TEXT_RE.test(String(event.text || ''))) return;
    await approveAndSend({ channel: event.channel, messageTs: event.thread_ts, approvedBy: event.user });
  }
}

/**
 * Handle a parsed request body. Returns:
 *  - { challenge } for Slack's url_verification handshake
 *  - { ack: true } otherwise (caller should 200 and let processing run async)
 */
function handleBody(body) {
  if (body && body.type === 'url_verification') {
    return { challenge: body.challenge || '' };
  }
  if (body && body.type === 'event_callback' && body.event) {
    // Fire-and-forget so we can ack within Slack's 3s window.
    setImmediate(() => processEvent(body.event).catch((e) => console.warn('[slackEvents]', e.message)));
  }
  return { ack: true };
}

module.exports = { isEnabled, verifySignature, handleBody, processEvent, approveAndSend };
