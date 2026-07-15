# Deploy on Railway

This app runs as a **long-running worker**: `npm start` launches `scheduler.js`, which triggers **Daily Intake & Lead Report** + Quo CSV on `CRON_SCHEDULE`, **Weekly Client Sentiment** on `WEEKLY_SENTIMENT_CRON` (default **Friday 8:00 PM**), and **Monthly Newsletter Insights** (trailing 30 days, **AI call summaries** for clients + leads) on `MONTHLY_INSIGHTS_CRON` (default **1:00 AM on the 1st** of each month in `TIMEZONE`). Default daily time is **7:00 AM** (all in `TIMEZONE`, e.g. `America/Chicago` for Central).

It also triggers the **Missed Client Call Report** on `MISSED_CLIENT_CALLS_CRON` (default **7:00 AM**) and **Review Intelligence V1** on `REVIEW_INTELLIGENCE_CRON` (default **6:00 PM**). Review Intelligence reads the last 24h of client calls + SMS, evaluates each active client's overall journey, scores them **0–100** as a Google-review candidate (leveraging the existing sentiment analysis as a disqualifying gate), records qualified clients in the **`review_opportunities`** table, creates a **trackable branded review link** for each (`/r/<token>`), and posts the highest-confidence picks — with their links — to the `REVIEW_SLACK_CHANNEL` Slack channel. Link opens and Google/Text/Call clicks are tracked at `/review/analytics`. **The app never auto-texts clients** — it posts one Slack message per candidate, and a staff **✅ reaction (or a threaded “approve” reply)** on that message texts the client their link via Quo (see the Slack Events setup below).

The same process also serves a **small web UI** (on `PORT`) to manually run those jobs without waiting for cron: open `/`, enter `ADMIN_TRIGGER_TOKEN`, and click a job. Railway must expose **public networking** (generate a domain) so you can reach it; set a strong `ADMIN_TRIGGER_TOKEN` in variables.

**Review landing page:** the same HTTP server serves a branded, mobile-first Google-review page at **`/review`** (public) and a full token-gated **admin editor** at **`/review/edit`**. The admin edits everything — logo, brand/accent/CTA colors, background, headline/body, Google Review URL, helper text, the optional Laura note (image + quote, show/hide), the support section (Text/Call labels + numbers), footer, and “Available 24/7”. Logos/headshots can be a URL or an in-browser upload (embedded into the page). Personalize the headline per client with a query param: `/review?name=Maria` → “Thank you, Maria.”. Config lives in `review-landing.json`; `REVIEW_PAGE_*` env vars override it. Because Railway’s filesystem is ephemeral, make editor changes durable by setting the env vars **or** mounting a volume and pointing `REVIEW_LANDING_CONFIG_PATH` at a file on it.

**Custom domain for client review links (`reviews.ramosjames.com`):** never send clients the raw Railway URL. Point a branded subdomain at the app: in Railway → service → **Settings → Networking → Custom Domain**, add `reviews.ramosjames.com`; Railway shows a **CNAME** target — create that CNAME at your DNS provider (`reviews` → the Railway target). Once it verifies, set `REVIEW_DOMAIN=reviews.ramosjames.com` and `REVIEW_PUBLIC_BASE_URL=https://reviews.ramosjames.com`. The app serves the review page for **any** host, so the Railway URL keeps working for internal testing. Client links look like `https://reviews.ramosjames.com/r/<token>` — the token identifies the request with no case number or name in the URL. Opens and Google/Text/Call clicks are tracked (hashed IPs only) and visible at **`/review/analytics`**. Adding more firms later is just more rows in the `firm_settings` tab (each with its own `review_domain`).

**Editor access — Google sign-in:** by default `/review/edit` is gated by `ADMIN_TRIGGER_TOKEN`. To gate it with **Sign in with Google** restricted to your firm instead, create a **Web application** OAuth client in Google Cloud Console (the `setup-sheets-auth.js` client is a *Desktop* client and won’t work for a browser login), add the redirect URI `https://<your-domain>/review/auth/callback`, then set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` and `REVIEW_ADMIN_EMAILS` (and/or `REVIEW_ADMIN_DOMAIN`). Once those are set, the editor requires an authorized Google account; the public `/review` page stays open.

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

## 5b. Datastore — Postgres (recommended) vs Sheets

The review system (firm settings, trackable links, click events) uses **Postgres when `DATABASE_URL` is set**, otherwise Google Sheets. Postgres is the more stable choice — atomic click counters and no spreadsheet write limits. On Railway: **New → Database → Add PostgreSQL**; Railway injects `DATABASE_URL` into the service. Tables (`firm_settings`, `review_requests`, `review_request_events`) are created automatically on first use. No `DATABASE_URL` → it falls back to the `GOOGLE_REVIEW_SHEET_ID` sheet, and firm settings/editor edits fall back to `review-landing.json`.

## 5c. Slack approval-to-send (Events API)

The daily Slack post shows one message per review candidate. Approving one texts that client their link. To enable:

1. In your Slack app → **Event Subscriptions** → turn on, set the **Request URL** to `https://<your-domain>/slack/events` (it must return Slack's challenge — the app handles that once `SLACK_SIGNING_SECRET` is set).
2. Subscribe to bot events **`reaction_added`** and **`message.channels`**.
3. **OAuth & Permissions** → add scopes **`reactions:read`**, **`channels:history`**, **`chat:write`**; reinstall the app.
4. Set env: **`SLACK_SIGNING_SECRET`** (Slack app → Basic Information), **`QUO_SEND_FROM`** (your Quo line, E.164 or PN id). Optionally `REVIEW_APPROVE_EMOJI` (default `white_check_mark`).

Then: a ✅ reaction (or a threaded **approve** reply) on a candidate message texts the client the **branded review page** once (idempotent), and the bot replies in-thread to confirm. Staff can also send from **`/review/analytics`**. Nothing is ever sent automatically.

## 5d. Slack review buttons (Interactivity)

Each review candidate card also shows buttons — **Send branded page**, **Send Google / Facebook / Apple / Yelp** (only platforms with a URL set on the firm), and **Do not send** — that text the client the matching link with no copy/paste. To enable the buttons:

1. In your Slack app → **Interactivity & Shortcuts** → turn **On**, set the **Request URL** to `https://<your-domain>/slack/interactivity`.
2. That's it — it reuses the same **`SLACK_SIGNING_SECRET`** and **`chat:write`** scope as above (add `chat:write` if you haven't). No new events to subscribe to.

Per firm, set the platform URLs in **`/review/firms`** (Review section): Google / Facebook / Apple / Yelp. A **direct** send texts a branded short link (`/r/<token>/<platform>`) that redirects straight to that platform — one click for the client, and the click is still tracked. **Send branded page** texts the landing page where the client picks a platform. Until the Interactivity Request URL is set, the buttons are simply inert (the ✅ reaction still works).

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
