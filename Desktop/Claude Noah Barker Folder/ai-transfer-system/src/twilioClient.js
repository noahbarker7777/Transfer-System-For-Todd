'use strict';

/**
 * twilioClient.js
 * Thin wrapper around the Twilio REST API.
 */

const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

// ── Dial the agent into a conference room with AMD ────────────────────────────
// clientCallSid is embedded in the AMD and status callback URLs as a query
// param so we can route the results back without a ParentCallSid lookup.
async function dialAgent(conferenceName, clientCallSid, callerName, callerPhone) {
  const confParam  = encodeURIComponent(conferenceName);
  const nameParam  = encodeURIComponent(callerName  || '');
  const phoneParam = encodeURIComponent(callerPhone || '');

  const agentJoinUrl = config.SERVER_URL +
    '/call/agent-join-conference' +
    '?conf='    + confParam +
    '&name='    + nameParam +
    '&phone='   + phoneParam +
    '&callSid=' + encodeURIComponent(clientCallSid);

  const amdCallback = config.SERVER_URL +
    '/call/amd-result?clientCallSid=' + clientCallSid;

  const statusCallback = config.SERVER_URL +
    '/call/status/agent?clientCallSid=' + clientCallSid;

  try {
    const call = await client.calls.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      url:  agentJoinUrl,
      method: 'POST',
      timeout: 20,  // ring for max 20s then Twilio sends no-answer

      statusCallback:       statusCallback,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    });

    console.log(`[Twilio] Dialing agent ${config.AGENT_PHONE} → SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] dialAgent error:', err.message);
    throw err;
  }
}

// ── Leave a voicemail for the agent (separate outbound call, silent to client) ─
async function leaveVoicemail({ callerName, callerPhone }) {
  const name    = callerName  || 'a potential client';
  const phone   = callerPhone || 'unknown';
  const message =
    'Hi ' + config.AGENT_NAME + ', ' + name + ' called about tax services. ' +
    'Their number is ' + phone + '. Please give them a call back.';

  try {
    const call = await client.calls.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      twiml: '<Response><Pause length="2"/><Say voice="Polly.Joanna">' +
             message +
             '</Say><Hangup/></Response>',
    });
    console.log(`[Twilio] Voicemail call initiated → SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] leaveVoicemail error:', err.message);
  }
}

// ── End any in-progress call leg ──────────────────────────────────────────────
async function hangupCall(callSid) {
  try {
    await client.calls(callSid).update({ status: 'completed' });
    console.log(`[Twilio] Hung up call ${callSid}`);
  } catch (err) {
    console.error('[Twilio] hangupCall error:', err.message);
  }
}

module.exports = {
  client,
  dialAgent,
  leaveVoicemail,
  hangupCall,
};
