/**
 * twilioClient.js
 * Thin wrapper around the Twilio REST API.
 * All Twilio commands flow through here.
 */

const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

// ── Dial the agent as a second call leg ──────────────────────────────────────
async function dialAgent(conferenceName, agentCallSid) {
  try {
    const call = await client.calls.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,

      // When agent picks up, join them into the same conference
      url: `${config.SERVER_URL}/twiml/join-conference?conf=${encodeURIComponent(conferenceName)}`,

      // AMD: tells Twilio to detect human vs voicemail
      machineDetection:              'Enable',
      asyncAmdStatusCallback:        `${config.SERVER_URL}/call/amd-result`,
      asyncAmdStatusCallbackMethod:  'POST',

      // Track which client call this agent leg belongs to
      statusCallback:       `${config.SERVER_URL}/call/agent-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    });

    console.log(`[Twilio] Dialing agent ${config.AGENT_PHONE} → call SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] dialAgent error:', err.message);
    throw err;
  }
}

// ── Drop a voicemail for the agent (silent, parallel to client call) ─────────
async function leaveVoicemail({ callerName, callerPhone }) {
  const name    = callerName  || 'a potential client';
  const phone   = callerPhone || 'unknown';
  const message =
    `Hi ${config.AGENT_NAME}, this is ${config.ASSISTANT_NAME} from ${config.COMPANY_NAME}. ` +
    `I have ${name} on the line interested in tax planning services. ` +
    `Their phone number is ${phone}. ` +
    `Please give them a call back at your earliest convenience. Thanks!`;

  try {
    const call = await client.calls.create({
      to:   config.AGENT_PHONE,
      from: config.TWILIO_PHONE_NUMBER,
      // TwiML that plays the message then hangs up
      twiml: `<Response><Say voice="Polly.Joanna">${message}</Say><Hangup/></Response>`,
    });
    console.log(`[Twilio] Voicemail call initiated → SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('[Twilio] leaveVoicemail error:', err.message);
  }
}

// ── End the agent leg if transfer aborted ────────────────────────────────────
async function hangupCall(callSid) {
  try {
    await client.calls(callSid).update({ status: 'completed' });
    console.log(`[Twilio] Hung up call ${callSid}`);
  } catch (err) {
    console.error('[Twilio] hangupCall error:', err.message);
  }
}

// ── Fetch conference participants ─────────────────────────────────────────────
async function getConferenceParticipants(conferenceName) {
  try {
    const conferences = await client.conferences.list({
      friendlyName: conferenceName,
      status: 'in-progress',
      limit: 1,
    });
    if (!conferences.length) return [];
    const participants = await client.conferences(conferences[0].sid)
      .participants.list();
    return participants;
  } catch (err) {
    console.error('[Twilio] getConferenceParticipants error:', err.message);
    return [];
  }
}

module.exports = {
  client,
  dialAgent,
  leaveVoicemail,
  hangupCall,
  getConferenceParticipants,
};
