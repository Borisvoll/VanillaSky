#!/usr/bin/env node
// Watches Vanilla Sky's public booking-widget endpoint for Natakhtari -> Mestia
// availability and alerts the moment dates in the target window appear.
//
// This calls the exact same JSON endpoint the site's own booking page calls
// in the browser (see themes/contrib/sky/js/global.js: `$.get('/custom/check-flight/...')`).
// It is a single lightweight read-only GET request, run at most every 15
// minutes by the GitHub Actions schedule - the same traffic pattern as a
// person loading the page and picking a route, just automated.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SITE = 'https://ticket.vanillasky.ge';
const FROM_ID = 7; // Natakhtari
const TO_ID = 6; // Mestia
const WINDOW_START = process.env.WINDOW_START || '2026-08-10';
const WINDOW_END = process.env.WINDOW_END || '2026-08-15';
const STATE_PATH = path.join(process.cwd(), 'docs', 'data', 'state.json');
const HEARTBEAT_COMMIT_HOURS = 6;

const USER_AGENT =
  'VanillaSkyMestiaWatcher/1.0 (personal, non-commercial availability checker; runs every 15 min)';

function inWindow(dateStr) {
  return dateStr >= WINDOW_START && dateStr <= WINDOW_END;
}

function isAugust2026(dateStr) {
  return dateStr.startsWith('2026-08');
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      notifiedWindowDates: [],
      notifiedAugustOpen: false,
      consecutiveFailures: 0,
      lastCommittedAt: null,
    };
  }
}

async function fetchAvailability() {
  const url = `${SITE}/custom/check-flight/${FROM_ID}/${TO_ID}`;
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
  await transport.sendMail({
    from: SMTP_USER,
    to: ALERT_EMAIL_TO,
    subject,
    text,
  });
  return { sent: true };
}

async function notifyAll(subject, text) {
  const results = await Promise.allSettled([sendTelegram(text), sendEmail(subject, text)]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { sent: false, reason: String(r.reason) }));
}

function summarize(state, data, matched, newMatches, error) {
  return {
    generatedAt: new Date().toISOString(),
    route: { from: 'Natakhtari', to: 'Mestia', fromId: FROM_ID, toId: TO_ID },
    targetWindow: { start: WINDOW_START, end: WINDOW_END },
    status: error ? 'error' : matched.length > 0 ? 'released_in_window' : 'not_yet',
    error: error ? String(error.message || error) : null,
    availableDatesFrom: data ? data.from : state.lastAvailableDatesFrom || [],
    availableDatesTo: data ? data.to : state.lastAvailableDatesTo || [],
    matchedInWindow: matched,
    newlyNotified: newMatches,
    consecutiveFailures: error ? (state.consecutiveFailures || 0) + 1 : 0,
    checkUrl: `${SITE}/en/tickets`,
  };
}

async function main() {
  const dryRunAlert = process.env.TEST_ALERT === 'true';
  const state = await loadState();
  let data = null;
  let error = null;

  try {
    data = dryRunAlert
      ? { from: [WINDOW_START], to: [WINDOW_START] }
      : await fetchAvailability();
  } catch (e) {
    error = e;
  }

  const allDates = data ? [...new Set([...data.from, ...data.to])].sort() : [];
  const matched = allDates.filter(inWindow);
  const anyAugust = allDates.filter(isAugust2026);

  const previouslyNotified = new Set(state.notifiedWindowDates || []);
  const newMatches = matched.filter((d) => !previouslyNotified.has(d));

  if (!error && newMatches.length > 0) {
    const msg =
      `*Vanilla Sky - Mestia flight available!*\n\n` +
      `Date(s) in your window (${WINDOW_START} to ${WINDOW_END}) just appeared:\n` +
      newMatches.map((d) => `- *${d}*`).join('\n') +
      `\n\nBook now: ${SITE}/en/tickets\n` +
      `Backup contact: (+995) 032 242 84 28 / info@vanillasky.ge\n\n` +
      `Only 16 seats per flight - go now.`;
    await notifyAll('Vanilla Sky: Mestia dates open!', msg);
    state.notifiedWindowDates = [...previouslyNotified, ...newMatches];
  } else if (!error && anyAugust.length > 0 && !state.notifiedAugustOpen) {
    const msg =
      `*Vanilla Sky - August calendar opened*\n\n` +
      `No dates in your exact window (${WINDOW_START} to ${WINDOW_END}) yet, but August dates just appeared:\n` +
      anyAugust.map((d) => `- ${d}`).join('\n') +
      `\n\nCheck / adjust here: ${SITE}/en/tickets`;
    await notifyAll('Vanilla Sky: August calendar opened', msg);
    state.notifiedAugustOpen = true;
  } else if (error) {
    const failures = (state.consecutiveFailures || 0) + 1;
    if (failures === 4) {
      await notifyAll(
        'Vanilla Sky watcher: having trouble',
        `The watcher has failed to reach ${SITE} for the last ~hour (latest error: ${error.message}). ` +
          `It will keep retrying automatically - this is just a heads up in case the site changed or is down.`
      );
    }
  }

  const summary = summarize(state, data, matched, newMatches, error);
  state.consecutiveFailures = summary.consecutiveFailures;
  if (data) {
    state.lastAvailableDatesFrom = data.from;
    state.lastAvailableDatesTo = data.to;
  }

  const prevRaw = await readFile(STATE_PATH, 'utf8').catch(() => null);
  const meaningfulChange =
    !prevRaw ||
    (() => {
      try {
        const prev = JSON.parse(prevRaw);
        return (
          JSON.stringify(prev.availableDatesFrom) !== JSON.stringify(summary.availableDatesFrom) ||
          JSON.stringify(prev.availableDatesTo) !== JSON.stringify(summary.availableDatesTo) ||
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

  console.log(JSON.stringify(summary, null, 2));

  if (shouldWrite) {
    state.lastCommittedAt = new Date().toISOString();
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(
      STATE_PATH,
      JSON.stringify({ ...summary, notifiedWindowDates: state.notifiedWindowDates || [], notifiedAugustOpen: !!state.notifiedAugustOpen, consecutiveFailures: state.consecutiveFailures, lastCommittedAt: state.lastCommittedAt }, null, 2) + '\n'
    );
    console.log('::notice::state.json updated (write=true)');
  } else {
    console.log('::notice::no meaningful change, skipping commit');
  }

  // Signal to the workflow whether there's something to commit.
  process.env.GITHUB_OUTPUT &&
    (await writeFile(process.env.GITHUB_OUTPUT, `changed=${shouldWrite}\n`, { flag: 'a' }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
