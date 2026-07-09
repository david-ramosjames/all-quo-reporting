const axios = require('axios');

/**
 * Sends an SMS through the Quo / OpenPhone API (POST /v1/messages).
 *
 * Config:
 *   QUO_API_KEY    — same key used for reading calls/messages
 *   QUO_SEND_FROM  — the sending line, as an E.164 number (+15125005266) or a
 *                    phone-number id (PNxx…). Required to send.
 *
 * Texting real clients is outward-facing and irreversible, so nothing here fires
 * automatically: it runs only on explicit staff approval (a ✅ reaction / reply
 * in Slack, or the analytics "Send" button). This module just performs the send.
 */

const API_BASE = 'https://api.openphone.com';

function apiKey() {
  return (process.env.QUO_API_KEY || '').trim();
}
function sendFrom() {
  return (process.env.QUO_SEND_FROM || '').trim();
}

/** Can we actually send? */
function isConfigured() {
  return Boolean(apiKey() && sendFrom());
}

/** Normalize a US-ish number to E.164 (+1XXXXXXXXXX). Returns '' if unusable. */
function toE164(raw) {
  const s = String(raw || '').trim();
  if (/^\+\d{8,15}$/.test(s)) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

/**
 * @param {{ to: string, content: string }} opts
 * @returns {Promise<{ ok: boolean, id?: string }>}
 */
async function sendSms({ to, content }) {
  if (!isConfigured()) {
    throw new Error('Quo send not configured (set QUO_API_KEY and QUO_SEND_FROM).');
  }
  const toE164 = exportedToE164(to);
  if (!toE164) throw new Error(`Invalid destination phone number: "${to}"`);
  const from = sendFrom();

  const res = await axios.post(
    `${API_BASE}/v1/messages`,
    { from, to: [toE164], content: String(content || '').slice(0, 1500) },
    { headers: { Authorization: apiKey(), 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  const id = res.data?.data?.id || res.data?.id;
  return { ok: true, id };
}

// Named export used internally + by callers that only need normalization.
function exportedToE164(raw) {
  return toE164(raw);
}

/**
 * Builds the SMS body from a template. Tokens: {first} {firm} {link}.
 * Default keeps it short, warm, and clearly from the firm.
 */
function buildReviewSmsText({ firstName, firmName, link, template }) {
  const tmpl =
    (template && String(template).trim()) ||
    process.env.REVIEW_SMS_TEMPLATE ||
    'Hi {first}, thank you for trusting {firm}. If we made a difference, a quick Google review would mean a lot: {link}';
  return tmpl
    .replace(/\{first\}/g, (firstName || 'there').trim() || 'there')
    .replace(/\{firm\}/g, (firmName || 'our firm').trim())
    .replace(/\{link\}/g, String(link || '').trim())
    .trim();
}

module.exports = { isConfigured, sendSms, toE164: exportedToE164, buildReviewSmsText };
