'use strict';

const express = require('express');
const router  = express.Router();
const store   = require('../store');

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
router.all('/client-to-conference', (req, res) => {
  const conf    = req.query.conf;
  const waitUrl = process.env.SERVER_URL + '/call/wait-twiml';
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Dial><Conference ' +
      'waitUrl="' + waitUrl + '" waitMethod="GET" ' +
      'startConferenceOnEnter="false" ' +
      'endConferenceOnExit="true" ' +
      'beep="false">' +
      conf +
    '</Conference></Dial></Response>'
  );
});

// ── Agent joins conference (this URL is fetched when Todd picks up) ───────────
// startConferenceOnEnter="true" starts the conference → client hold music stops
// announceUrl plays a private greeting to Todd only before he's fully bridged
router.all('/agent-join-conference', (req, res) => {
  const conf       = req.query.conf;
  const callSid    = encodeURIComponent(req.query.callSid || '');
  const serverUrl  = process.env.SERVER_URL;
  const announceUrl = serverUrl + '/call/agent-greeting?callSid=' + callSid;

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Dial><Conference ' +
      'startConferenceOnEnter="true" ' +
      'endConferenceOnExit="false" ' +
      'beep="false" ' +
      'announceUrl="' + announceUrl + '" announceMethod="GET">' +
      conf +
    '</Conference></Dial></Response>'
  );
});

// ── Private briefing played to agent when they join ───────────────────────────
// Client does NOT hear this — it plays only on Todd's leg via announceUrl
const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
