#!/usr/bin/env node
// Watches Vanilla Sky's public booking-widget endpoint across several
// Tbilisi-area routes and alerts the moment dates from the target start
// date onward appear on ANY of them ("shotgun" mode: broad dates, broad
// destinations, to maximize the odds of catching a bookable seat).
//
// This calls the exact same JSON endpoint the site's own booking page calls
// in the browser (see themes/contrib/sky/js/global.js: `$.get('/custom/check-flight/...')`).
// It is one lightweight read-only GET request per route, run at most every
// 15 minutes by the GitHub Actions schedule - the same traffic pattern as a
// person loading the page and picking a route, just automated.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://ticket.vanillasky.ge';

// All real Tbilisi-area departures found via /custom/check-dest/<id>.
// Location IDs: 1 Tbilisi, 2 Ambrolauri, 4 Batumi, 5 Kutaisi, 6 Mestia, 7 Natakhtari.
// Flights physically leave from Natakhtari (free shuttle from central Tbilisi).
// Tbilisi->Batumi exists as a route in their system but currently returns no
// dates at all - kept in the list in case it activates; costs one extra
// lightweight request per run.
const ROUTES = [
  { from: 7, to: 6, label: 'Natakhtari -> Mestia' },
  { from: 7, to: 2, label: 'Natakhtari -> Ambrolauri' },
  { from: 7, to: 4, label: 'Natakhtari -> Batumi' },
  { from: 1, to: 4, label: 'Tbilisi -> Batumi' },
];

const WINDOW_START = process.env.WINDOW_START || '2026-08-08';
// No upper bound by default: any date from WINDOW_START onward counts.
const WINDOW_END = process.env.WINDOW_END || null;
const STATE_PATH = path.join(process.cwd(), 'docs', 'data', 'state.json');
const HEARTBEAT_COMMIT_HOURS = 6;

const USER_AGENT =
  'VanillaSkyRouteWatcher/1.0 (personal, non-commercial availability checker; runs every 15 min)';

function inWindow(dateStr) {
  return dateStr >= WINDOW_START && (!WINDOW_END || dateStr <= WINDOW_END);
}

function isEarlyAugustBeforeWindow(dateStr) {
  return dateStr.startsWith('2026-08') && dateStr < WINDOW_START;
}

function routeKey(route) {
  return `${route.from}-${route.to}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function spokenDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      notifiedWindowDates: parsed.notifiedWindowDates || {},
      notifiedEarlyAugust: parsed.notifiedEarlyAugust || {},
      consecutiveFailures: parsed.consecutiveFailures || 0,
      lastCommittedAt: parsed.lastCommittedAt || null,
    };
  } catch {
    return { notifiedWindowDates: {}, notifiedEarlyAugust: {}, consecutiveFailures: 0, lastCommittedAt: null };
  }
}

async function fetchAvailability(route) {
  const url = `${SITE}/custom/check-flight/${route.from}/${route.to}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.from) || !Array.isArray(data.to)) {
      throw new Error('Unexpected response shape: ' + JSON.stringify(data).slice(0, 200));
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, reason: 'not configured' };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false }),
  });
  if (!res.ok) return { sent: false, reason: `HTTP ${res.status}: ${await res.text()}` };
  return { sent: true };
}

async function sendEmail(subject, text) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_TO) {
    return { sent: false, reason: 'not configured' };
  }
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.default.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: Number(SMTP_PORT || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({ from: SMTP_USER, to: ALERT_EMAIL_TO, subject, text });
  return { sent: true };
}

async function sendPhoneCall(spokenMessage) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) {
    return { sent: false, reason: 'not configured' };
  }
  const say = escapeXml(spokenMessage);
  const twiml = `<Response><Say voice="alice">${say}</Say><Pause length="1"/><Say voice="alice">${say}</Say></Response>`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: new URLSearchParams({ To: TWILIO_TO_NUMBER, From: TWILIO_FROM_NUMBER, Twiml: twiml }),
  });
  if (!res.ok) return { sent: false, reason: `HTTP ${res.status}: ${await res.text()}` };
  return { sent: true };
}

async function notifyAll(subject, text) {
  const results = await Promise.allSettled([sendTelegram(text), sendEmail(subject, text)]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { sent: false, reason: String(r.reason) }));
}

async function notifyUrgent(subject, text, spokenMessage) {
  const results = await Promise.allSettled([sendTelegram(text), sendEmail(subject, text), sendPhoneCall(spokenMessage)]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { sent: false, reason: String(r.reason) }));
}

async function checkRoute(route, dryRunAlert) {
  let data = null;
  let error = null;
  try {
    data = dryRunAlert && route === ROUTES[0] ? { from: [WINDOW_START], to: [WINDOW_START] } : await fetchAvailability(route);
  } catch (e) {
    error = e;
  }
  const allDates = data ? [...new Set([...data.from, ...data.to])].sort() : [];
  const matched = allDates.filter(inWindow);
  const earlyAugust = allDates.filter(isEarlyAugustBeforeWindow);
  return {
    route,
    error,
    availableDatesFrom: data ? data.from : null,
    availableDatesTo: data ? data.to : null,
    matched,
    earlyAugust,
  };
}

async function main() {
  const dryRunAlert = process.env.TEST_ALERT === 'true';
  const state = await loadState();

  const results = [];
  for (const route of ROUTES) {
    results.push(await checkRoute(route, dryRunAlert));
  }

  const allFailed = results.every((r) => r.error);
  const anySucceeded = results.some((r) => !r.error);

  // Collect new matches across all routes for a single combined alert.
  const newMatchLines = [];
  const newSpokenLines = [];
  const newEarlyAugustLines = [];
  for (const r of results) {
    if (r.error) continue;
    const key = routeKey(r.route);
    const alreadyNotified = new Set(state.notifiedWindowDates[key] || []);
    const fresh = r.matched.filter((d) => !alreadyNotified.has(d));
    if (fresh.length > 0) {
      newMatchLines.push(`*${r.route.label}*: ${fresh.join(', ')}`);
      newSpokenLines.push(`${r.route.label.replace(' -> ', ' to ')} on ${fresh.map(spokenDate).join(', ')}`);
      state.notifiedWindowDates[key] = [...alreadyNotified, ...fresh];
    }
    if (r.earlyAugust.length > 0 && !state.notifiedEarlyAugust[key]) {
      newEarlyAugustLines.push(`${r.route.label}: ${r.earlyAugust.join(', ')}`);
      state.notifiedEarlyAugust[key] = true;
    }
  }

  if (newMatchLines.length > 0) {
    const msg =
      `*Vanilla Sky - flight available!*\n\n` +
      `Date(s) from ${WINDOW_START} onward just appeared:\n\n` +
      newMatchLines.join('\n') +
      `\n\nBook now: ${SITE}/en/tickets\n` +
      `Backup contact: (+995) 032 242 84 28 / info@vanillasky.ge\n\n` +
      `Only ~16 seats per flight - go now.`;
    const spokenMessage =
      `Vanilla Sky alert. Tickets just opened for ${newSpokenLines.join('; ')}. ` +
      `Book immediately at ticket dot vanilla sky dot G E. Only about 16 seats available.`;
    await notifyUrgent('Vanilla Sky: dates open!', msg, spokenMessage);
  } else if (newEarlyAugustLines.length > 0) {
    const msg =
      `*Vanilla Sky - early August calendar opened*\n\n` +
      `Nothing from ${WINDOW_START} onward yet, but earlier August dates just appeared:\n\n` +
      newEarlyAugustLines.join('\n') +
      `\n\nCheck / adjust here: ${SITE}/en/tickets`;
    await notifyAll('Vanilla Sky: early August calendar opened', msg);
  }

  if (allFailed) {
    const failures = (state.consecutiveFailures || 0) + 1;
    state.consecutiveFailures = failures;
    if (failures === 4) {
      await notifyAll(
        'Vanilla Sky watcher: having trouble',
        `The watcher has failed to reach ${SITE} on every route for the last ~hour (latest error: ${results[0].error?.message}). ` +
          `It will keep retrying automatically - this is just a heads up in case the site changed or is down.`
      );
    }
  } else if (anySucceeded) {
    state.consecutiveFailures = 0;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    targetWindow: { start: WINDOW_START, end: WINDOW_END },
    status: allFailed ? 'error' : newMatchLines.length > 0 || results.some((r) => r.matched.length > 0) ? 'released_in_window' : 'not_yet',
    consecutiveFailures: state.consecutiveFailures,
    checkUrl: `${SITE}/en/tickets`,
    routes: results.map((r) => ({
      label: r.route.label,
      fromId: r.route.from,
      toId: r.route.to,
      error: r.error ? String(r.error.message || r.error) : null,
      availableDatesFrom: r.availableDatesFrom ?? state.lastRouteData?.[routeKey(r.route)]?.from ?? [],
      availableDatesTo: r.availableDatesTo ?? state.lastRouteData?.[routeKey(r.route)]?.to ?? [],
      matchedInWindow: r.matched,
    })),
    notifiedWindowDates: state.notifiedWindowDates,
    notifiedEarlyAugust: state.notifiedEarlyAugust,
    lastCommittedAt: state.lastCommittedAt,
  };

  console.log(JSON.stringify(summary, null, 2));

  const prevRaw = await readFile(STATE_PATH, 'utf8').catch(() => null);
  const meaningfulChange =
    !prevRaw ||
    (() => {
      try {
        const prev = JSON.parse(prevRaw);
        return (
          JSON.stringify(prev.routes?.map((r) => ({ f: r.availableDatesFrom, t: r.availableDatesTo }))) !==
            JSON.stringify(summary.routes.map((r) => ({ f: r.availableDatesFrom, t: r.availableDatesTo }))) ||
          prev.status !== summary.status
        );
      } catch {
        return true;
      }
    })();

  const hoursSinceCommit = state.lastCommittedAt
    ? (Date.now() - new Date(state.lastCommittedAt).getTime()) / 36e5
    : Infinity;
  const shouldWrite = meaningfulChange || hoursSinceCommit >= HEARTBEAT_COMMIT_HOURS;

  if (shouldWrite) {
    summary.lastCommittedAt = new Date().toISOString();
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(summary, null, 2) + '\n');
    console.log('::notice::state.json updated (write=true)');
  } else {
    console.log('::notice::no meaningful change, skipping commit');
  }

  process.env.GITHUB_OUTPUT &&
    (await writeFile(process.env.GITHUB_OUTPUT, `changed=${shouldWrite}\n`, { flag: 'a' }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
