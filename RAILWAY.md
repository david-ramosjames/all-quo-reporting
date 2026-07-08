# Deploy on Railway

This app runs as a **long-running worker**: `npm start` launches `scheduler.js`, which triggers **Daily Intake & Lead Report** + Quo CSV on `CRON_SCHEDULE`, **Weekly Client Sentiment** on `WEEKLY_SENTIMENT_CRON` (default **Friday 8:00 PM**), and **Monthly Newsletter Insights** (trailing 30 days, **AI call summaries** for clients + leads) on `MONTHLY_INSIGHTS_CRON` (default **1:00 AM on the 1st** of each month in `TIMEZONE`). Default daily time is **7:00 AM** (all in `TIMEZONE`, e.g. `America/Chicago` for Central).

It also triggers the **Missed Client Call Report** on `MISSED_CLIENT_CALLS_CRON` (default **7:00 AM**) and **Review Intelligence V1** on `REVIEW_INTELLIGENCE_CRON` (default **6:00 PM**). Review Intelligence reads the last 24h of client calls + SMS, evaluates each active client's overall journey, scores them **0–100** as a Google-review candidate (leveraging the existing sentiment analysis as a disqualifying gate), records qualified clients in the **`review_opportunities`** table, and posts the highest-confidence picks to the `REVIEW_SLACK_CHANNEL` Slack channel.

The same process also serves a **small web UI** (on `PORT`) to manually run those jobs without waiting for cron: open `/`, enter `ADMIN_TRIGGER_TOKEN`, and click a job. Railway must expose **public networking** (generate a domain) so you can reach it; set a strong `ADMIN_TRIGGER_TOKEN` in variables.

**Review landing page:** the same HTTP server serves a branded, mobile-first review page at **`/review`** (public) and a token-gated copy editor at **`/review/edit`**. Edit the copy (headline, body, button text, Google Review URL, footer) via that form, by editing `review-landing.json`, or with the `REVIEW_PAGE_*` / `REVIEW_GOOGLE_URL` env vars (env vars win — best on Railway since its filesystem is ephemeral).

## 1. Push the repo to GitHub

Ensure `.env` is **not** committed (it is listed in `.gitignore`).

## 2. Create a Railway project

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select this repository.
2. Railway will detect Node via Nixpacks and use `railway.toml` / `npm start`.

## 3. Configure environment variables

In the service → **Variables**, add every key from your local `.env` (copy from `.env.example` as a checklist):

- Quo, OpenAI, `EMAIL_FROM` / `EMAIL_TO`, Slack, Google OAuth (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — used for **both** Sheets and Gmail send), `GOOGLE_SHEETS_ID`, range/columns, etc.
- Optional: `QUO_PHONE_NUMBERS` restricts which OpenPhone lines are fetched for **daily** CSV. **Weekly and monthly** automatically merge **RJL Outbound** and **RJL Transfers** (`+15125005266`, `+15126300907`) into that list when a restriction is set, unless `QUO_PHONE_NUMBERS_WEEKLY_MONTHLY_EXTRA=` is set empty to disable (or override with your own comma list).

**Scheduler:**

| Variable                   | Example           | Meaning                                                    |
|----------------------------|-------------------|------------------------------------------------------------|
| `CRON_SCHEDULE`            | `0 7 * * *`       | Daily — **07:00** each day (intake & lead report + yesterday CSV) |
| `WEEKLY_SENTIMENT_CRON`    | `0 20 * * 5`      | Weekly — **20:00 Fridays** (`5` = Friday; 7-day sentiment) |
| `MONTHLY_INSIGHTS_CRON`    | `0 1 1 * *`       | Monthly — **01:00 on day 1** (30-day newsletter theme email) |
| `MISSED_CLIENT_CALLS_CRON` | `0 7 * * *`       | Daily — **07:00** (unreturned missed client calls email)   |
| `REVIEW_INTELLIGENCE_CRON` | `0 18 * * *`      | Daily — **18:00** (Google-review candidates → Slack)       |
| `REVIEW_SLACK_CHANNEL`     | `review-opportunities` | Slack channel for the daily review report (bot must be a member) |
| `GOOGLE_REVIEW_OPPORTUNITIES_SHEET_ID` | (sheet id) | Backend `review_opportunities` table tab (optional; Slack still posts without it) |
| `TIMEZONE`                 | `America/Chicago` | When crons fire + “yesterday” for daily fetch              |
| `ADMIN_TRIGGER_TOKEN`      | (long random)    | Required for manual triggers from `/` and `POST /api/trigger` |
| `PORT`                     | (set by Railway) | HTTP listener for health + manual UI                       |
| `DISABLE_MANUAL_TRIGGER_UI`| `true`           | Optional: do not bind HTTP (scheduler + crons only)       |

Cron uses **five fields**: `minute hour day-of-month month day-of-week`.  
`0 3 * * *` = 03:00 every day in `TIMEZONE`.

To run 3 AM **UTC** instead, set `TIMEZONE=UTC` (and adjust `CRON_SCHEDULE` if you still want local-firm “yesterday” — usually keep firm timezone for `TIMEZONE`).

## 4. Public URL for manual triggers (optional)

1. Service → **Settings** → **Networking** → **Generate domain** (or attach your own).
2. Add variable **`ADMIN_TRIGGER_TOKEN`** (e.g. 32+ random bytes). Without it, `/` loads but triggers return 503.
3. Visit `https://<your-domain>/` — paste the token, run a job. **`GET /health`** returns `ok` for uptime checks.

## 5. Deploy

Trigger a deploy (or push to the connected branch). Watch **Deployments → Logs**:

- You should see `Quo Report Scheduler`, daily / weekly / monthly cron lines, and hourly `Heartbeat — scheduler alive.`
- After the daily cron, logs should show `[1/6]` … `[6/6]` for the lead report. Weekly sentiment: `[1/4]` … `[4/4]` (fetches **calls + SMS**, one holistic LLM pass per **client** using **summaries**). Monthly insights: `[1/4]` … `[4/4]` (per-call theme extraction from **summaries**, transcripts optional via `MONTHLY_FETCH_TRANSCRIPTS`).

## 6. Costs & behavior

- The process stays **up 24/7** so `node-cron` can fire at 3 AM. Use a Railway plan that allows always-on workers.
- A public URL is optional; without networking, only cron + Railway shell / one-off commands can run reports.

## 7. One-off test

To run the report once without waiting for cron, use **Railway shell** or a one-off command:

```bash
node report.js
node report.js weekly
node report.js monthly
node report.js missed
node report.js review
```

(Run with the same env vars as production. `weekly` runs the 7-day client sentiment job once; `monthly` runs the 30-day newsletter insights job once; `missed` runs the missed-client-call report; `review` runs Review Intelligence once — scoring the last 24h of active clients and posting to Slack.)

## 8. Google OAuth refresh token

`GOOGLE_REFRESH_TOKEN` must be generated once (`node setup-sheets-auth.js` on your machine) and pasted into Railway variables. It carries **both** the Sheets and `gmail.send` scopes. Report emails are sent via the Gmail API over HTTPS (Railway blocks outbound SMTP on ports 25/587 on most projects, so SMTP is not used). Regenerate the token if you add/remove scopes.
