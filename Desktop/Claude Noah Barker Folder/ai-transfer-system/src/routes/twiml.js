'use strict';

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const twilio  = require('../twilioClient');

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Warm transfer: bare bridge (build tag TRANSFER_V3) ────────────────────────
// No <Number url="whisper"> — that fetch was the bridge-failure point. The
// briefing was already sent to Todd via SMS in transferHandler before this
// runs, so when he answers his phone, both lines bridge instantly with no
// dependency on a webhook fetch completing in time.
router.all('/transfer-bridge', (req, res) => {
  const callSid   = req.query.callSid;
  const serverUrl = process.env.SERVER_URL;
  const todd      = process.env.AGENT_PHONE;
  const callerId  = process.env.TWILIO_PHONE_NUMBER;
  const actionUrl = serverUrl + '/call/dial-result?clientCallSid=' + encodeURIComponent(callSid);

  console.log('[transfer-bridge V3] callSid=' + callSid + ' todd=' + todd);

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Dial answerOnBridge="true" timeout="20" callerId="' + callerId + '" ' +
            'action="' + actionUrl + '" method="POST">' +
        todd +
      '</Dial>' +
    '</Response>'
  );
});

// ── Legacy whisper endpoint (kept as harmless silence in case Twilio hits it) ─
router.all('/agent-whisper', (req, res) => {
  console.log('[agent-whisper LEGACY] hit — returning empty response');
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  );
});

// ── Dial result: fires once <Dial> completes for any reason ───────────────────
// HARD GUARANTEE: this route NEVER places an outbound call to Todd. The only
// outcomes are (a) hang up the client, or (b) reconnect client to AI for
// scheduling. The Todd briefing was already SMSed before the dial; if he
// missed the live call, the SMS already told him who called and why.
router.post('/dial-result', async (req, res) => {
  const clientCallSid = req.query.clientCallSid;
  const status        = req.body.DialCallStatus;
  const duration      = parseInt(req.body.DialCallDuration || '0', 10);
  const dialedSid     = req.body.DialCallSid;
  const call          = store.getCall(clientCallSid);

  console.log('[DialResult V3] client=' + clientCallSid +
              ' status=' + status +
              ' duration=' + duration +
              ' dialedSid=' + dialedSid +
              ' state=' + call?.state +
              ' fullBody=' + JSON.stringify(req.body));

  // Bridge happened (any duration > 0) — we are DONE. End the client call.
  if (duration > 0) {
    if (call) store.updateCall(clientCallSid, { state: 'DONE' });
    console.log('[DialResult V3] Bridge completed → hanging up client');
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    );
  }

  // Duration 0 — Todd never bridged. Only treat as "Todd unavailable" for
  // definitive failure states. Anything else (canceled, completed-with-0,
  // unknown) → hang up to be safe; we will NEVER recall Todd from here.
  const FAILURE_STATES = ['no-answer', 'busy', 'failed'];
  if (!FAILURE_STATES.includes(status)) {
    console.log('[DialResult V3] Not a definitive failure → hangup');
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    );
  }

  // Todd unavailable. Send client back to AI for callback scheduling.
  // No outbound call to Todd — the SMS we already sent is sufficient.
  console.log('[DialResult V3] Todd unavailable (' + status + ') → back to AI');
  if (call) {
    store.updateCall(clientCallSid, {
      state: 'FALLBACK',
      pendingFallback: true,
    });
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
