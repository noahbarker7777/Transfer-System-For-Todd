'use strict';

/**
 * handlers/transferHandler.js
 * Core transfer state machine.
 *
 * States:
 *   QUALIFYING   → TRANSFERRING   onTransferSignal()
 *   TRANSFERRING → DONE           onAgentPickedUp()    (conference live, agent answered)
 *   TRANSFERRING → FALLBACK       onVoicemailDetected() / onTransferFailed()
 *   FALLBACK     → (AI resumes conversation after stream reconnects)
 */

const store   = require('../store');
const twilio  = require('../twilioClient');
const logging = require('./logging');
const config  = require('../config');

// ── Step 1: AI fired [TRANSFER] — move client to conference, dial agent ───────
async function onTransferSignal(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || !['QUALIFYING', 'TRANSFERRING'].includes(call.state)) {
    console.log(`[Transfer] Ignored — state is ${call?.state}`);
    return;
  }

  console.log(`[Transfer] Transfer signal received for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'TRANSFERRING' });

  const conferenceName = call.conferenceName;
  const callerName     = call.callerName  || '';
  const callerPhone    = call.callerPhone || '';

  // Move the client into a Twilio conference room.
  // They will hear hold music (waitUrl) until the agent joins.
  // This also closes the MediaStream WebSocket — the AI is now silent.
  try {
    await twilio.client.calls(clientCallSid).update({
      url:    config.SERVER_URL + '/call/client-to-conference?conf=' + encodeURIComponent(conferenceName) +
              '&clientCallSid=' + encodeURIComponent(clientCallSid),
      method: 'POST',
    });
    console.log('[Transfer] Client redirected to conference — hold music playing');
  } catch (err) {
    console.error('[Transfer] Failed to redirect client to conference:', err.message);
    await onTransferFailed(clientCallSid);
    return;
  }

  // Dial the agent into the same conference with AMD.
  // The agent hears a private briefing (announceUrl) when they join.
  try {
    const agentCallSid = await twilio.dialAgent(
      conferenceName, clientCallSid, callerName, callerPhone
    );
    store.updateCall(clientCallSid, { agentCallSid });
  } catch (err) {
    console.error('[Transfer] Failed to dial agent:', err.message);
    await onTransferFailed(clientCallSid);
    return;
  }

  // Safety net — if no live answer is confirmed within timeout, fall back gracefully
  const timer = setTimeout(async () => {
    const current = store.getCall(clientCallSid);
    if (current?.state === 'TRANSFERRING' && !current?.agentAnsweredLive) {
      console.log(`[Transfer] Timeout after ${config.TRANSFER_TIMEOUT_MS}ms — no live answer confirmed → fallback`);
      await onTransferFailed(clientCallSid);
    }
  }, config.TRANSFER_TIMEOUT_MS);

  store.updateCall(clientCallSid, { transferTimer: timer });
}

// ── Step 2A: AMD confirmed human — play greeting then bridge into conference ────
async function onAgentPickedUp(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'TRANSFERRING') return;

  if (call.transferTimer) clearTimeout(call.transferTimer);

  console.log(`[Transfer] Agent answered — redirecting to greeting + bridge`);
  store.updateCall(clientCallSid, { state: 'DONE', agentAnsweredLive: true });

  // Interrupt the silent <Pause> on the agent leg and serve the greeting + conference TwiML
  const bridgeUrl = config.SERVER_URL + '/call/agent-bridge' +
    '?conf='    + encodeURIComponent(call.conferenceName) +
    '&callSid=' + encodeURIComponent(clientCallSid);

  try {
    await twilio.client.calls(call.agentCallSid).update({ url: bridgeUrl, method: 'GET' });
    console.log('[Transfer] Agent redirected to greeting + conference bridge');
  } catch (err) {
    console.error('[Transfer] Failed to redirect agent to bridge:', err.message);
  }

  await logging.logOutcome(clientCallSid, 'transferred');
}

// ── Step 2B: Voicemail / no-answer — return client to AI for scheduling ───────
async function onVoicemailDetected(clientCallSid) {
  const call = store.getCall(clientCallSid);
  // Hard stop: never fire this if agent already answered live
  if (!call || call.state !== 'TRANSFERRING' || call.agentAnsweredLive) return;

  if (call.transferTimer) clearTimeout(call.transferTimer);

  console.log(`[Transfer] Voicemail/no-answer — falling back for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'FALLBACK' });

  // Redirect client to Eryn BEFORE hanging up agent (prevents conference-end
  // from terminating the client call before we can redirect them)
  try {
    store.updateCall(clientCallSid, { pendingFallback: true });
    await twilio.client.calls(clientCallSid).update({
      url:    config.SERVER_URL + '/call/back-to-ai?callSid=' + clientCallSid,
      method: 'POST',
    });
    console.log('[Transfer] Client redirected back to AI for scheduling');
  } catch (err) {
    console.error('[Transfer] Failed to redirect client back to AI:', err.message);
  }

  // End the agent leg (conference ends after client already left)
  if (call.agentCallSid) {
    await twilio.hangupCall(call.agentCallSid);
  }

  // Leave a simple voicemail: name + number only
  twilio.leaveVoicemail({
    callerName:  call.callerName,
    callerPhone: call.callerPhone,
  }).catch(err => console.error('[Transfer] leaveVoicemail error:', err.message));

  await logging.logOutcome(clientCallSid, 'voicemail_left');
}

// ── Step 2C: Agent leg failed entirely (busy / failed / error) ───────────────
async function onTransferFailed(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call) return;
  // Never trigger fallback if a live answer was already confirmed
  if (call.agentAnsweredLive) {
    console.log('[Transfer] onTransferFailed blocked — agent already answered live');
    return;
  }
  store.updateCall(clientCallSid, { state: 'TRANSFERRING' });
  await onVoicemailDetected(clientCallSid);
}

module.exports = {
  onTransferSignal,
  onAgentPickedUp,
  onVoicemailDetected,
  onTransferFailed,
};
