'use strict';

/**
 * handlers/transferHandler.js
 *
 * TRANSFER_V4 — CONFERENCE + AMD architecture.
 *
 * On [TRANSFER]:
 *   1. Send Todd an SMS briefing (fire-and-forget; defense in depth).
 *   2. Move the client into a unique conference (alone, hold music).
 *   3. Place a separate outbound call to Todd with machineDetection enabled.
 *
 * Twilio's AMD result drives the rest:
 *   - human                 → /agent-pickup speaks briefing then <Dial><Conference>
 *   - machine_end_*         → /agent-pickup speaks briefing then <Hangup/> (voicemail)
 *   - never answered        → status callback fires no-answer; client falls back
 *
 * Single source of truth: agentJoinedConference (set by conference status
 * webhook on participant-join). The agent call's completed callback uses this
 * flag to decide whether to leave the client connected (already bridged) or
 * fall back (voicemail / no-answer / abandoned briefing).
 *
 * Idempotency: transferStarted prevents double-fire from any retry path.
 */

const store  = require('../store');
const twilio = require('../twilioClient');
const config = require('../config');
const ghl    = require('./ghlWebhooks');

const BUILD_TAG = 'TRANSFER_V4';

async function onTransferSignal(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call) {
    console.log('[Transfer ' + BUILD_TAG + '] Ignored — no call ' + clientCallSid);
    return;
  }

  // aiPipeline pre-locks state to TRANSFERRING the moment [TRANSFER] is parsed
  // so background-noise transcripts can't kick off another AI turn.
  if (!['QUALIFYING', 'TRANSFERRING'].includes(call.state)) {
    console.log('[Transfer ' + BUILD_TAG + '] Ignored — state=' + call.state);
    return;
  }

  if (call.transferStarted) {
    console.log('[Transfer ' + BUILD_TAG + '] Ignored — already started for ' + clientCallSid);
    return;
  }

  const conferenceName = 'conf-' + clientCallSid;

  // Note: deliberately do NOT reset agentCallSid here. transferStarted gates
  // re-entry, so leaving any prior value alone is safe and avoids a brief
  // null-window where the client-completed webhook would skip cancelling
  // Todd's leg if the client hangs up between this write and line ~95.
  store.updateCall(clientCallSid, {
    state: 'TRANSFERRING',
    transferStarted: true,
    conferenceName,
    agentJoinedConference: false,
    agentAnsweredBy: null,
    fallbackTriggered: false,
  });

  console.log('[Transfer ' + BUILD_TAG + '] Beginning transfer for ' + clientCallSid +
              ' name="' + (call.callerName || '') + '"' +
              ' phone="' + (call.callerPhone || '') + '"');

  // No pre-transfer SMS here — WH4 (appt details) already notified Todd if a
  // booking was made. WH5/WH6 fire from status.js based on bridge outcome.

  // 2. Move the client into the conference (alone, hold music).
  const moveUrl = config.SERVER_URL + '/call/move-client?' + new URLSearchParams({
    conf: conferenceName,
    clientCallSid,
  }).toString();

  try {
    await twilio.redirectCall(clientCallSid, moveUrl);
  } catch (err) {
    console.error('[Transfer ' + BUILD_TAG + '] Failed to move client to conference:', err.message);
    await abortTransfer(clientCallSid, 'redirect-failed');
    return;
  }

  // 3. Dial Todd with AMD. The status webhook drives every downstream branch.
  try {
    const agentSid = await twilio.dialAgentWithAMD({
      clientCallSid,
      conferenceName,
    });
    store.updateCall(clientCallSid, { agentCallSid: agentSid });
  } catch (err) {
    console.error('[Transfer ' + BUILD_TAG + '] Dial-Todd failed:', err.message);
    await abortTransfer(clientCallSid, 'dial-failed');
  }
}

// ── Abort transfer when the setup itself errors before Todd was even dialed ──
// Per spec: do NOT bring the client back to the AI. Fire WH6 (so Todd sees a
// missed-call message and the appt stays booked) then hang up the client.
async function abortTransfer(clientCallSid, reason) {
  const call = store.getCall(clientCallSid);
  if (!call) return;
  console.log('[Transfer ' + BUILD_TAG + '] Aborting (' + reason + ') for ' + clientCallSid);

  ghl.fireToddFailed({
    callSid:        clientCallSid,
    callerName:     call.callerName,
    callerPhone:    call.callerPhone,
    appointmentId:  call.bookedAppointmentId,
    startPretty:    call.bookedStartPretty,
  });

  store.updateCall(clientCallSid, { state: 'DONE' });
  await twilio.hangupCall(clientCallSid);
}

// ── Fallback: redirect client out of conference and back into MediaStream ─────
// Called from status webhooks when Todd never bridges (voicemail / no-answer /
// abandoned briefing). Idempotent — if fallbackTriggered is already true, no-op.
async function triggerClientFallback(clientCallSid, reason) {
  const call = store.getCall(clientCallSid);
  if (!call) return;
  if (call.fallbackTriggered) return;

  store.updateCall(clientCallSid, {
    fallbackTriggered: true,
    fallbackReason: reason,        // distinguishes voicemail vs no-answer in CRM logs
    state: 'FALLBACK',
    pendingFallback: true,
  });

  console.log('[Transfer ' + BUILD_TAG + '] Client fallback (' + reason + ') for ' + clientCallSid);

  const url = config.SERVER_URL + '/call/back-to-ai?' + new URLSearchParams({
    clientCallSid,
  }).toString();

  await twilio.redirectCall(clientCallSid, url);
}

module.exports = {
  onTransferSignal,
  triggerClientFallback,
  abortTransfer,
};
