'use strict';

/**
 * handlers/ghlWebhooks.js
 *
 * One-stop helper for the 6 n8n webhooks Eryn calls during a booking flow.
 *
 * Two patterns:
 *   - fire(url, payload): fire-and-forget; logs failures, never throws.
 *   - awaitJSON(url, payload, timeoutMs): POST and parse JSON response;
 *     throws on timeout or non-2xx so the caller can fall through to a
 *     graceful failure path.
 *
 * URLs come from env:
 *   N8N_QUALIFYING_URL, N8N_SCAN_URL, N8N_BOOK_URL,
 *   N8N_APPT_DETAILS_URL, N8N_TODD_SUCCESS_URL, N8N_TODD_FAILED_URL
 */

const config = require('../config');

function fire(url, payload, label) {
  if (!url) {
    console.error('[ghlWebhooks] ' + label + ' skipped — URL not set');
    return;
  }
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
    .then(r => console.log('[ghlWebhooks] ' + label + ' → HTTP ' + r.status))
    .catch(err => console.error('[ghlWebhooks] ' + label + ' error:', err.message));
}

async function awaitJSON(url, payload, timeoutMs, label) {
  if (!url) throw new Error(label + ' URL not set');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctl.signal,
    });
    if (!r.ok) throw new Error(label + ' HTTP ' + r.status);
    const json = await r.json();
    console.log('[ghlWebhooks] ' + label + ' → OK');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ── WH1 — qualifying answer ──────────────────────────────────────────────────
function fireQualifyingAnswer({ callSid, callerName, callerPhone, answer }) {
  fire(config.N8N_QUALIFYING_URL, {
    call_sid:     callSid,
    caller_name:  callerName,
    caller_phone: callerPhone,
    answer,
    answer_text: answer === 'yes'
      ? 'is interested in detailed planning services'
      : 'is not interested in detailed planning services',
  }, 'WH1 qualifying');
}

// ── WH2 — scan times (synchronous) ────────────────────────────────────────────
async function scanTimes({ callSid, requestedISO, timezone = 'America/Los_Angeles' }) {
  return awaitJSON(config.N8N_SCAN_URL, {
    call_sid:       callSid,
    requested_time: requestedISO,
    timezone,
  }, 6000, 'WH2 scan');
}

// ── WH3 — book time (synchronous) ─────────────────────────────────────────────
async function bookTime({ callSid, callerName, callerPhone, startISO, endISO, timezone = 'America/Los_Angeles' }) {
  return awaitJSON(config.N8N_BOOK_URL, {
    call_sid:     callSid,
    caller_name:  callerName,
    caller_phone: callerPhone,
    start_iso:    startISO,
    end_iso:      endISO,
    timezone,
  }, 8000, 'WH3 book');
}

// ── WH4 — appt details for Todd ──────────────────────────────────────────────
function fireApptDetails({ callSid, callerName, callerPhone, appointmentId, startISO, startPretty }) {
  fire(config.N8N_APPT_DETAILS_URL, {
    call_sid:       callSid,
    caller_name:    callerName,
    caller_phone:   callerPhone,
    appointment_id: appointmentId,
    start_iso:      startISO,
    start_pretty:   startPretty,
  }, 'WH4 appt-details');
}

// ── WH5 — todd answered (cancel appt + notify Todd) ──────────────────────────
function fireToddSuccess({ callSid, callerName, callerPhone, appointmentId, startPretty }) {
  fire(config.N8N_TODD_SUCCESS_URL, {
    call_sid:       callSid,
    caller_name:    callerName,
    caller_phone:   callerPhone,
    appointment_id: appointmentId || '',
    start_pretty:   startPretty   || '',
  }, 'WH5 todd-success');
}

// ── WH6 — todd missed call (keep appt + notify Todd) ─────────────────────────
function fireToddFailed({ callSid, callerName, callerPhone, appointmentId, startPretty }) {
  fire(config.N8N_TODD_FAILED_URL, {
    call_sid:       callSid,
    caller_name:    callerName,
    caller_phone:   callerPhone,
    appointment_id: appointmentId || '',
    start_pretty:   startPretty   || '',
  }, 'WH6 todd-failed');
}

module.exports = {
  fireQualifyingAnswer,
  scanTimes,
  bookTime,
  fireApptDetails,
  fireToddSuccess,
  fireToddFailed,
};
