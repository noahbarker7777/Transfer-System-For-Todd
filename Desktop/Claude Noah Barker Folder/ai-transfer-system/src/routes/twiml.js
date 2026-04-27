'use strict';

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const twilio  = require('../twilioClient');

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Warm transfer: redirect client here, Twilio dials Todd with whisper ───────
// Single TwiML eliminates conference + AMD + status callback race conditions.
// answerOnBridge gives the client ringback while Todd's phone rings.
// <Number url=""> plays the whisper privately to Todd before bridging.
// action fires after dial completes with DialCallStatus → /dial-result decides
// success vs voicemail/no-answer fallback.
router.all('/transfer-bridge', (req, res) => {
  const callSid    = req.query.callSid;
  const serverUrl  = process.env.SERVER_URL;
  const todd       = process.env.AGENT_PHONE;
  const callerId   = process.env.TWILIO_PHONE_NUMBER;
  const whisperUrl = serverUrl + '/call/agent-whisper?callSid=' + encodeURIComponent(callSid);
  const actionUrl  = serverUrl + '/call/dial-result?clientCallSid=' + encodeURIComponent(callSid);

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Dial answerOnBridge="true" timeout="20" callerId="' + callerId + '" ' +
            'action="' + actionUrl + '" method="POST">' +
        '<Number url="' + whisperUrl + '" method="GET">' + todd + '</Number>' +
      '</Dial>' +
    '</Response>'
  );
});

// ── Whisper played privately to Todd before bridging ──────────────────────────
// Twilio fetches this when Todd picks up. After <Say> completes, Twilio
// auto-bridges Todd with the client. AI is gone — no MediaStream, no agent.
router.all('/agent-whisper', (req, res) => {
  const callSid   = req.query.callSid || '';
  const call      = callSid ? store.getCall(callSid) : null;
  const agentName = process.env.AGENT_NAME || 'Todd';
  const name      = (call && call.callerName)  ? call.callerName  : 'a client';
  const phone     = (call && call.callerPhone) ? call.callerPhone : null;
  const phoneText = phone ? ' Their number is ' + phone + '.' : '';
  const greeting  = xmlEscape(
    'Hi ' + agentName + ', ' + name + ' is on the line about tax planning services.' +
    phoneText + ' Go ahead — you are connected!'
  );

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Say voice="Polly.Joanna">' + greeting + '</Say></Response>'
  );
});

// ── Dial result: fires once <Dial> completes for any reason ───────────────────
// DialCallStatus values:
//   completed  → call bridged successfully and ended naturally → hang up client
//   answered   → bridged (older Twilio versions) → hang up client
//   no-answer  → Todd didn't pick up → leave voicemail, return client to AI
//   busy       → Todd's line busy → voicemail + return to AI
//   failed     → carrier failure → voicemail + return to AI
//   canceled   → we canceled before answer → just hang up
router.post('/dial-result', async (req, res) => {
  const clientCallSid = req.query.clientCallSid;
  const status        = req.body.DialCallStatus;
  const call          = store.getCall(clientCallSid);

  console.log('[DialResult] client=' + clientCallSid + ' DialCallStatus=' + status);

  if (status === 'completed' || status === 'answered') {
    if (call) store.updateCall(clientCallSid, { state: 'DONE' });
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    );
  }

  // Transfer didn't bridge — leave Todd a voicemail and send client back to AI.
  if (call && !call.voicemailLeft) {
    store.updateCall(clientCallSid, {
      state: 'FALLBACK',
      pendingFallback: true,
      voicemailLeft: true,
    });
    twilio.leaveVoicemail({
      callerName:  call.callerName,
      callerPhone: call.callerPhone,
    }).catch(err => console.error('[DialResult] leaveVoicemail error:', err.message));
  }

  const wsUrl = process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><Stream url="' + wsUrl + '">' +
      '<Parameter name="callSid" value="' + clientCallSid + '" />' +
    '</Stream></Connect></Response>'
  );
});

// ── Hold TwiML served by our own server — no external dependencies ────────────
// Twilio fetches this as the conference waitUrl while the client waits for agent
router.all('/wait-twiml', (req, res) => {
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say voice="Polly.Joanna">Please hold for just a moment.</Say>' +
      '<Pause length="60"/>' +
    '</Response>'
  );
});

// ── Client moves into conference (hold music plays while waiting for agent) ───
// Called via calls(sid).update() when [TRANSFER] fires
// clientCallSid is passed so the conference statusCallback can route events back
router.all('/client-to-conference', (req, res) => {
  const conf             = req.query.conf;
  const clientCallSid    = encodeURIComponent(req.query.clientCallSid || '');
  const serverUrl        = process.env.SERVER_URL;
  const waitUrl          = serverUrl + '/call/wait-twiml';
  const statusCallbackUrl = serverUrl + '/call/status/conference?clientCallSid=' + clientCallSid;

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Dial><Conference ' +
      'waitUrl="' + waitUrl + '" waitMethod="GET" ' +
      'startConferenceOnEnter="false" ' +
      'endConferenceOnExit="true" ' +
      'beep="false" ' +
      'statusCallbackUrl="' + statusCallbackUrl + '" ' +
      'statusCallbackMethod="POST" ' +
      'statusCallbackEvent="conference-start">' +
      conf +
    '</Conference></Dial></Response>'
  );
});

// ── Agent answers — play briefing immediately then join conference ────────────
// Greeting plays privately to Todd; client hears hold music until Todd joins.
// No AMD gate needed — greeting fires the moment Todd picks up.
router.all('/agent-join-conference', (req, res) => {
  const conf      = req.query.conf;
  const callSid   = req.query.callSid || '';
  const agentName = process.env.AGENT_NAME || 'Todd';
  const call      = callSid ? store.getCall(callSid) : null;

  const name      = (call && call.callerName)  ? call.callerName  : 'a client';
  const phone     = (call && call.callerPhone) ? call.callerPhone : null;
  const phoneText = phone ? ' Their number is ' + phone + '.' : '';
  const greeting  = xmlEscape(
    'Hi ' + agentName + ', ' + name + ' is on the line about tax planning services.' +
    phoneText + ' Go ahead — you are connected!'
  );

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Say voice="Polly.Joanna">' + greeting + '</Say>' +
    '<Dial><Conference ' +
      'startConferenceOnEnter="true" ' +
      'endConferenceOnExit="true" ' +
      'beep="false">' +
      conf +
    '</Conference></Dial></Response>'
  );
});

// ── Agent greeting + conference bridge ────────────────────────────────────────
// Served via calls.update() once answered status fires
router.all('/agent-bridge', (req, res) => {
  const conf      = req.query.conf;
  const callSid   = req.query.callSid || '';
  const agentName = process.env.AGENT_NAME || 'Todd';
  const call      = callSid ? store.getCall(callSid) : null;

  const name      = (call && call.callerName)  ? call.callerName  : 'a client';
  const phone     = (call && call.callerPhone) ? call.callerPhone : null;
  const phoneText = phone ? ' Their number is ' + phone + '.' : '';
  const greeting  = xmlEscape(
    'Hi ' + agentName + ', ' + name + ' is on the line about tax planning services.' +
    phoneText + ' Go ahead — you are connected!'
  );

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Say voice="Polly.Joanna">' + greeting + '</Say>' +
    '<Dial><Conference ' +
      'startConferenceOnEnter="true" ' +
      'endConferenceOnExit="true" ' +
      'beep="false">' +
      conf +
    '</Conference></Dial></Response>'
  );
});

// ── Private briefing played to agent when they join ───────────────────────────
router.all('/agent-greeting', (req, res) => {
  const callSid   = req.query.callSid || '';
  const agentName = process.env.AGENT_NAME || 'Todd';
  const call      = callSid ? store.getCall(callSid) : null;

  const raw = call && call.callerSummary
    ? call.callerSummary
    : 'I have ' + (call && call.callerName ? call.callerName : 'a client') +
      ' on the line. They are interested in tax planning services.' +
      (call && call.callerPhone ? ' Their number is ' + call.callerPhone + '.' : '');

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Say voice="Polly.Joanna">' +
      'Hi ' + agentName + ', ' + xmlEscape(raw) + ' Go ahead — you are connected!' +
    '</Say></Response>'
  );
});

// ── Polite goodbye when Todd doesn't answer — Eryn's job is done ─────────────
router.all('/goodbye-twiml', (req, res) => {
  const company = process.env.COMPANY_NAME || 'Frazier Industries';
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Say voice="Polly.Joanna">' +
      'Thank you for calling ' + company + '. Todd will be in touch with you shortly. Have a great day!' +
    '</Say><Hangup/></Response>'
  );
});

// ── Return client to AI after a failed transfer (voicemail / no-answer) ───────
// Opens a fresh MediaStream WebSocket; server resumes AI from saved history
router.all('/back-to-ai', (req, res) => {
  const callSid = req.query.callSid;
  const wsUrl   = process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><Stream url="' + wsUrl + '">' +
      '<Parameter name="callSid" value="' + callSid + '" />' +
    '</Stream></Connect></Response>'
  );
});

// ── Legacy hold music (kept for reference) ────────────────────────────────────
router.all('/hold-twiml', (req, res) => {
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Play loop="10">https://com.twilio.music.classical.s3.amazonaws.com/BachGavotteShort.mp3</Play></Response>'
  );
});

module.exports = router;
