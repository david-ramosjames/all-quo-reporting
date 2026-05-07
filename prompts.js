// ============================================================================
// DAILY LEAD REPORT — Call summaries only + Slack + Google Sheets
// WEEKLY CLIENT SENTIMENT — per-client bundle (summaries + SMS + call metadata) → JSON (see report.js)
// ============================================================================

const FIRM_CONTEXT = `
PRACTICE AREA: Personal injury ONLY — car/truck/motorcycle accidents, slip and fall, premises liability, dog bites, workplace injuries with third-party liability, assault with physical injury, wrongful death, product liability, rideshare/pedestrian/bicycle accidents.

DOES NOT HANDLE: Workers' comp (employer-only claims), family law, criminal, immigration, employment law, medical malpractice, consumer fraud, landlord-tenant, contracts, property-damage-only.

CRITICAL NUANCE — WORK INJURIES: A workplace injury involving a third party (another driver, defective equipment, a subcontractor, unsafe premises not owned by the employer) IS a personal injury case the firm CAN take. If a work-injury call was declined, check whether a third-party angle exists in the summary or transcript.

KEY STAFF:
- Attorneys: Cody Garza, Ariel Allen, Ryan Toomey, Jorge Barros, Erin
- Paralegals: Adrian, Jocelyn, Aibeth, Ivette/Yvette
- Intake: Roman, Liz, Giselle, Sam/Samari
- Legal Assistants: Jackie, Claudia, Valerie/Valery

REFERRAL NUMBERS: Central Texas Lawyer Referral (512-472-8303), Texas Lawyer Referral (512-474-0007)

DAILY BENCHMARKS (from Q1 2026):
- Expected weekday volume: ~85–90 calls
- Expected weekend volume: ~10–15 calls
- Target voicemail rate: <15% (Q1 baseline: 23.5%)
- Target: 100% of declines include a referral (Q1 baseline: 68%)
- Target: Every intake call includes lead source question + value prop
- Target: Every undecided caller gets a scheduled follow-up
`.trim();

const CLASSIFICATION_BLOCK = `
CLASSIFICATION (use when labeling calls):
NEW CALLER: NEW LEAD — SIGNED | VIABLE | UNDECIDED | DECLINED — WRONG CASE TYPE | NO INJURY/AT FAULT | HAS ATTORNEY | THIRD-PARTY CALLER | SPAM/VENDOR
KNOWN CONTACT: EXISTING CLIENT — UPDATE | MEDICAL/PROVIDER | INSURANCE | SETTLEMENT/DEMAND | ADMIN
OTHER: VOICEMAIL / NO ANSWER
`.trim();

/**
 * Daily Intake & Lead Report — one merged daily narrative across calls + Slack + sheet.
 */
function generateDailyLeadReportPrompt({
  COMPANY_NAME,
  dateLabel,
  dayOfWeek,
  reportRangeLabel,
  slackMessageCount,
  sheetRowCount,
  callData,
  totalCalls,
  summaryLinesOnly,
  slackMessages,
  leadPipeline,
}) {
  const sheetRowsLabel =
    sheetRowCount != null && Number.isFinite(sheetRowCount)
      ? String(sheetRowCount)
      : 'not loaded';

  return `
You are a senior operations analyst for ${COMPANY_NAME}, a personal injury law firm in Austin, Texas.

Generate ONE combined daily report called **Daily Intake & Lead Report**. This is not two separate reports and not a paste-up.

REPORTING WINDOW (all three sources use this exact period):
${reportRangeLabel}

DAY: ${dayOfWeek}, ${dateLabel}

SOURCE COUNTS (context only):
- Quo calls in window: ${totalCalls}
- Calls with summaries: ${callData.length}
- Slack #lead-calls messages: ${slackMessageCount}
- Sheet pipeline rows: ${sheetRowsLabel}

PRIMARY GOAL:
- Lead and conversion first.
- Keep reconciliation between Quo + Slack + Sheet explicit and actionable.
- Include only the most important call handling/coaching insights tied to conversion.
- Keep the report polished, skimmable, and decision-ready.

AUTOMATED SHEET LOOKUPS (appears after row list when available):
- This section is pre-computed in code from Quo/Slack vs sheet columns.
- If it says a lead is on sheet, treat as on sheet and cite row + status + consultation.
- If auto-match misses but row evidence is obvious in the pipeline list, still treat as on sheet.

WHO BELONGS ON THE LEAD SHEET (apply BEFORE flagging anything as missing):
- The Google Sheet tracks **prospective new-client leads only**. Do NOT flag a call as "missing from sheet" unless the caller is a NEW CALLER seeking representation (CLASSIFICATION buckets: NEW LEAD — SIGNED | VIABLE | UNDECIDED | DECLINED — *or* an unclassified caller who is plausibly a new prospect).
- The following caller types are NEVER expected to be on the sheet — exclude them from **Missing from Sheet** entirely (do not list them as gaps OR as after-hours reminders):
    - Insurance adjusters / carriers (GEICO, USAA, State Farm, Progressive, Allstate, Liberty Mutual, etc.)
    - Medical providers / clinics / hospitals / PT / chiropractors / imaging
    - Process servers, court runners, couriers
    - Opposing counsel and other attorneys / law firms
    - Vendors, marketing, IT, banks, billing, collections
    - Existing clients calling for updates, settlement/demand, scheduling
    - Spam, robocalls, wrong numbers
- If the call summary or transcript makes the caller's role clear (e.g. "process server", "claims adjuster", "from the medical center"), treat that as authoritative — do not list under Missing from Sheet even if there is no row.
- When the caller's role is genuinely ambiguous, you may include them under Missing from Sheet but label them "(role unclear — confirm before adding)".

SHEET ENTRY CUTOFF (reduce false-alarm "missing" claims):
- The team member who enters leads into the sheet typically leaves at the cutoff time printed in the AUTOMATED SHEET LOOKUPS block (default 5:30 PM local).
- A NEW-LEAD caller that arrived BEFORE the cutoff and is not on the sheet → call it out as a real gap in **Missing from Sheet** (current wording).
- A NEW-LEAD caller that arrived AT or AFTER the cutoff and is not on the sheet (look for the **[AFTER-HOURS]** tag in the AUTOMATED SHEET LOOKUPS block, OR check the call/Slack timestamp yourself):
    - Do NOT phrase as "missing" or a discrepancy.
    - Place under **Missing from Sheet** in a separate sub-bullet labeled "After-hours reminders (entry expected next business day)".
    - Use reminder language, e.g. "Heads-up — please add when you're back at the desk", and cite the local time the lead came in.
- The cutoff rule only applies to callers who *would* belong on the sheet (i.e. after passing the WHO BELONGS check above). Providers/insurers/etc. are excluded regardless of timing.
- This rule applies to both Quo calls and Slack #lead-calls messages — use whichever timestamp the source provides.

MATCHING RULES (avoid false missing-lead claims):
1. Phone match = same last 10 digits after normalization.
2. Name match = first/last with minor spelling and nickname tolerance.
3. If matched, cite status and consultation field.
4. Only mark missing when no plausible match after phone + name checks.

─────────────────────────────────────────────────────────
SLACK #lead-calls (window)
─────────────────────────────────────────────────────────
${slackMessages || '(No Slack data available.)'}

─────────────────────────────────────────────────────────
LEAD PIPELINE — GOOGLE SHEETS
─────────────────────────────────────────────────────────
${leadPipeline || '(Not available.)'}

─────────────────────────────────────────────────────────
PHONE — SUMMARIES ONLY
─────────────────────────────────────────────────────────
${summaryLinesOnly || '(No calls with summaries in this period.)'}

${FIRM_CONTEXT}

${CLASSIFICATION_BLOCK}

─────────────────────────────────────────────────────────
OUTPUT FORMAT — use EXACTLY these sections in this order
─────────────────────────────────────────────────────────

## Executive Summary
- 3-5 bullets max.
- Must cover: overall day quality, lead flow quality, biggest opportunity, biggest risk, biggest operational issue.

## Today's Top Opportunities
- 3-5 items max.
- For each item use this exact compact template:
  - **Lead:** <name>
  - **Matter:** <matter type or likely type>
  - **Phone:** <full phone or "N/A">
  - **Coverage:** <Quo/Slack/Sheet presence>
  - **Status:** <current status>
  - **Why it matters:** <revenue/conversion reason>
  - **Next action:** <exact action for tomorrow>
  - **Owner:** <name or "Unassigned">
- Prioritize revenue-critical leads.

## Cross-Source Reconciliation
- Required every day even if short.
- Use four compact groups in this order:
  1) **Missing from Sheet** — NEW-LEAD callers only. Apply the "WHO BELONGS ON THE LEAD SHEET" filter first; do NOT list providers, insurers, medical, process servers, opposing counsel, vendors, existing clients, or spam here. Split into two sub-groups when both apply:
     - "Pre-cutoff (real gaps)" for new-lead callers that came in before the sheet entry cutoff
     - "After-hours reminders (entry expected next business day)" for new-lead callers that came in after the cutoff — phrase as a friendly reminder with the local time, NOT as a discrepancy
     - If neither sub-group has any items, write "- None." under this header.
  2) **Duplicate Records**
  3) **Status Mismatches**
  4) **Follow-Up Gaps**
- Keep each group as concise bullets.
- Cite row/status/consultation when known.

## Call Handling Insights
- Condensed conversion-focused QA only.
- Include:
  - 2-3 strongest call handling observations
  - 2-3 biggest gaps hurting intake quality or conversion
- If examples are used, keep each to 1-2 lines:
  - issue, example lead/call, why it matters, concrete fix
- No long transcript-style writeups.

## Themes / Patterns
- Short bullets split into:
  - **Wins**
  - **Gaps**
  - **Recurring patterns**
- Deduplicate overlap with prior sections.

## Manager Flags
- Only high-importance issues (missing high-value sheet rows, duplicate records, stalled/open leads, decline/referral issues, language support gaps, repeated callback failures).
- Keep sharp and non-redundant.

## Tomorrow's Priority
- One directive sentence plus up to 3 support bullets:
  - top conversion action
  - top process fix
  - top coaching emphasis

## Appendix (Optional)
- Only if needed for extra examples or staff notes.
- Keep short and lower priority.

STYLE RULES:
1. Keep total length tight (target 650-950 words).
2. Avoid walls of text and repeated points.
3. Use short bullets, clear labels, and scan-friendly wording.
4. Do not invent data; if unknown, say unknown.
5. Use full phone numbers when identifying leads.
6. If two sections overlap, mention details once in the most relevant section and avoid repetition.
7. Prioritization order:
   - Revenue/conversion-critical actions
   - Cross-system reconciliation issues
   - Call handling issues affecting conversion
   - Operational patterns
   - Extra details
`;
}

// ============================================================================
// WEEKLY CLIENT SENTIMENT — per-transcript JSON + aggregated email
// ============================================================================

/** Tags the LLM should prefer (snake_case in output). */
const SENTIMENT_REASON_TAGS = [
  'responsiveness',
  'empathy',
  'clarity',
  'confusion',
  'case_progress',
  'frustration',
  'urgency',
  'trust',
  'language_barrier',
  'expectation_mismatch',
  'scheduling',
  'follow_up',
  /** Review / social blast / AG or bar — also used when code applies mandatory escalation. */
  'regulatory_or_review_threat',
];

/**
 * Single transcript → strict JSON (law firm client call sentiment). Used only if legacy per-call mode is enabled.
 */
function buildTranscriptSentimentPrompt({
  COMPANY_NAME,
  contact,
  line,
  phone,
  timestamp,
  summary,
  transcript,
  link,
}) {
  const tagList = SENTIMENT_REASON_TAGS.join(', ');
  return `
You are an expert analyst reviewing **recorded phone calls** for ${COMPANY_NAME}, a personal injury law firm.

This is a **law firm client call**. Your job is to assess **client sentiment** from the **client's perspective** in this conversation.

Base sentiment on the **overall tone** of the interaction, especially:
- How the **client** seems to feel (worried, relieved, angry, confused, grateful, etc.)
- Whether **staff** interaction **improved or worsened** that emotional state
- Whether the call built **confidence, confusion, reassurance, or frustration**

Use the **full transcript** as primary evidence; the summary is secondary if present.

CONTACT (CRM name — includes case number for clients): ${contact || '(unknown)'}
LINE: ${line || ''}
PHONE: ${phone || ''}
TIME: ${timestamp || ''}
QUO LINK: ${link || ''}

SUMMARY (may be incomplete):
${summary || '(none)'}

TRANSCRIPT:
${transcript}

---

Respond with **valid JSON only** — no markdown fences, no commentary before or after. The JSON must match this TypeScript shape exactly:

{
  "sentiment": "positive" | "neutral" | "negative",
  "reason_summary": string,
  "reason_tags": string[],
  "client_state": string
}

Rules:
- **sentiment**: "positive" if the client ends reassured, grateful, or clearly satisfied; "negative" if frustrated, angry, or clearly distressed without adequate resolution; "neutral" if mixed, informational, or emotionally flat.
- **reason_summary**: 1–2 short sentences explaining **why** you chose that sentiment (staff + client dynamics).
- **reason_tags**: Use **only** normalized tags from this list when they apply (omit tags that do not apply): ${tagList}
  Use **snake_case** exactly as listed (e.g. "case_progress", not "Case Progress").
- **client_state**: One short phrase summarizing what the **client** seemed to be feeling or experiencing (e.g. anxious about the timeline, relieved after explanation).

Return compact JSON on one line or pretty-printed; either is fine as long as it parses.
`.trim();
}

/**
 * Full two-week touchpoint list (voice rows use **AI summaries only** — no full transcripts) → one JSON per client.
 */
function buildWeeklyClientBundleSentimentPrompt({
  COMPANY_NAME,
  clientName,
  phone,
  rangeLabel,
  touchpointCount,
  communicationLogMarkdown,
}) {
  const tagList = SENTIMENT_REASON_TAGS.join(', ');
  return `
You are an expert analyst for ${COMPANY_NAME}, a personal injury law firm.

You are judging **overall client relationship sentiment** for **one active client** using **everything that happened in the reporting window** (about the last two weeks). Evidence may include:
- **Voice**: completed calls, **missed** / **no-answer** / **abandoned** / **busy** legs, callbacks, voicemails (often reflected in the AI summary even when there was no live conversation), and calls handled by **Sona / AI** (\`aiHandled\` / summaries labeled as such in the log).
- **SMS**: inbound and outbound text threads.

**Do not** assume you have full transcripts. Treat each voice line’s **Summary** as the primary source; treat SMS quoted text as primary for texts. When a voice row says **(none)** for summary, infer only what you can from **status** (e.g. missed inbound) and SMS context — do not invent dialogue.

Reporting window: **${rangeLabel}**  
CLIENT (CRM — includes case number): **${clientName}**  
PHONE: ${phone || '(unknown)'}  
Touchpoints in log: **${touchpointCount}**

---

CHRONOLOGICAL LOG (oldest → newest):

${communicationLogMarkdown}

---

Respond with **valid JSON only** (no markdown fences). Shape:

{
  "sentiment": "positive" | "neutral" | "negative",
  "reason_summary": string,
  "reason_tags": string[],
  "client_state": string,
  "bad_review_risk": "none" | "low" | "moderate" | "high",
  "bad_review_risk_note": string,
  "positive_review_candidate": "none" | "possible" | "strong",
  "positive_review_note": string
}

Rules:
- **sentiment**: holistic judgment across **all** touchpoints in the window (not only the last message).
- **reason_summary**: 2–4 short sentences integrating voice + SMS; cite patterns, not invented quotes.
- **reason_tags**: only from: ${tagList} (snake_case).
- **client_state**: current emotional/relationship posture in plain language.
- **bad_review_risk** / **bad_review_risk_note**: would this client plausibly leave a **public negative** review or blast the firm? **high** = clear anger, betrayal, threats, repeated failures, ghosting after bad news; note must be concrete. Use **none** if no credible risk.
- **positive_review_candidate** / **positive_review_note**: would they plausibly leave a **glowing** review or referral? **strong** = clear gratitude, delight, trust, enthusiastic praise; **none** if no signal.

**Mandatory classifications — do not soften or downgrade these:**
- **Explicit bad-review / reputation threats:** If the client or anyone on their side (spouse, family, etc.) **threatens** a **bad, negative, or one-star** review, says they will **post on Google/Yelp/social media**, **trash** the firm online, or otherwise tie dissatisfaction to **going public**, set **sentiment: negative**, **bad_review_risk: high**, include **regulatory_or_review_threat** in **reason_tags**, and explain concretely in **bad_review_risk_note**.
- **Regulatory / bar escalation:** If the log mentions **filing a complaint with the Attorney General**, **consumer protection** (in a hostile filing sense), a **State Bar** or **Texas State Bar** **grievance** / **bar complaint** / **disciplinary** action against the firm or a lawyer, set **sentiment: negative**, **bad_review_risk: high**, **regulatory_or_review_threat** in **reason_tags**, and spell out the threat in **bad_review_risk_note**. Treat this as a **major** reputational and practice risk even if tone is calm.
- **Harsh performance / competence criticism:** If a caller **explicitly attacks** how a specific staff member performed (e.g. did not like their handling, calls work **negligent**, **incompetent**, or **unprofessional**) in a serious way—especially from a **family member** echoing the client’s dissatisfaction—default to **sentiment: negative** and **bad_review_risk** at least **moderate** (usually **high** if tied to leaving, switching firms, or public fallout). Do **not** label these neutral or positive.
- **Writing style for all string fields above** (especially **client_state**, **reason_summary**, **bad_review_risk_note**, **positive_review_note**): use **complete sentences** that end with **.** (or **?** / **!** when appropriate). Do **not** stop mid-thought, mid-clause, or with a dangling **and** / **but** / **because**.

Return JSON only.
`.trim();
}

/**
 * @deprecated Weekly email is table-only in report.js; kept for reference / optional reuse.
 */
function buildWeeklySentimentEmailPrompt({
  COMPANY_NAME,
  rangeLabel,
  hardFactsMarkdown,
  analysesDigest,
}) {
  return `
You are writing a **weekly leadership briefing** for ${COMPANY_NAME} about **client call sentiment** over the past two weeks.

Reporting window: **${rangeLabel}**

The following **facts are authoritative** — use these **exact counts and percentages** in the Snapshot (do not invent or round differently):

${hardFactsMarkdown}

Per-**client** rollups (one block per client; if they called multiple times, counts and notes are combined — **not** one block per transcript):

${analysesDigest}

A precise **Markdown table** listing **every client** (one row per client, all calls rolled up) will be **appended after** your sections. Use your sections for executive themes and priorities; **do not** try to reproduce the full client list in prose.

---

Write the **email body in Markdown** (not HTML). Use **exactly** these top-level sections and headings:

## Snapshot
- Total client transcripts reviewed: (use the exact number from facts)
- Positive / Neutral / Negative: counts and **percentages** from facts

## Overall Sentiment
Short paragraph: how clients **generally** seem to be feeling based on these calls.

## Main Reasons Why
Top themes driving sentiment. Use **bold** for theme names where helpful. Include tag or theme **counts** where it adds clarity (e.g. "mentioned in 6 calls").

## What Clients Are Feeling
Short synthesis of emotional state / mindset (e.g. reassured, confused, frustrated, urgent, grateful, uncertain). Ground this in the analyses.

## Opportunities
Specific, actionable areas where **communication or process** could improve (bullets OK).

## What's Working
Positive patterns worth **reinforcing** (bullets OK).

Tone: **concise**, **insight-driven**, **human** (not robotic), suitable for firm leadership. Do **not** be overly verbose. Do **not** include a subject line in the body.

Do **not** quote entire transcripts. You may paraphrase briefly. Do **not** name staff unless necessary for a key insight (prefer roles, e.g. "intake").
`.trim();
}

// ============================================================================
// MONTHLY CLIENT NEWSLETTER — per-call extraction (summary-first, anonymized) + pooled editorial brief
// ============================================================================

const MONTHLY_EXTRACTION_FIELDS = [
  'common_questions',
  'misconceptions',
  'client_feelings',
  'insurance_situations',
  'timeline_confusions',
  'triggers',
  'hesitations',
];

/**
 * Single call → newsletter-relevant themes (JSON). Uses **AI call summary** as primary evidence; transcript optional.
 */
function buildMonthlyTranscriptExtractionPrompt({
  COMPANY_NAME,
  callSegment,
  line,
  timestamp,
  summary,
  transcript,
  link,
}) {
  const segmentNote =
    callSegment === 'client'
      ? 'This interaction is labeled **client** (signed matter — CRM name matched the client pattern).'
      : 'This interaction is labeled **lead_or_other** (intake, undecided, or non-client). Pay extra attention to **hesitations** and **triggers** for this type.';

  const summaryText = String(summary || '').trim() || '(none)';
  const tr = String(transcript || '').trim();
  const transcriptBlock = tr
    ? `TRANSCRIPT (optional extra detail — use only if it adds facts not in the summary):\n${tr}`
    : `TRANSCRIPT: _(none — use SUMMARY only; do not invent dialogue.)_`;

  return `
You extract **newsletter and educational content themes** from a **personal injury law firm** phone interaction for ${COMPANY_NAME}.

${segmentNote}

Goal: surface what callers are **confused about**, **worried about**, or **getting wrong** — in **short, reusable phrases** for a **client-facing monthly newsletter** (FAQs, myth-busting, plain-English explainers). Do **not** score overall sentiment. Do **not** refer to any named person — this is anonymized source material.

**Primary evidence** is the **AI call summary** below. A full transcript may be absent or trimmed — that is normal.

SOURCE_TYPE: **${callSegment}**
LINE: ${line || ''}
TIME: ${timestamp || ''}
INTERNAL_LINK (for staff only — do not echo in JSON strings): ${link || ''}

SUMMARY (primary):
${summaryText}

${transcriptBlock}

---

Return **only valid JSON** (no markdown fences, no commentary) with this exact shape:

{
  "common_questions": string[],
  "misconceptions": string[],
  "client_feelings": string[],
  "insurance_situations": string[],
  "timeline_confusions": string[],
  "triggers": string[],
  "hesitations": string[]
}

Rules:
- Include **only** items **clearly supported** by the **summary** and/or transcript when present. If a category has nothing, use [].
- Each string: **short**, **normalized**, **reusable** (e.g. a newsletter bullet or heading idea) — not long paragraphs. **Never** include caller names, phone numbers, or case numbers in any string.
- **common_questions**: questions the caller asks or clearly implies (wording close to how people ask).
- **misconceptions**: wrong beliefs or risky assumptions (factually or strategically wrong from a PI perspective).
- **client_feelings**: emotional signals / mindset (e.g. anxiety about timeline, shame about not seeing a doctor) — useful for **tone** of newsletter copy, not for identifying anyone.
- **insurance_situations**: insurer behavior, pressure, early offers, recorded statements, adjuster contact, etc.
- **timeline_confusions**: misunderstandings about how long things take or why things feel slow.
- **triggers**: why they reached out **now** (insurance called, pain worse, referral, paperwork, etc.).
- **hesitations**: reluctance or why they might **not** move forward (think about it, distrust, DIY, already took offer) — especially important for **lead_or_other**.

Use concise American English. Omit empty arrays' items — do not invent filler.
`.trim();
}

/**
 * Several anonymized calls in one prompt → one JSON object with **extractions** array (same order as items).
 */
function buildMonthlyBatchExtractionPrompt({ COMPANY_NAME, items }) {
  const blocks = items
    .map((it, i) => {
      const summaryText = String(it.summary || '').trim() || '(none)';
      let tr = String(it.transcript || '').trim();
      if (it.transcriptMaxChars > 0 && tr.length > it.transcriptMaxChars) {
        tr = `${tr.slice(0, it.transcriptMaxChars)}…`;
      }
      const transcriptBlock = tr
        ? `TRANSCRIPT (optional — facts not in summary only):\n${tr}`
        : `TRANSCRIPT: _(none)_`;
      return `### Item ${i + 1} of ${items.length}
SOURCE_TYPE: **${it.callSegment}**
LINE: ${it.line || ''}
TIME: ${it.timestamp || ''}
INTERNAL_LINK (do not echo): ${it.link || ''}

SUMMARY:
${summaryText}

${transcriptBlock}`;
    })
    .join('\n\n---\n\n');

  return `
You extract **newsletter and educational content themes** from **multiple** personal injury firm phone interactions for ${COMPANY_NAME}.

Each **Item** is one interaction. Evidence is the **AI summary** (primary) and optional **transcript** snippet. Do **not** invent dialogue. Do **not** name people, phone numbers, or case numbers in any string.

${blocks}

---

Return **only valid JSON** (no markdown fences, no commentary). The root value must be a single JSON **object** with one key, **extractions**, whose value is an **array of exactly ${items.length} objects** (not ${items.length - 1}, not ${items.length + 1} — one extraction object per Item, same order).

Each element of **extractions** corresponds to **Item 1, Item 2, …** in order and must contain **only** these keys, each a JSON array of strings (use [] if empty):
**common_questions**, **misconceptions**, **client_feelings**, **insurance_situations**, **timeline_confusions**, **triggers**, **hesitations**.

Rules (apply per element to that Item only):
- Include only points clearly supported by that Item’s summary/transcript.
- Short, reusable newsletter/FAQ phrases — not long paragraphs.
- **hesitations** matters most for SOURCE_TYPE **lead_or_other**.

Use concise American English.
`.trim();
}

/**
 * Turn pooled per-call JSON extractions (summary-first) into a **client newsletter** content plan — not organized by caller.
 */
function buildMonthlyNewsletterAggregationPrompt({
  COMPANY_NAME,
  rangeLabel,
  transcriptCount,
  clientTranscriptCount,
  leadOrOtherTranscriptCount,
  rawExtractionsMarkdown,
}) {
  return `
You are a **content strategist** for ${COMPANY_NAME}, a personal injury firm. Your output helps the team build a **monthly client newsletter** (and related FAQs, blog posts, or social posts): practical, plain-English, educational — **not** a recap of who called.

Reporting window: **${rangeLabel}**

Source: **${transcriptCount}** voice interactions with usable summaries were mined (**${clientTranscriptCount}** client-side, **${leadOrOtherTranscriptCount}** lead/intake/other). The raw material below is **pooled by theme** (no caller names or phone numbers). Items may repeat — your job is to **merge**, **dedupe**, and **prioritize** what would resonate with **clients and former leads** reading a newsletter.

POOLED EXTRACTS (anonymized):

${rawExtractionsMarkdown}

---

Write the **email body in Markdown** (not HTML) for **internal editors**. Use **exactly** this structure:

## Snapshot for the newsletter team

3–5 bullets: what this month suggests readers care about (themes only — no individuals).

## FAQ seeds (merge duplicates)

Bullet list of the strongest recurring **questions** people are actually asking — phrased the way you’d use them as FAQ headings or short “Ask Ramos James” blocks. Note approximate frequency only when reasonable (“recurring”, “several calls”, etc.) — do not invent counts.

## Myths & mistakes to correct

Bullet list: misconceptions worth a short **myth vs. fact** or explainer piece.

## Insurance & claims desk topics

Bullet list: adjuster pressure, recorded statements, low offers, delays, etc. — newsletter-safe angles only.

## Timeline & process (“what happens next?”)

Bullet list: confusion about how long things take, next steps, medical treatment, etc.

## Timely or “news you can use” hooks

Only if the pooled notes clearly support it (e.g. seasonal risks, recurring current events callers mention). If nothing fits, write: **None surfaced clearly this month.**

## Tone & empathy (for writers, not for naming anyone)

Short paragraph + optional bullets: emotional undercurrents from **client_feelings** / **hesitations** that should shape **warm, reassuring** copy — still no individuals.

## Newsletter building blocks

- **Section ideas:** 6–10 concrete working titles for newsletter **sections** or short articles (educational, non-legalese).
- **Subject line ideas:** 4–6 **client-facing** email subject lines (curiosity + clarity, not clickbait).

Rules: **Do not** name private individuals, callers, or staff from the notes. **Do not** organize by person or by call. This is a **single editorial brief** for the month.
`.trim();
}

module.exports = {
  generateDailyLeadReportPrompt,
  buildTranscriptSentimentPrompt,
  buildWeeklyClientBundleSentimentPrompt,
  buildWeeklySentimentEmailPrompt,
  SENTIMENT_REASON_TAGS,
  MONTHLY_EXTRACTION_FIELDS,
  buildMonthlyTranscriptExtractionPrompt,
  buildMonthlyBatchExtractionPrompt,
  buildMonthlyNewsletterAggregationPrompt,
};
