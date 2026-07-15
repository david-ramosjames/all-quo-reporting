const crypto = require('crypto');
const reviewRequests = require('./reviewRequests');
const firmStore = require('./firmStore');
const quoSend = require('./quoSend');
const { postSlackMessage, updateSlackMessage } = require('./slack');

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

/** Send destinations available from Slack: the branded page or a direct platform. */
const REVIEW_DESTINATIONS = {
  branded: { label: 'branded review page', platform: null },
  google: { label: 'Google', platform: 'google' },
  facebook: { label: 'Facebook', platform: 'facebook' },
  apple: { label: 'Apple', platform: 'apple' },
  yelp: { label: 'Yelp', platform: 'yelp' },
};
const PLATFORM_URL_KEYS = {
  google: 'googleReviewUrl', facebook: 'facebookReviewUrl', apple: 'appleReviewUrl', yelp: 'yelpReviewUrl',
};

/** Replace a review card in place with a status line (falls back to a thread reply). */
async function updateCard(channel, ts, text) {
  try {
    await updateSlackMessage({
      token: SLACK_BOT_TOKEN, channel, ts, text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  } catch {
    await reply(channel, ts, text);
  }
}

/**
 * Core approval → send. Maps a Slack message (channel+ts) to a review_request,
 * claims it atomically, texts the client the chosen destination's link, marks it
 * sent, and replaces the card with a confirmation. `destination` ∈
 * branded | google | facebook | apple | yelp | cancel. Idempotent (a repeated
 * click can't double-send).
 */
async function sendReviewDestination({ channel, messageTs, approvedBy, destination }) {
  const req = await reviewRequests.getBySlackMessage(channel, messageTs);
  if (!req) return; // not one of our candidate messages
  const clientLabel = req.client_name || req.client_first_name || 'client';

  if (destination === 'cancel') {
    if (req.sent_at) { await reply(channel, messageTs, '↩️ Already sent — can’t cancel.'); return; }
    const cancelled = await reviewRequests.cancelRequest(req.id);
    await updateCard(channel, messageTs, `🚫 *Not sent* — ${clientLabel}${cancelled ? '' : ' (already handled)'}.`);
    return;
  }

  const dest = REVIEW_DESTINATIONS[destination] || REVIEW_DESTINATIONS.branded;
  if (req.sent_at) { await reply(channel, messageTs, '↩️ Already sent — skipping.'); return; }
  if (req.status === 'cancelled') {
    await reply(channel, messageTs, '🚫 This request was cancelled in the dashboard — not sending.');
    return;
  }
  if (!req.client_phone) {
    await reply(channel, messageTs, '⚠️ No client phone on file — send the link manually.');
    return;
  }

  // Resolve the firm up front so we send from that firm's Quo line.
  const firm = (await firmStore.getFirmById(req.firm_id)) || (await firmStore.getDefaultFirm());
  const fctx = firmStore.reportConfigForFirm(firm);
  if (!quoSend.isConfigured({ apiKey: fctx.quoApiKey, from: fctx.quoSendFrom })) {
    await reply(channel, messageTs, '⚠️ Quo sending isn’t configured for this firm (Quo API key + send-from line).');
    return;
  }
  const cfg = firmStore.landingConfigForFirm(firm);
  // A direct platform needs its URL configured; otherwise tell staff to fix it.
  if (dest.platform) {
    const url = String(cfg[PLATFORM_URL_KEYS[dest.platform]] || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      await reply(channel, messageTs, `⚠️ No ${dest.label} review URL configured for this firm — set it in the admin, or use *Send branded page*.`);
      return;
    }
  }

  // Atomically claim: only the first approver proceeds.
  const claimed = await reviewRequests.approveForSend(req.id, approvedBy || 'slack');
  if (!claimed) { await reply(channel, messageTs, '↩️ Already handled.'); return; }

  try {
    const base = reviewPublicBase(firm);
    // Branded → the landing page; a platform → the tracked redirect route.
    const linkPath = dest.platform ? `/r/${req.token}/${dest.platform}` : `/r/${req.token}`;
    const link = base ? `${base}${linkPath}` : linkPath;
    const text = quoSend.buildReviewSmsText({
      firstName: req.client_first_name,
      firmName: firm.firm_name,
      link,
      template: cfg.smsTemplate,
    });
    await quoSend.sendSms({ to: req.client_phone, content: text, apiKey: fctx.quoApiKey, from: fctx.quoSendFrom });
    await reviewRequests.markSent(req.id, destination);
    await updateCard(channel, messageTs, `✅ *Sent — ${dest.label}* to ${req.client_phone}  ·  ${clientLabel}`);
  } catch (err) {
    await reply(channel, messageTs, `❌ Send failed: ${err.message}`);
  }
}

/** Backward-compatible: the ✅ reaction / "approve" reply sends the branded page. */
async function approveAndSend(args) {
  return sendReviewDestination({ ...args, destination: 'branded' });
}

/**
 * Handle a Slack interactivity payload (block_actions from the review-card
 * buttons). The clicked button's value carries { t: token, d: destination }.
 */
async function handleInteraction(payload) {
  if (!payload || payload.type !== 'block_actions') return;
  const action = (payload.actions || [])[0];
  if (!action || action.action_id !== 'review_dest') return;
  let value = {};
  try { value = JSON.parse(action.value || '{}'); } catch { value = {}; }
  const destination = value.d;
  if (!destination) return;
  const channel = payload.channel && payload.channel.id;
  const messageTs = (payload.message && payload.message.ts) || (payload.container && payload.container.message_ts);
  if (!channel || !messageTs) return;
  const approvedBy = payload.user && payload.user.id ? `slack:${payload.user.id}` : 'slack';
  await sendReviewDestination({ channel, messageTs, approvedBy, destination });
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

module.exports = {
  isEnabled, verifySignature, handleBody, processEvent,
  approveAndSend, sendReviewDestination, handleInteraction,
};
