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

  const statusCallback = config.SERVER_URL +
    '/call/status/agent?clientCallSid=' + clientCallSid;

  try {
    const call = await client.calls.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      url:  agentJoinUrl,
      method: 'POST',
      timeout: 20,

      statusCallback:       statusCallback,
      statusCallbackMethod: 'POST',
      // 'answered' is the event name Twilio accepts here.
      // When it fires, CallStatus in the POST body is 'in-progress' — see status.js.
      statusCallbackEvent:  ['ringing', 'answered', 'completed'],
    });

    console.log(`[Twilio] Dialing agent ${config.AGENT_PHONE} → SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] dialAgent error:', err.message);
    throw err;
  }
}

// ── SMS the briefing to Todd (no second outbound call to him, ever) ──────────
// Replaces the legacy leaveVoicemail. We never call Todd a second time in any
// code path — that was the source of the "phantom callback" the user saw.
// SMS lands on Todd's phone immediately and silently; he reads it whenever.
async function smsBriefing({ callerName, callerPhone, context }) {
  const name  = callerName  || 'a potential client';
  const phone = callerPhone || 'unknown';
  const lead  = context === 'pre-transfer'
    ? 'Incoming transfer'
    : 'Missed transfer';
  const body  = lead + ': ' + name + ' (' + phone + ') re: tax services.';

  try {
    const msg = await client.messages.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      body,
    });
    console.log('[Twilio] SMS briefing sent → SID: ' + msg.sid + ' body=' + body);
    return msg.sid;
  } catch (err) {
    console.error('[Twilio] smsBriefing error:', err.message);
  }
}

// Legacy export kept so any stray reference from old code can no-op safely.
async function leaveVoicemail() {
  console.warn('[Twilio] leaveVoicemail called — IGNORED (legacy path neutralized)');
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
  leaveVoicemail,  // legacy no-op
  smsBriefing,
  hangupCall,
};
