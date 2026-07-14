require('dotenv').config();
const cron = require('node-cron');
const { DateTime } = require('luxon');
const {
  runDailyReport,
  runWeeklyClientSentimentReport,
  runMonthlyNewsletterInsightsReport,
  runMissedClientCallReport,
  runReviewIntelligenceReport,
  runForAllFirms,
} = require('./report');

// Daily: previous calendar day — Daily Intake & Lead Report + Quo CSV (Slack + sheet).
const SCHEDULE = process.env.CRON_SCHEDULE || '0 7 * * *';
// Weekly: trailing 7 days — client bundle sentiment, negative-focused email.
// day-of-week: 0 = Sunday, 5 = Friday (node-cron).
const WEEKLY_SENTIMENT_CRON = process.env.WEEKLY_SENTIMENT_CRON || '0 20 * * 5';
// Monthly: trailing 30 days — pooled FAQ / newsletter content brief (default: 01:00 on the 1st).
const MONTHLY_INSIGHTS_CRON = process.env.MONTHLY_INSIGHTS_CRON || '0 1 1 * *';
// Missed Client Call Report: trailing 24h — clients who haven't been called back yet (default: 7:00 AM local).
const MISSED_CLIENT_CALLS_CRON = process.env.MISSED_CLIENT_CALLS_CRON || '0 7 * * *';
// Review Intelligence: trailing 24h — daily Google-review candidates (default: 6:00 PM local).
const REVIEW_INTELLIGENCE_CRON = process.env.REVIEW_INTELLIGENCE_CRON || '0 18 * * *';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';

console.log('══════════════════════════════════════════════');
console.log('  Quo Report Scheduler');
console.log('══════════════════════════════════════════════');
console.log(`  Daily lead + CSV : ${SCHEDULE}`);
console.log(`  Weekly sentiment : ${WEEKLY_SENTIMENT_CRON}`);
console.log(`  Monthly newsletter : ${MONTHLY_INSIGHTS_CRON}`);
console.log(`  Missed client calls : ${MISSED_CLIENT_CALLS_CRON}`);
console.log(`  Review intelligence : ${REVIEW_INTELLIGENCE_CRON}`);
console.log(`  Timezone         : ${TIMEZONE}`);
console.log(`  Started          : ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' })}`);
console.log('══════════════════════════════════════════════\n');

if (!cron.validate(SCHEDULE)) {
  console.error(`Invalid cron expression: "${SCHEDULE}"`);
  process.exit(1);
}

if (!cron.validate(WEEKLY_SENTIMENT_CRON)) {
  console.error(`Invalid WEEKLY_SENTIMENT_CRON: "${WEEKLY_SENTIMENT_CRON}"`);
  process.exit(1);
}

if (!cron.validate(MONTHLY_INSIGHTS_CRON)) {
  console.error(`Invalid MONTHLY_INSIGHTS_CRON: "${MONTHLY_INSIGHTS_CRON}"`);
  process.exit(1);
}

if (!cron.validate(MISSED_CLIENT_CALLS_CRON)) {
  console.error(`Invalid MISSED_CLIENT_CALLS_CRON: "${MISSED_CLIENT_CALLS_CRON}"`);
  process.exit(1);
}

if (!cron.validate(REVIEW_INTELLIGENCE_CRON)) {
  console.error(`Invalid REVIEW_INTELLIGENCE_CRON: "${REVIEW_INTELLIGENCE_CRON}"`);
  process.exit(1);
}

cron.schedule(
  SCHEDULE,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — daily intake & lead report + Quo CSV...`);
    try {
      await runForAllFirms(runDailyReport);
    } catch (err) {
      console.error(`[${ts}] Daily report failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  WEEKLY_SENTIMENT_CRON,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — weekly client sentiment (7-day window)...`);
    try {
      await runForAllFirms(runWeeklyClientSentimentReport);
    } catch (err) {
      console.error(`[${ts}] Weekly sentiment failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  MONTHLY_INSIGHTS_CRON,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — monthly client newsletter content (30-day window)...`);
    try {
      await runForAllFirms(runMonthlyNewsletterInsightsReport);
    } catch (err) {
      console.error(`[${ts}] Monthly newsletter job failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  MISSED_CLIENT_CALLS_CRON,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — missed client call report (trailing 24h)...`);
    try {
      await runForAllFirms(runMissedClientCallReport);
    } catch (err) {
      console.error(`[${ts}] Missed client call report failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

cron.schedule(
  REVIEW_INTELLIGENCE_CRON,
  async () => {
    const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
    console.log(`\n[${ts}] Cron triggered — Review Intelligence (trailing 24h)...`);
    try {
      await runForAllFirms(runReviewIntelligenceReport);
    } catch (err) {
      console.error(`[${ts}] Review Intelligence report failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

// ── Next-run visibility ───────────────────────────────────────────────────────
// Cron jobs only log when they FIRE, so print the next scheduled fire time for
// each at boot — an easy way to confirm (e.g.) Review Intelligence is armed for 6 PM.
function cronFieldMatch(field, val, isDow) {
  for (const part of String(field).split(',')) {
    if (part === '*') return true;
    let m;
    if ((m = part.match(/^\*\/(\d+)$/))) { if (val % Number(m[1]) === 0) return true; continue; }
    if ((m = part.match(/^(\d+)-(\d+)$/))) {
      let a = Number(m[1]); let b = Number(m[2]);
      if (isDow) { a %= 7; b %= 7; }
      if (val >= Math.min(a, b) && val <= Math.max(a, b)) return true;
      continue;
    }
    let n = Number(part);
    if (isDow) n %= 7;
    if (val === n) return true;
  }
  return false;
}
function cronMatches(expr, dt) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [mi, ho, dom, mo, dowF] = parts;
  const cronDow = dt.weekday === 7 ? 0 : dt.weekday; // luxon 7=Sun → cron 0
  return (
    cronFieldMatch(mi, dt.minute) &&
    cronFieldMatch(ho, dt.hour) &&
    cronFieldMatch(dom, dt.day) &&
    cronFieldMatch(mo, dt.month) &&
    cronFieldMatch(dowF, cronDow, true)
  );
}
function nextRun(expr, tz) {
  let dt = DateTime.now().setZone(tz).set({ second: 0, millisecond: 0 }).plus({ minutes: 1 });
  for (let i = 0; i < 367 * 1440; i++) {
    if (cronMatches(expr, dt)) return dt;
    dt = dt.plus({ minutes: 1 });
  }
  return null;
}

console.log(`Next scheduled runs (${TIMEZONE}):`);
for (const [label, expr] of [
  ['Daily lead + CSV', SCHEDULE],
  ['Weekly sentiment', WEEKLY_SENTIMENT_CRON],
  ['Monthly newsletter', MONTHLY_INSIGHTS_CRON],
  ['Missed client calls', MISSED_CLIENT_CALLS_CRON],
  ['Review intelligence', REVIEW_INTELLIGENCE_CRON],
]) {
  const n = nextRun(expr, TIMEZONE);
  console.log(`  ${label.padEnd(20)}: ${n ? n.toFormat("ccc, LLL d 'at' h:mm a ZZZZ") : '(unknown)'}`);
}
console.log('');

console.log('Scheduler running. Waiting for next trigger...');
console.log('(Press Ctrl+C to stop)\n');

// Keep the process alive and log a heartbeat every hour so you can
// confirm the server process is still running in your logs.
setInterval(() => {
  const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
  console.log(`[${ts}] Heartbeat — scheduler alive.`);
}, 60 * 60 * 1000);

// HTTP: health + public review page + Google-gated manual job triggers / editor
// (Railway: enable a public URL; gate with GOOGLE_OAUTH_CLIENT_ID/_SECRET + REVIEW_ADMIN_EMAILS).
if (process.env.DISABLE_MANUAL_TRIGGER_UI === 'true' || process.env.DISABLE_MANUAL_TRIGGER_UI === '1') {
  console.log('Manual trigger UI disabled (DISABLE_MANUAL_TRIGGER_UI).');
} else {
  const { startManualTriggerServer } = require('./manualTriggers');
  const port = parseInt(process.env.PORT || '8787', 10);
  // Manual triggers run per firm too. `options.firmId` (from the dashboard)
  // scopes a run to one firm for testing; otherwise all active firms run.
  startManualTriggerServer({
    port,
    runners: {
      daily: (opts) => runForAllFirms(runDailyReport, opts),
      weekly: (opts) => runForAllFirms(runWeeklyClientSentimentReport, opts),
      monthly: (opts) => runForAllFirms(runMonthlyNewsletterInsightsReport, opts),
      missed: (opts) => runForAllFirms(runMissedClientCallReport, opts),
      review: (opts) => runForAllFirms(runReviewIntelligenceReport, opts),
    },
  });
}
