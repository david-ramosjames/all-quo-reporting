/**
 * Shared SMS helpers for Needs Response clearance.
 * Kept tiny so webhooks can use them without loading report.js.
 */

/**
 * Cheap pre-filter: empty / pure acknowledgements / greeting-only never need an LLM call.
 */
function isObviousNoActionSms(body) {
  const t = String(body || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return true;
  return /^(ok|okay|k|kk|thanks|thank you|thx|ty|got it|sounds good|yes|yep|yeah|no|nah|np|yw|hi|hello|hey|good morning|good afternoon|good evening|hola|buenos dias|buenas|si|sí)([!.,\s]*)$/i.test(
    t
  );
}

/**
 * Canned Quo/RJL auto-replies are not a staff follow-up — they must not clear
 * Needs Response (e.g. bilingual "Thank you for contacting Ramos James Law…").
 */
function isAutoReplyOutboundSms(body) {
  const t = String(body || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/thank you for contacting ramos james law/i.test(t)) return true;
  if (/gracias por contactar a ramos james law/i.test(t)) return true;
  if (
    /a member of our legal team will review your message/i.test(t) &&
    /get back to you as soon as possible/i.test(t)
  ) {
    return true;
  }
  if (
    /un miembro de nuestro equipo legal revisar[aá] su mensaje/i.test(t) &&
    /se comunicar[aá] con usted lo antes posible/i.test(t)
  ) {
    return true;
  }
  return false;
}

module.exports = {
  isObviousNoActionSms,
  isAutoReplyOutboundSms,
};
