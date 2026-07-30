#!/usr/bin/env node
// Cancellation watcher for Vanilla Sky.
//
// Unlike check.mjs (which only sees whether a DATE is scheduled), this replays
// the site's actual booking search — the same POST the browser makes when you
// pick a route+date and hit search — and reads whether real SEATS are
// available. On these 16-seat flights everything sold out within the window,
// so the useful signal now is a cancellation: a date flipping from "sold out"
// back to "available". When that happens we alert immediately (Telegram + a
// real phone call) so Boris can grab the freed seat before anyone else.
//
// The search step is read-only — it lists flights, it does not create a hold
// or booking (that only happens later when you pick a specific flight and go
// to the personal-info page). So polling it is safe.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://ticket.vanillasky.ge';
const STATE_PATH = path.join(process.cwd(), 'docs', 'data', 'seat-state.json');
const UA = 'VanillaSkySeatWatcher/1.0 (personal cancellation checker; low volume)';
const HEARTBEAT_COMMIT_HOURS = 6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const spoken = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};

// Boris's real target: reach Mestia, flexible 9-14 August, 1 passenger.
// Mestia is reachable by air from Natakhtari (7) and Kutaisi (5). We only list
// dates on which each route is actually scheduled (Mestia never flies Saturdays;
// Kutaisi->Mestia runs every other day). Adjust here if the plan changes.
const WATCH = [
  { from: 7, to: 6, label: 'Natakhtari -> Mestia', dates: ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'] },
  { from: 5, to: 6, label: 'Kutaisi -> Mestia', dates: ['2026-08-10', '2026-08-12'] },
];

function keyOf(w, iso) {
  return `${w.from}-${w.to}-${iso}`;
}

async function seatAvailable(fromId, toId, iso) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    // 1. GET the search page for a fresh form_build_id (Drupal ties the POST to it).
    const g = await fetch(`${SITE}/en/tickets`, { headers: { 'User-Agent': UA }, signal: controller.signal });
    if (!g.ok) throw new Error(`GET ${g.status}`);
    const html = await g.text();
    const cookie = (g.headers.get('set-cookie') || '').split(';')[0];
    const fbid = (html.match(/name="form_build_id" value="([^"]+)"/) || [])[1];
    if (!fbid) throw new Error('no form_build_id');

    // 2. Replay the booking search for this exact route + date, 1 adult, one-way.
    const body = new URLSearchParams();
    body.set('types', '0');
    body.set('departure', String(fromId));
    body.set('arrive', String(toId));
    body.set('date_picker', fmtDate(iso));
    body.set('date_picker_arrive', '');
    body.set('person_count', '1');
    body.set('person_types[adult]', '1');
    body.set('person_types[child]', '0');
    body.set('person_types[infant]', '0');
    body.set('form_build_id', fbid);
    body.set('form_id', 'form_select_date');
    body.set('op', '');
    const p = await fetch(`${SITE}/en/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
      body: body.toString(),
      redirect: 'manual',
      signal: controller.signal,
    });
    const loc = p.headers.get('location');
    if (!loc) throw new Error(`no redirect (status ${p.status})`);
    const url = loc.startsWith('http') ? loc : SITE + loc;

    // 3. Read the results page: "no available tickets" = sold out; a price = seats.
    const f = await fetch(url, { headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) }, signal: controller.signal });
    const t = await f.text();
    const soldOut = /no available tickets/i.test(t);
    const price = (t.match(/([0-9]+)\s*GEL/) || [])[0] || null;
    return { available: !soldOut, price };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false }),
  });
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function phoneCall(spokenMessage) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) return;
  const say = escapeXml(spokenMessage);
  const twiml = `<Response><Say voice="alice">${say}</Say><Pause length="1"/><Say voice="alice">${say}</Say></Response>`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: new URLSearchParams({ To: TWILIO_TO_NUMBER, From: TWILIO_FROM_NUMBER, Twiml: twiml }),
  });
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    return {
      alerted: parsed.alerted || {}, // key -> true while a seat is available and already alerted
      consecutiveFailures: parsed.consecutiveFailures || 0,
      lastCommittedAt: parsed.lastCommittedAt || null,
    };
  } catch {
    return { alerted: {}, consecutiveFailures: 0, lastCommittedAt: null };
  }
}

async function main() {
  const dryRun = process.env.TEST_ALERT === 'true';
  const state = await loadState();

  const results = [];
  let anySucceeded = false;
  let allFailed = true;

  for (const w of WATCH) {
    for (const iso of w.dates) {
      const key = keyOf(w, iso);
      try {
        const r = dryRun && w === WATCH[0] && iso === w.dates[0] ? { available: true, price: '90 GEL' } : await seatAvailable(w.from, w.to, iso);
        anySucceeded = true;
        allFailed = false;
        results.push({ w, iso, key, ...r, error: null });
      } catch (e) {
        results.push({ w, iso, key, available: null, price: null, error: String(e.message || e) });
      }
    }
  }

  // Figure out which seats are newly available (a cancellation freed one up).
  const freshlyAvailable = [];
  for (const r of results) {
    if (r.error) continue; // don't touch state on a failed check
    if (r.available && !state.alerted[r.key]) {
      freshlyAvailable.push(r);
      state.alerted[r.key] = true;
    } else if (!r.available && state.alerted[r.key]) {
      delete state.alerted[r.key]; // gone again — allow a future re-open to re-alert
    }
  }

  if (freshlyAvailable.length > 0) {
    const lines = freshlyAvailable.map((r) => `*${r.w.label}* — ${r.iso}${r.price ? ` (${r.price})` : ''}`);
    const msg =
      `🔴 *SEAT AVAILABLE — cancellation!*\n\n` +
      `A seat just opened up:\n\n` +
      lines.join('\n') +
      `\n\n👉 Book NOW (open in *Safari*, not Arc — Arc's date picker breaks):\n` +
      `${SITE}/en/tickets\n\n` +
      `Pick the route + date above, 1 adult, search, book.\n` +
      `Backup: call (+995) 032 242 84 28.`;
    await sendTelegram(msg);
    const spokenList = freshlyAvailable.map((r) => `${r.w.label.replace(' -> ', ' to ')} on ${spoken(r.iso)}`).join('; ');
    await phoneCall(`Vanilla Sky cancellation alert. A seat just opened for ${spokenList}. Book immediately at ticket dot vanilla sky dot G E.`);
  }

  if (allFailed) {
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    if (state.consecutiveFailures === 4) {
      await sendTelegram(
        `⚠️ Vanilla Sky seat-watcher: every check failed for ~1 hour (latest: ${results[0]?.error}). ` +
          `The booking form may have changed. It keeps retrying — heads up in case you want to check manually.`
      );
    }
  } else if (anySucceeded) {
    state.consecutiveFailures = 0;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    watching: WATCH.map((w) => ({ label: w.label, dates: w.dates })),
    seats: results.map((r) => ({ label: r.w.label, date: r.iso, available: r.available, price: r.price, error: r.error })),
    availableNow: results.filter((r) => r.available).map((r) => `${r.w.label} ${r.iso}`),
    consecutiveFailures: state.consecutiveFailures,
    alerted: state.alerted,
    lastCommittedAt: state.lastCommittedAt,
  };

  console.log(JSON.stringify(summary, null, 2));

  // Commit when something meaningful changed, or as a periodic heartbeat.
  const prevRaw = await readFile(STATE_PATH, 'utf8').catch(() => null);
  const meaningfulChange =
    !prevRaw ||
    (() => {
      try {
        const prev = JSON.parse(prevRaw);
        return JSON.stringify(prev.seats) !== JSON.stringify(summary.seats);
      } catch {
        return true;
      }
    })();
  const hoursSince = state.lastCommittedAt ? (Date.now() - new Date(state.lastCommittedAt).getTime()) / 36e5 : Infinity;
  const shouldWrite = meaningfulChange || hoursSince >= HEARTBEAT_COMMIT_HOURS;

  if (shouldWrite) {
    summary.lastCommittedAt = new Date().toISOString();
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log('::notice::seat-state.json updated');
  } else {
    console.log('::notice::no change, skipping commit');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
