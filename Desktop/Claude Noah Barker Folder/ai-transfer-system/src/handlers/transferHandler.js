'use strict';

/**
 * handlers/transferHandler.js
 *
 * Simplified warm-transfer flow using <Dial><Number> with a whisper URL.
 *
 * onTransferSignal redirects the client to TwiML that:
 *   1. Dials Todd (timeout 20s)
 *   2. Plays a private briefing to Todd via the <Number url=""> whisper
 *   3. Auto-bridges client and Todd
 *   4. Calls /call/dial-result when the dial completes (action URL)
 *
 * No status callbacks for the agent leg.
 * No AMD.
 * No conference.
 * No timers.
 * Voicemail and fallback handled in /call/dial-result based on DialCallStatus.
 */

const store  = require('../store');
const twilio = require('../twilioClient');
const config = require('../config');

async function onTransferSignal(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'QUALIFYING') {
    console.log(`[Transfer] Ignored — state is ${call?.state} (not QUALIFYING)`);
    return;
  }

  console.log(`[Transfer] Redirecting client ${clientCallSid} to bridge TwiML`);
  // Lock state immediately so a duplicate [TRANSFER] from the AI cannot re-enter.
  store.updateCall(clientCallSid, { state: 'TRANSFERRING' });

  try {
    await twilio.client.calls(clientCallSid).update({
      url:    config.SERVER_URL + '/call/transfer-bridge?callSid=' + encodeURIComponent(clientCallSid),
      method: 'POST',
    });
    console.log('[Transfer] Client redirected — Twilio will dial Todd with whisper');
  } catch (err) {
    console.error('[Transfer] Failed to redirect client to bridge:', err.message);
  }
}

// Legacy no-op exports — old status/amd callbacks may still hit these if
// any in-flight calls were created against the previous architecture.
async function onAgentPickedUp() {}
async function onVoicemailDetected() {}
async function onTransferFailed() {}

module.exports = {
  onTransferSignal,
  onAgentPickedUp,
  onVoicemailDetected,
  onTransferFailed,
};
