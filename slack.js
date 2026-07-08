const { WebClient } = require('@slack/web-api');

const REQUEST_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Subtypes we still include (e.g. Facebook / Zapier bots posting leads). */
const ALLOWED_SUBTYPES = new Set(['bot_message', 'file_share']);

/**
 * Fetches ALL messages in [oldest, latest) — paginated, no row cap.
 * Same wall-clock window as phone calls when oldest/latest come from report.js.
 *
 * Optional: thread replies (see includeThreads).
 */
async function fetchSlackMessages(token, channelName, oldest, latest, options = {}) {
  const { includeThreads = true } = options;
  const client = new WebClient(token);
  const name     = channelName.replace(/^#/, '');

  let channelId = null;
  let cursor;

  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    const match = res.channels.find((c) => c.name === name);
    if (match) { channelId = match.id; break; }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  if (!channelId) throw new Error(`Slack channel #${name} not found. Check the channel name and bot membership.`);

  const oldestTs = (new Date(oldest).getTime() / 1000).toString();
  const latestTs = (new Date(latest).getTime() / 1000).toString();

  const raw = [];
  cursor = undefined;

  // Max limit per Slack API page — paginate until no cursor (no message-count cap)
  do {
    const res = await client.conversations.history({
      channel: channelId,
      oldest: oldestTs,
      latest: latestTs,
      limit: 1000,
      cursor,
    });
    raw.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
    if (cursor) await sleep(REQUEST_DELAY_MS);
  } while (cursor);

  const userCache = {};

  async function resolveSender(msg) {
    if (msg.user) {
      if (userCache[msg.user]) return userCache[msg.user];
      try {
        const res = await client.users.info({ user: msg.user });
        const p = res.user?.profile;
        const label = p?.display_name || p?.real_name || msg.user;
        userCache[msg.user] = label;
        return label;
      } catch {
        userCache[msg.user] = msg.user;
        return msg.user;
      }
    }
    if (msg.bot_profile?.name) return `Bot:${msg.bot_profile.name}`;
    if (msg.username) return `Bot:${msg.username}`;
    return 'Unknown';
  }

  async function fetchThread(threadTs) {
    const replies = [];
    const seen = new Set();
    let tc;
    do {
      const res = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        cursor: tc,
      });
      for (const m of res.messages || []) {
        if (m.ts === threadTs || seen.has(m.ts)) continue;
        if (!m.text?.trim()) continue;
        if (m.subtype && !ALLOWED_SUBTYPES.has(m.subtype)) continue;
        seen.add(m.ts);
        replies.push({ ...m, _sender: await resolveSender(m) });
      }
      tc = res.response_metadata?.next_cursor;
      if (tc) await sleep(REQUEST_DELAY_MS);
    } while (tc);
    return replies;
  }

  const cleaned = [];

  for (const msg of raw) {
    if (!msg.text?.trim()) continue;
    if (msg.subtype && !ALLOWED_SUBTYPES.has(msg.subtype)) continue;

    const sender = await resolveSender(msg);

    let threadReplies = [];
    if (includeThreads && msg.reply_count > 0) {
      threadReplies = await fetchThread(msg.ts);
      await sleep(REQUEST_DELAY_MS);
    }

    cleaned.push({
      ts: msg.ts,
      time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      user: sender,
      text: flattenText(msg.text, userCache),
      threadReplies: threadReplies.map((m) => ({
        user: m._sender,
        text: flattenText(m.text, userCache),
      })),
    });
  }

  cleaned.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  return cleaned;
}

function flattenText(text, userCache) {
  return text
    .replace(/<@[A-Z0-9]+>/g, (m) => {
      const id = m.slice(2, -1);
      return userCache[id] ? `@${userCache[id]}` : m;
    })
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

/**
 * Formats Slack for the LLM — full day, all messages (threads indented).
 */
function formatSlackForPrompt(messages, timezone, rangeLabel) {
  const header = `#lead-calls — ${rangeLabel} (${messages.length} top-level message(s), threads expanded where enabled)`;

  if (!messages.length) return `${header}\n(No messages in this window.)`;

  const lines = [header, ''];

  for (const m of messages) {
    const time = new Date(m.time).toLocaleString('en-US', {
      timeZone: timezone || 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    lines.push(`[${time}] ${m.user}: ${m.text}`);
    for (const r of m.threadReplies || []) {
      lines.push(`    ↳ ${r.user}: ${r.text}`);
    }
  }

  return lines.join('\n');
}

/**
 * Resolves a channel **name** (with or without leading #) to its Slack ID.
 * Paginates public + private channels the bot is a member of.
 */
async function resolveChannelId(client, channelName) {
  const name = String(channelName || '').replace(/^#/, '');
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    const match = res.channels.find((c) => c.name === name);
    if (match) return match.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  throw new Error(`Slack channel #${name} not found. Check the channel name and bot membership.`);
}

/**
 * Posts a message to a Slack channel by name.
 *
 * @param {object} opts
 * @param {string} opts.token   Slack bot token (chat:write scope).
 * @param {string} opts.channel Channel name (e.g. "review-opportunities") or ID.
 * @param {string} opts.text    Fallback / notification text (required by Slack).
 * @param {Array}  [opts.blocks] Optional Block Kit blocks for rich formatting.
 * @returns {Promise<{ ok: boolean, ts?: string, channel?: string }>}
 */
async function postSlackMessage({ token, channel, text, blocks }) {
  if (!token) throw new Error('postSlackMessage: missing Slack bot token.');
  if (!channel) throw new Error('postSlackMessage: missing channel.');
  const client = new WebClient(token);
  // Accept a raw channel ID (Cxxxx / Gxxxx) or resolve a human name.
  const looksLikeId = /^[CG][A-Z0-9]{6,}$/.test(String(channel).trim());
  const channelId = looksLikeId ? String(channel).trim() : await resolveChannelId(client, channel);
  const res = await client.chat.postMessage({
    channel: channelId,
    text: text || ' ',
    blocks: blocks && blocks.length ? blocks : undefined,
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ok: Boolean(res.ok), ts: res.ts, channel: res.channel };
}

module.exports = { fetchSlackMessages, formatSlackForPrompt, postSlackMessage };
