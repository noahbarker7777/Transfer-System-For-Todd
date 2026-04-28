'use strict';

/**
 * routes/twiml.js — TRANSFER_V4 (CONFERENCE+AMD)
 *
 * Routes:
 *   POST/GET /move-client    — moves the client into the conference (hold music)
 *   POST     /agent-pickup   — Twilio fires this once Todd's call is answered;
 *                              AnsweredBy decides bridge-vs-voicemail
 *   GET/ALL  /wait-music     — hold-music TwiML for the client side
 *   GET/ALL  /back-to-ai     — opens a fresh MediaStream so AI can deliver fallback
 *
 * No legacy routes. Anything not in this file no longer exists.
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const config  = require('../config');

const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 'alice' is Twilio's universally-available legacy voice — works on every
// account, no Polly/Google TTS dependency. Previous Polly.Joanna attempts
// rendered silently in production for unclear reasons; alice is the safe pick.
const VOICE = 'alice';

// Build the briefing Todd hears. Returns an array of TwiML <Say>/<Pause> chunks
// because the human-pickup case needs short sentences with breathing room — a
// single long <Say> blew past Todd while he was still saying "hello".
function briefingChunks({ callerName, callerPhone, taxType }, mode) {
  const agent   = config.AGENT_NAME || 'Todd';
  const company = config.COMPANY_NAME || 'Frazier Industries';
  const name    = callerName  || 'a client';
  const subject = taxType ? (taxType + ' taxes') : 'tax services';

  if (mode === 'voicemail') {
    const digits = String(callerPhone || '').replace(/\D/g, '');
    const phone  = digits.length >= 10
      ? ('. Their callback number is ' + spellPhone(digits))
      : '';
    return [
      // Long pause first so any tail of the greeting/beep is past before we speak.
      { kind: 'pause', length: 2 },
      { kind: 'say',   text: 'Hi ' + agent + ', this is your ' + company + ' assistant.' },
      { kind: 'say',   text: name + ' just called about ' + subject + phone + '.' },
      { kind: 'say',   text: 'Please call them back as soon as you can. Goodbye.' },
    ];
  }
  // Human bridge — pace the briefing so Todd hears it clearly even if he was
  // still mid-"hello" when the audio path opened.
  return [
    { kind: 'pause', length: 1 },
    { kind: 'say',   text: 'Hi ' + agent + ', it\'s your assistant.' },
    { kind: 'pause', length: 1 },
    { kind: 'say',   text: name + ' is on the line about ' + subject + '.' },
    { kind: 'pause', length: 1 },
    { kind: 'say',   text: 'Connecting you now.' },
  ];
}

function chunksToTwiml(chunks) {
  return chunks.map(c => c.kind === 'pause'
    ? '<Pause length="' + c.length + '"/>'
    : '<Say voice="' + VOICE + '">' + xmlEscape(c.text) + '</Say>'
  ).join('');
}

// Speak phone numbers digit-by-digit so Polly doesn't read "7145551234" as a year.
function spellPhone(p) {
  return String(p).replace(/\D/g, '').split('').join(' ');
}

// ── Move the client into the conference (alone, with hold music) ──────────────
// Speaks a clear "please hold" cue first so the caller hears something
// continuous in the gap between Eryn's last words and the conference music.
// Without this, the caller perceives the silent redirect as "the AI is dialing".
router.all('/move-client', (req, res) => {
  const conf            = req.query.conf || req.body.conf;
  const clientCallSid   = req.query.clientCallSid || req.body.clientCallSid;
  const agent           = config.AGENT_NAME || 'Todd';
  const serverUrl       = process.env.SERVER_URL;
  const waitUrl         = serverUrl + '/call/wait-music';
  const confStatusUrl   = serverUrl + '/call/status/conference?clientCallSid=' +
                          encodeURIComponent(clientCallSid || '');

  console.log('[move-client V4] callSid=' + clientCallSid + ' conf=' + conf);

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say voice="' + VOICE + '">Please hold for just a moment while I bring ' +
        xmlEscape(agent) + ' on the line.</Say>' +
      '<Dial>' +
        '<Conference ' +
          'startConferenceOnEnter="false" ' +
          'endConferenceOnExit="true" ' +    // client hangup ends conference
          'beep="false" ' +
          'waitUrl="' + waitUrl + '" waitMethod="GET" ' +
          'statusCallback="' + confStatusUrl + '" ' +
          'statusCallbackMethod="POST" ' +
          'statusCallbackEvent="join leave end">' +
          xmlEscape(conf) +
        '</Conference>' +
      '</Dial>' +
    '</Response>'
  );
});

// ── Hold music while the client waits for Todd to be reached ──────────────────
router.all('/wait-music', (req, res) => {
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Play loop="0">https://com.twilio.music.classical.s3.amazonaws.com/BachGavotteShort.mp3</Play>' +
    '</Response>'
  );
});

// ── Twilio invokes this once Todd's call is answered (and AMD has finished) ───
// AnsweredBy values: human, machine_start, machine_end_beep, machine_end_silence,
// machine_end_other, fax, unknown.
//
// HUMAN BRANCH (the critical one):
//   We do NOT inline <Say> + <Dial> in the same TwiML. Twilio is supposed to
//   execute verbs in order, but in production the briefing was being skipped
//   while the bridge still happened — Todd was dropped onto the call cold.
//   The fix: wrap the briefing in <Gather>, which Twilio guarantees plays its
//   prompt fully before moving on, then <Redirect> to a SEPARATE /agent-bridge
//   endpoint that does only the conference dial. Even if a single <Say> ever
//   fails silently, the bridge URL isn't fetched until the briefing TwiML has
//   completed end-to-end. Todd cannot reach the bridge before the briefing.
//
// VOICEMAIL BRANCH:
//   Long leading <Pause> to step over the start of the greeting tail, then
//   speak the message and hang up.
router.post('/agent-pickup', (req, res) => {
  const conf          = req.query.conf;
  const clientCallSid = req.query.clientCallSid;
  const answeredBy    = (req.body.AnsweredBy || '').toLowerCase();
  const call          = clientCallSid ? store.getCall(clientCallSid) : null;

  console.log('[agent-pickup V4] client=' + clientCallSid +
              ' answeredBy=' + answeredBy +
              ' fullBody=' + JSON.stringify(req.body));

  if (call) store.updateCall(clientCallSid, { agentAnsweredBy: answeredBy || 'unknown' });

  const briefingPayload = {
    callerName:  call?.callerName,
    callerPhone: call?.callerPhone,
    taxType:     call?.taxType,
  };

  // Voicemail branch — anything starting with "machine", plus 'fax' and 'unknown'.
  const isMachine = answeredBy.startsWith('machine') ||
                    answeredBy === 'fax' ||
                    answeredBy === 'unknown';

  if (isMachine) {
    const body = chunksToTwiml(briefingChunks(briefingPayload, 'voicemail'));
    console.log('[agent-pickup V4] machine detected → leaving voicemail');
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' + body + '<Hangup/></Response>'
    );
  }

  // Human pickup — Gather forces briefing to play in full before /agent-bridge
  // is fetched. Both paths (Todd presses any digit, or Gather times out) lead
  // to the same /agent-bridge endpoint; bridge happens AFTER the briefing.
  const bridgeUrl = process.env.SERVER_URL + '/call/agent-bridge?' +
                    new URLSearchParams({ conf, clientCallSid }).toString();
  const briefing  = chunksToTwiml(briefingChunks(briefingPayload, 'human'));

  console.log('[agent-pickup V4] human → briefing fence then /agent-bridge');
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Gather numDigits="1" timeout="3" finishOnKey="" ' +
              'action="' + bridgeUrl + '" method="POST">' +
        briefing +
      '</Gather>' +
      // If Gather times out without a key press, redirect to bridge anyway.
      '<Redirect method="POST">' + bridgeUrl + '</Redirect>' +
    '</Response>'
  );
});

// ── Bridge endpoint — only reached after /agent-pickup's Gather completes ─────
// Sole responsibility: drop Todd's call leg into the conference. By the time
// Twilio fetches this URL, the briefing has fully played.
router.all('/agent-bridge', (req, res) => {
  const conf          = req.query.conf || req.body.conf;
  const clientCallSid = req.query.clientCallSid || req.body.clientCallSid;
  console.log('[agent-bridge V4] client=' + clientCallSid + ' conf=' + conf +
              ' digits=' + (req.body.Digits || ''));
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Dial>' +
        '<Conference ' +
          'startConferenceOnEnter="true" ' +
          'endConferenceOnExit="true" ' +
          'beep="false">' +
          xmlEscape(conf) +
        '</Conference>' +
      '</Dial>' +
    '</Response>'
  );
});

// ── Pull the client back into MediaStream so Eryn can deliver the fallback ────
router.all('/back-to-ai', (req, res) => {
  const clientCallSid = req.query.clientCallSid || req.body.clientCallSid;
  const wsUrl = process.env.SERVER_URL.replace(/^https/, 'wss') + '/media-stream';
  console.log('[back-to-ai V4] callSid=' + clientCallSid);
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect><Stream url="' + wsUrl + '">' +
      '<Parameter name="callSid" value="' + xmlEscape(clientCallSid || '') + '" />' +
    '</Stream></Connect></Response>'
  );
});

module.exports = router;
