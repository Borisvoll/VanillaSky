# Vanilla Sky Route Watcher

Watches [Vanilla Sky](https://ticket.vanillasky.ge)'s flight booking data
across every real Tbilisi-area route and alerts the moment dates open up
from **8 August 2026 onward** (no end cap — "shotgun" mode: broad dates,
broad destinations, to maximize the odds of catching a bookable seat).

Vanilla Sky confirmed by email: *"Tickets for August are not yet available.
Check our website during July for information. At the moment we don't know
the exact release date."* Each flight only carries ~16 passengers, so this
exists to catch the release the moment it happens instead of hoping to
refresh the page at the right minute.

Watched routes (all real Tbilisi-area departures, found by querying their
own destination-lookup endpoint):
- Natakhtari → Mestia
- Natakhtari → Ambrolauri
- Natakhtari → Batumi
- Tbilisi → Batumi (exists in their system but currently shows no dates at
  all — kept in case it activates; costs one extra lightweight request)

## How it works

1. Their booking widget at [`/en/tickets`](https://ticket.vanillasky.ge/en/tickets)
   is a normal Drupal form. When you pick a route, its own JavaScript calls a
   public read-only endpoint — `GET /custom/check-flight/{fromId}/{toId}` —
   which returns the bookable dates for that route as JSON.
2. [`scripts/check.mjs`](scripts/check.mjs) calls that **exact same endpoint**
   once per watched route, per run.
3. A [GitHub Actions workflow](.github/workflows/watch.yml) runs that script
   **every 15 minutes**, on GitHub's servers — no computer of yours needs to
   stay on.
4. If any date from **2026-08-08 onward** appears on *any* watched route, it
   immediately sends you a Telegram message, email, **and a phone call that
   reads out the route/date** (real ringing call — hard to miss even in
   silent mode), naming the exact route and date(s), with a direct link to
   book. If an earlier-August date (before the 8th) opens instead, it sends
   a lower-priority Telegram/email heads-up only (no call), since that's
   still a strong signal the release has started but isn't yet actionable.
5. Current status is always visible at the [status dashboard](docs/index.html)
   (`docs/data/state.json`, served via GitHub Pages), broken down per route,
   so you can also just glance at a page instead of waiting for a notification.

### Why this is safe / won't cause trouble

- It's **one small GET request every 15 minutes** to a public JSON endpoint —
  the same request your own browser makes when you open the booking page.
  Nothing here submits forms, creates bookings, or touches any account.
- `robots.txt` does not disallow this path.
- No login, no scraping of rendered pages, no browser automation hammering
  their server — just the lightweight data call their own front-end relies on.
- The watcher only *reads*. Booking the actual seat is still a manual step
  you do yourself on their site (or by phone), on purpose — this tool's job
  is purely "tell you the second it's possible," not to auto-purchase anything.

## One-time setup

### 1. Install dependencies (only needed if testing locally)
```bash
npm install
```

### 2. Telegram alerts (recommended, ~2 minutes)
1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`,
   follow the prompts. You'll get a **bot token** like `123456:ABC-...`.
2. Send any message to your new bot (e.g. "hi") so it's allowed to message you back.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser —
   find `"chat":{"id":  <NUMBER>` in the response. That number is your **chat ID**.
4. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**,
   add:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

### 3. Email alerts (optional, in addition to or instead of Telegram)
Add these repository secrets:
- `SMTP_HOST`, `SMTP_PORT` (e.g. `465`), `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_TO`

Easiest reliable option: a Gmail account with an
[App Password](https://myaccount.google.com/apppasswords) (`SMTP_HOST=smtp.gmail.com`,
`SMTP_PORT=465`, `SMTP_USER`/`SMTP_PASS` = that Gmail address/app password).
Outlook/Hotmail personal accounts have largely dropped basic-auth SMTP, so
they're not a reliable `SMTP_*` choice here even though your alert address
(`ALERT_EMAIL_TO`) can absolutely still be your Hotmail address — it's only
the *sending* account that needs to support app passwords.

If you skip this, Telegram-only is perfectly fine.

### 4. Phone call alerts (optional, only fires for actionable in-window matches)
Uses [Twilio](https://www.twilio.com/try-twilio) to place a real call that reads
out the route and date(s). Free-trial credit comfortably covers this use case
(a handful of calls at most) — trial accounts simply can't place further calls
once credit runs out, they don't auto-charge you.

1. Sign up at twilio.com (a card on file is required by Twilio for fraud
   prevention, but nothing is charged while you're on trial credit).
2. From the Twilio Console dashboard, copy your **Account SID** and **Auth Token**.
3. Get a phone number: Twilio trial accounts include one free number
   (Console → Phone Numbers → Manage → Buy a number, trial credit covers it).
4. Verify your own phone number: Console → Phone Numbers → Verified Caller IDs
   → add your number (trial accounts can only call verified numbers).
5. Add these repository secrets:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER` (the Twilio number, e.g. `+1...`)
   - `TWILIO_TO_NUMBER` (your real phone number, e.g. `+31...` or `+995...`)

If you skip this, Telegram + email alerts still work fine on their own.

### 5. Enable the dashboard (optional)
**Settings → Pages → Source: Deploy from a branch → Branch: `main` → Folder: `/docs`**.
Your dashboard will be live at `https://<you>.github.io/<repo>/`.

### 6. Turn it on
The workflow runs automatically once it's on the default branch (schedules
only fire from there). You can also trigger it manually any time from the
**Actions** tab → "Watch Vanilla Sky availability" → **Run workflow**.

### 7. Test the alert pipeline
Run the workflow manually from the Actions tab with **"Send a fake alert"**
checked. This fakes a match for `2026-08-08` on the Mestia route and sends a
real Telegram/email/phone-call alert through your configured channels,
without touching real data — good for confirming secrets are wired up
correctly before it matters. (It only fires once per route+date per the
dedup logic — clear `notifiedWindowDates` in `docs/data/state.json` to re-test.)

## Adjusting the target window or routes

Edit the top of `scripts/check.mjs`:
- `WINDOW_START` (env override: `WINDOW_START`) — currently `2026-08-08`.
- `WINDOW_END` (env override: `WINDOW_END`) — currently unset (no upper
  bound: any date from `WINDOW_START` onward counts as a match).
- `ROUTES` — the list of `{ from, to, label }` route ID pairs being watched.
  Other location IDs seen on the site: `1` Tbilisi, `2` Ambrolauri, `4`
  Batumi, `5` Kutaisi, `6` Mestia, `7` Natakhtari. (Tbilisi itself isn't a
  real departure point for most routes in their system — flights leave from
  Natakhtari, with a free shuttle from central Tbilisi.)

## If the watcher ever breaks

The site's structure could change at any time since this isn't an official
API. If checks start failing repeatedly (4+ in a row, ~1 hour), you'll get a
one-time Telegram/email warning so you know to check manually. Always-safe
fallbacks:
- Site: https://ticket.vanillasky.ge/en/tickets
- Phone: (+995) 032 242 84 28
- Email: info@vanillasky.ge
