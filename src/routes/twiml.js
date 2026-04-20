'use strict';

const express = require('express');
const router  = express.Router();

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
  const name       = encodeURIComponent(req.query.name  || '');
  const phone      = encodeURIComponent(req.query.phone || '');
  const serverUrl  = process.env.SERVER_URL;
  const announceUrl = serverUrl + '/call/agent-greeting?name=' + name + '&amp;phone=' + phone;

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
router.all('/agent-greeting', (req, res) => {
  const name      = req.query.name  || 'a client';
  const phone     = req.query.phone || '';
  const agentName = process.env.AGENT_NAME    || 'Todd';
  const phoneText = phone ? ' Their callback number is ' + phone + '.' : '';

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Say voice="Polly.Joanna">' +
      'Hi ' + agentName + ', I have ' + name + ' on the line. ' +
      'They are interested in tax planning services.' + phoneText +
      ' Go ahead — you are connected!' +
    '</Say></Response>'
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
