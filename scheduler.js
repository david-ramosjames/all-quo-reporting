require('dotenv').config();
const cron = require('node-cron');
const {
  runDailyReport,
  runWeeklyClientSentimentReport,
  runMonthlyNewsletterInsightsReport,
  runMissedClientCallReport,
  runReviewIntelligenceReport,
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
      await runDailyReport();
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
      await runWeeklyClientSentimentReport();
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
      await runMonthlyNewsletterInsightsReport();
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
      await runMissedClientCallReport();
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
      await runReviewIntelligenceReport();
    } catch (err) {
      console.error(`[${ts}] Review Intelligence report failed:`, err.message);
    }
  },
  { timezone: TIMEZONE }
);

console.log('Scheduler running. Waiting for next trigger...');
console.log('(Press Ctrl+C to stop)\n');

// Keep the process alive and log a heartbeat every hour so you can
// confirm the server process is still running in your logs.
setInterval(() => {
  const ts = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
  console.log(`[${ts}] Heartbeat — scheduler alive.`);
}, 60 * 60 * 1000);

// HTTP: health + token-gated manual job triggers (Railway: enable public URL, set ADMIN_TRIGGER_TOKEN).
if (process.env.DISABLE_MANUAL_TRIGGER_UI === 'true' || process.env.DISABLE_MANUAL_TRIGGER_UI === '1') {
  console.log('Manual trigger UI disabled (DISABLE_MANUAL_TRIGGER_UI).');
} else {
  const { startManualTriggerServer } = require('./manualTriggers');
  const port = parseInt(process.env.PORT || '8787', 10);
  startManualTriggerServer({
    port,
    adminToken: process.env.ADMIN_TRIGGER_TOKEN,
    runners: {
      daily: runDailyReport,
      weekly: runWeeklyClientSentimentReport,
      monthly: runMonthlyNewsletterInsightsReport,
      missed: runMissedClientCallReport,
      review: runReviewIntelligenceReport,
    },
  });
}
