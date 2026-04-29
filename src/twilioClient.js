'use strict';

/**
 * twilioClient.js
 * Thin wrapper around the Twilio REST API.
 *
 * TRANSFER_V4 (CONFERENCE+AMD) architecture:
 *   - dialAgentWithAMD: places an outbound call to Todd with machine detection.
 *     Twilio waits for AMD to finish (DetectMessageEnd) then POSTs to
 *     /call/agent-pickup with AnsweredBy. The TwiML there decides between
 *     bridging to the conference (human) and leaving a voicemail (machine).
 *   - smsBriefing: backup text to Todd with caller details.
 *   - hangupCall: cancel a call leg by SID.
 */

const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

// ── Place outbound call to Todd with AMD; TwiML branches on AnsweredBy ────────
async function dialAgentWithAMD({ clientCallSid, conferenceName }) {
  const params = new URLSearchParams({
    clientCallSid,
    conf: conferenceName,
  }).toString();

  const pickupUrl = config.SERVER_URL + '/call/agent-pickup?' + params;
  const statusUrl = config.SERVER_URL + '/call/status/agent?clientCallSid=' +
                    encodeURIComponent(clientCallSid);

  try {
    const call = await client.calls.create({
      to:     config.AGENT_PHONE,
      from:   config.TWILIO_PHONE_NUMBER,
      url:    pickupUrl,
      method: 'POST',
      timeout: 15,                              // ring time before no-answer
      // 'DetectMessageEnd' waits for the voicemail beep before invoking pickupUrl
      // so our voicemail message lands AFTER the beep (correctly recorded).
      // For human pickup the AMD wait adds 2-4s of silence before the briefing
      // starts; the briefing itself is now wrapped in <Gather> in /agent-pickup
      // so the briefing is GUARANTEED to play in full before the bridge happens
      // — bridge URL is only fetched after Gather completes.
      machineDetection:        'DetectMessageEnd',
      machineDetectionTimeout: 30,
      asyncAmd:                false,
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['answered', 'completed'],
    });

    console.log('[Twilio] Dialing Todd ' + config.AGENT_PHONE + ' → SID: ' + call.sid);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] dialAgentWithAMD error:', err.message);
    throw err;
  }
}

// ── SMS briefing — defense-in-depth so Todd has caller info on his screen ────
async function smsBriefing({ callerName, callerPhone, taxType, context }) {
  const name    = callerName  || 'a potential client';
  const phone   = callerPhone || 'unknown';
  const subject = taxType ? (taxType + ' taxes') : 'tax services';
  const lead    = context === 'pre-transfer' ? 'Incoming transfer'
                : context === 'voicemail'    ? 'Missed transfer (voicemail left)'
                : context === 'no-answer'    ? 'Missed transfer (no answer)'
                                             : 'Transfer';
  const body = lead + ': ' + name + ' (' + phone + ') re: ' + subject + '.';

  try {
    const msg = await client.messages.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      body,
    });
    console.log('[Twilio] SMS sent → SID: ' + msg.sid + ' body=' + body);
    return msg.sid;
  } catch (err) {
    console.error('[Twilio] smsBriefing error:', err.message);
  }
}

// ── End any in-progress call leg ──────────────────────────────────────────────
async function hangupCall(callSid) {
  try {
    await client.calls(callSid).update({ status: 'completed' });
    console.log('[Twilio] Hung up call ' + callSid);
  } catch (err) {
    // 20404 = call no longer in flight; safe to ignore.
    if (err.code !== 20404) {
      console.error('[Twilio] hangupCall error:', err.message);
    }
  }
}

// ── Redirect an in-flight call to a new TwiML URL ─────────────────────────────
async function redirectCall(callSid, url) {
  try {
    await client.calls(callSid).update({ url, method: 'POST' });
    console.log('[Twilio] Redirected ' + callSid + ' → ' + url);
  } catch (err) {
    console.error('[Twilio] redirectCall error:', err.message);
  }
}

module.exports = {
  client,
  dialAgentWithAMD,
  smsBriefing,
  hangupCall,
  redirectCall,
};
