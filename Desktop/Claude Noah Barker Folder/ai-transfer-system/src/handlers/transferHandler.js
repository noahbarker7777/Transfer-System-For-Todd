'use strict';

/**
 * handlers/transferHandler.js
 *
 * Final architecture — version "SMS-FIRST" (build tag: TRANSFER_V3).
 *
 * The whisper-URL approach was failing at bridge time: Twilio fetches the
 * <Number url="..."> TwiML when the called party answers, and any latency or
 * error on that fetch leaves both lines silent because the bridge never
 * completes. Switching to SMS removes that fetch from the critical path.
 *
 * Flow:
 *   1. Send Todd an SMS with caller name + phone + topic (instant, silent).
 *   2. Redirect the client call to a bare <Dial> — no whisper, no action URL
 *      side effects, just a plain bridge to Todd's number.
 *   3. When the dial completes for any reason, /dial-result decides: bridge
 *      duration > 0 → hangup cleanly; otherwise → send client back to AI for
 *      callback scheduling. We NEVER place a second outbound call to Todd.
 */

const store  = require('../store');
const twilio = require('../twilioClient');
const config = require('../config');

const BUILD_TAG = 'TRANSFER_V3';

async function onTransferSignal(clientCallSid) {
  const call = store.getCall(clientCallSid);
  if (!call || call.state !== 'QUALIFYING') {
    console.log(`[Transfer ${BUILD_TAG}] Ignored — state=${call?.state} (need QUALIFYING)`);
    return;
  }

  console.log(`[Transfer ${BUILD_TAG}] Beginning transfer for ${clientCallSid}`);
  store.updateCall(clientCallSid, { state: 'TRANSFERRING' });

  // 1. SMS Todd the briefing (fire-and-forget; do not block the bridge on this).
  twilio.smsBriefing({
    callerName:  call.callerName,
    callerPhone: call.callerPhone,
    context:     'pre-transfer',
  }).catch(err => console.error(`[Transfer ${BUILD_TAG}] SMS error:`, err.message));

  // 2. Redirect the client call to the bare bridge TwiML.
  try {
    await twilio.client.calls(clientCallSid).update({
      url:    config.SERVER_URL + '/call/transfer-bridge?callSid=' + encodeURIComponent(clientCallSid),
      method: 'POST',
    });
    console.log(`[Transfer ${BUILD_TAG}] Client redirected to /call/transfer-bridge`);
  } catch (err) {
    console.error(`[Transfer ${BUILD_TAG}] Redirect failed:`, err.message);
  }
}

// Legacy no-ops — old in-flight calls' callbacks may still hit these handlers.
async function onAgentPickedUp() {}
async function onVoicemailDetected() {}
async function onTransferFailed() {}

module.exports = {
  onTransferSignal,
  onAgentPickedUp,
  onVoicemailDetected,
  onTransferFailed,
};
