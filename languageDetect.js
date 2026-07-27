/**
 * Lightweight English/Spanish language detection for Quo call transcripts and
 * SMS text. English vs Spanish is an easy, well-separated pair, so a
 * function-word + diacritic scorer is accurate and free (no LLM), and it scales
 * to the whole contact list.
 *
 * Per client we classify each transcript/message and aggregate to one of:
 * 'english' | 'spanish' | 'both' | 'unknown'.
 */

// Distinctive Spanish function/common words (avoid tokens that also read as English).
const ES_WORDS = new Set(
  ('que de la el los las una unos unas por para con sin pero porque como muy más ' +
    'está están estoy estamos ser estar este esta eso esto ese esa aquí allí ahora ' +
    'bien sí gracias hola buenos buenas días tardes noches señor señora usted ustedes ' +
    'yo él ella nosotros ustedes mi su tu tengo tiene tienen quiero necesito puede pueden ' +
    'hacer tiempo caso abogado seguro cita dinero cheque documento documentos llamada ' +
    'teléfono entiendo hablar hablo español ya cuando dónde donde quién cuál también ' +
    'nada algo todo todos nada mucho poco hoy mañana ayer verdad claro vale entonces ' +
    'trabajo casa problema ayuda favor listo lista mismo hijo hija esposo esposa')
    .split(/\s+/)
);

// Distinctive English function/common words.
const EN_WORDS = new Set(
  ('the and to of in is are was were be been you your i we they he she it this that these ' +
    'those for with on at but or so if not okay thank thanks please hello have has had will ' +
    'would can could should need want know time case lawyer attorney insurance appointment ' +
    'check document call phone understand speak english yeah right sure about there here ' +
    'because when where what which who how just going get got make made give given because ' +
    'work home problem help ready same son daughter husband wife today tomorrow yesterday')
    .split(/\s+/)
);

const ES_DIACRITICS = /[áéíóúñ¿¡ü]/gi;

const MIN_TOKENS = 6; // ignore very short snippets

function scoreText(text) {
  const raw = String(text || '');
  const diacritics = (raw.match(ES_DIACRITICS) || []).length;
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let es = 0;
  let en = 0;
  for (const t of tokens) {
    if (ES_WORDS.has(t)) es++;
    if (EN_WORDS.has(t)) en++;
  }
  // Diacritics are a strong Spanish tell; weight them.
  es += diacritics * 2;
  return { es, en, tokens: tokens.length, diacritics };
}

/** Classify a single piece of text. Returns english | spanish | unknown. */
function detectLanguage(text) {
  const s = scoreText(text);
  if (s.tokens < MIN_TOKENS || s.es + s.en === 0) return 'unknown';
  if (s.diacritics >= 2 && s.es >= s.en) return 'spanish';
  if (s.es > s.en * 1.3) return 'spanish';
  if (s.en > s.es * 1.3) return 'english';
  return s.es >= s.en ? 'spanish' : 'english';
}

/**
 * Aggregate many texts (a client's transcripts + SMS) into one language label.
 * @param {string[]} texts
 * @returns {{ language: 'english'|'spanish'|'both'|'unknown', analyzed:number,
 *            esItems:number, enItems:number, spanishShare:number }}
 */
function aggregateLanguages(texts) {
  let esTot = 0;
  let enTot = 0;
  let esItems = 0;
  let enItems = 0;
  let analyzed = 0;

  for (const text of texts || []) {
    const s = scoreText(text);
    if (s.tokens < MIN_TOKENS || s.es + s.en === 0) continue;
    analyzed++;
    esTot += s.es;
    enTot += s.en;
    const lang = detectLanguage(text);
    if (lang === 'spanish') esItems++;
    else if (lang === 'english') enItems++;
  }

  if (analyzed === 0) {
    return { language: 'unknown', analyzed: 0, esItems: 0, enItems: 0, spanishShare: 0 };
  }

  const total = esTot + enTot;
  const spanishShare = total > 0 ? esTot / total : 0;

  let language;
  // Clear evidence of both languages across the client's communications.
  if (esItems > 0 && enItems > 0 && spanishShare > 0.15 && spanishShare < 0.85) {
    language = 'both';
  } else if (spanishShare >= 0.6) {
    language = 'spanish';
  } else if (spanishShare <= 0.4) {
    language = 'english';
  } else {
    // Mixed scores without clear per-item split.
    language = 'both';
  }

  return {
    language,
    analyzed,
    esItems,
    enItems,
    spanishShare: Math.round(spanishShare * 100) / 100,
  };
}

module.exports = { detectLanguage, aggregateLanguages, scoreText };
