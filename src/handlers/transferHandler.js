/**
 * handlers/transferHandler.js
 * The core state machine — every transfer decision flows through here.
 *
 * States handled:
 *   QUALIFYING   → TRANSFERRING  (onTransferSignal)
 *   TRANSFERRING → CONNECTED     (onAgentPickedUp)
 *   TRANSFERRING → FALLBACK      (onVoicemailDetected / onTransferTimeout / onTransferFailed)
 *   CONNECTED    → DONE          (after AI warm intro)
 *   FALLBACK     → (AI continues conversation)
 */

const store       = require('../store');
const twilio      = require('../twilioClient');
const aiPipeline  = require('./aiPipeline');
const logging     = require('./logging');
const config      = require('../config');

// ── Step 1: AI detected a qualified lead → start transfer ────────────────────
async function onTransferSignal(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'QUALIFYING') {
    console.log(`[Transfer] onTransferSignal ignored — state is ${call?.state}`);
    return;
  }

  console.log(`[Transfer] Transfer signal received for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'TRANSFERRING', isAiMuted: true });

  // Pause AI audio output — client now hears hold music from the conference
  aiPipeline.pauseAudio(clientCallSid);

  // Dial agent with AMD — response comes back to /call/amd-result
  try {
    const agentCallSid = await twilio.dialAgent(call.conferenceName, clientCallSid);
    store.updateCall(clientCallSid, { agentCallSid });
  } catch (err) {
    console.error(`[Transfer] Failed to dial agent: ${err.message}`);
    await onTransferFailed(clientCallSid);
    return;
  }

  // Safety timeout — if AMD never fires, fall back after N seconds
  const timer = setTimeout(async () => {
    const current = store.getCall(clientCallSid);
    if (current?.state === 'TRANSFERRING') {
      console.log(`[Transfer] Timeout after ${config.TRANSFER_TIMEOUT_MS}ms → fallback`);
      await onTransferFailed(clientCallSid);
    }
  }, config.TRANSFER_TIMEOUT_MS);

  store.updateCall(clientCallSid, { transferTimer: timer });
}

// ── Step 2A: Human picked up → warm bridge ────────────────────────────────────
async function onAgentPickedUp(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'TRANSFERRING') return;

  // Clear the safety timeout
  if (call.transferTimer) clearTimeout(call.transferTimer);

  console.log(`[Transfer] Agent picked up → bridging for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'CONNECTED', isAiMuted: false });

  // Build the AI warm introduction message
  const callerName  = call.callerName  || 'the client';
  const callerPhone = call.callerPhone || 'unknown number';
  const introText   =
    `Hi ${config.AGENT_NAME}, I have ${callerName} on the line — ` +
    `they're interested in tax planning services. ` +
    `Their number is ${callerPhone}. Connecting you now!`;

  // AI speaks the warm intro into the conference
  await aiPipeline.speakToClient(clientCallSid, introText);

  // After intro (~8 seconds), remove the AI leg — agent and client are alone
  setTimeout(async () => {
    const current = store.getCall(clientCallSid);
    if (current?.state === 'CONNECTED') {
      console.log(`[Transfer] Warm intro done — removing AI from conference`);
      aiPipeline.disconnectStream(clientCallSid);
      store.updateCall(clientCallSid, { state: 'DONE' });
      await logging.logOutcome(clientCallSid, 'transferred');
    }
  }, 8000);
}

// ── Step 2B: Voicemail detected → leave VM silently + return to client ────────
async function onVoicemailDetected(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'TRANSFERRING') return;

  if (call.transferTimer) clearTimeout(call.transferTimer);

  console.log(`[Transfer] Voicemail detected → fallback for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'FALLBACK', isAiMuted: false });

  // Hang up the agent leg that hit voicemail (don't leave a VM on that leg)
  if (call.agentCallSid) {
    await twilio.hangupCall(call.agentCallSid);
  }

  // Fire-and-forget: place a SEPARATE silent outbound call to leave a proper voicemail
  twilio.leaveVoicemail({
    callerName:  call.callerName,
    callerPhone: call.callerPhone,
  }).catch(err => console.error('[Transfer] leaveVoicemail error:', err.message));

  // Resume AI audio — client hears AI return seamlessly
  aiPipeline.resumeAudio(clientCallSid);

  // Signal AI to run the fallback script
  const fallbackMessage =
    `${call.callerName ? call.callerName + ', ' : ''}` +
    `${config.AGENT_NAME}'s just finishing up with another client, but I've already sent him your information. ` +
    `He'll be reaching out to you shortly${call.callerPhone ? ' at ' + call.callerPhone : ''}. ` +
    `Is there anything else I can help you with while you wait, ` +
    `or would you prefer to hang up and wait for his call?`;

  await aiPipeline.speakToClient(clientCallSid, fallbackMessage);

  // Re-enable full AI conversation for ongoing fallback
  store.updateCall(clientCallSid, { state: 'FALLBACK' });
  await logging.logOutcome(clientCallSid, 'voicemail_left');
}

// ── Step 2C: Transfer failed entirely (busy / no-answer / error) ─────────────
async function onTransferFailed(clientCallSid) {
  // Treat the same as voicemail — return to client gracefully
  const call = store.getCall(clientCallSid);
  if (!call) return;

  // Force state to TRANSFERRING so onVoicemailDetected passes its guard
  store.updateCall(clientCallSid, { state: 'TRANSFERRING' });
  await onVoicemailDetected(clientCallSid);
}

module.exports = {
  onTransferSignal,
  onAgentPickedUp,
  onVoicemailDetected,
  onTransferFailed,
};
