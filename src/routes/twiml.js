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

// Speak phone numbers digit-by-digit so TTS doesn't read "7145551234" as a year.
function spellPhone(p) {
  return String(p).replace(/\D/g, '').split('').join(' ');
}

// Compose the human-pickup briefing (paced for clarity, includes name + number).
// Designed to be used as the prompt body inside <Gather>; ends with the explicit
// "press 1 to accept" cue so Todd knows what action is required to bridge.
function humanBriefingTwiml({ callerName, callerPhone, taxType }) {
  const agent   = config.AGENT_NAME || 'Todd';
  const name    = callerName  || 'a client';
  const subject = taxType ? (taxType + ' taxes') : 'tax services';
  const digits  = String(callerPhone || '').replace(/\D/g, '');
  const numLine = digits.length >= 10
    ? ' Their callback number is ' + spellPhone(digits) + '.'
    : '';

  return [
    '<Pause length="1"/>',
    '<Say voice="' + VOICE + '">Hi ' + xmlEscape(agent) + ', this is your assistant.</Say>',
    '<Pause length="1"/>',
    '<Say voice="' + VOICE + '">' + xmlEscape(name + ' is on the line about ' + subject + '.' + numLine) + '</Say>',
    '<Pause length="1"/>',
    '<Say voice="' + VOICE + '">Press one or say accept to take the call. Otherwise, hang up or stay silent.</Say>',
  ].join('');
}

// Compose the voicemail briefing (no response required — speak then hang up).
// Leading pause covers any tail of the greeting that AMD didn't fully wait out.
function voicemailBriefingTwiml({ callerName, callerPhone, taxType }) {
  const agent   = config.AGENT_NAME || 'Todd';
  const company = config.COMPANY_NAME || 'Frazier Industries';
  const name    = callerName  || 'a client';
  const subject = taxType ? (taxType + ' taxes') : 'tax services';
  const digits  = String(callerPhone || '').replace(/\D/g, '');
  const numLine = digits.length >= 10
    ? ' Their callback number is ' + spellPhone(digits) + '.'
    : '';

  return [
    '<Pause length="2"/>',
    '<Say voice="' + VOICE + '">Hi ' + xmlEscape(agent) + ', this is your ' + xmlEscape(company) + ' assistant.</Say>',
    '<Say voice="' + VOICE + '">' + xmlEscape(name + ' just called about ' + subject + '.' + numLine) + '</Say>',
    '<Say voice="' + VOICE + '">Please call them back as soon as you can. Goodbye.</Say>',
  ].join('');
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

  // Cap the conference Dial at 60s so a stuck/stalled flow doesn't leave the
  // caller on hold music indefinitely. AMD timeout (30s) + ring (15s) +
  // briefing/Gather (~17s) ≈ 60s worst-case. If we hit the cap, status.js
  // will see no participant-join and trigger fallback via the agent
  // completed callback.
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say voice="' + VOICE + '">Please hold for just a moment while I bring ' +
        xmlEscape(agent) + ' on the line.</Say>' +
      '<Dial timeout="60">' +
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
// HUMAN BRANCH:
//   Gather plays the briefing in full (Twilio guarantees the prompt completes
//   before moving on), then waits up to 10 seconds for Todd to RESPOND — either
//   press 1 / press any digit, or say "accept"/"yes"/"ok". Action URL is
//   /agent-decision, which decides bridge-vs-fallback based on what Todd did.
//   The bridge URL is only ever returned by /agent-decision when Todd actually
//   responds — there is no code path where the conference dial executes
//   without an explicit acceptance.
//
// VOICEMAIL BRANCH:
//   AnsweredBy=machine_* / fax / unknown → leave the briefing as a voicemail
//   then hang up. Status callback fires fallback for the client afterward.
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

  // Voicemail: anything that isn't clearly a human answers here.
  const isMachine = answeredBy.startsWith('machine') ||
                    answeredBy === 'fax' ||
                    answeredBy === 'unknown';

  if (isMachine) {
    console.log('[agent-pickup V4] machine detected → leaving voicemail');
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' + voicemailBriefingTwiml(briefingPayload) + '<Hangup/></Response>'
    );
  }

  // Human pickup — brief Todd, then wait for him to accept before bridging.
  const decisionUrl = process.env.SERVER_URL + '/call/agent-decision?' +
                      new URLSearchParams({ conf, clientCallSid }).toString();

  console.log('[agent-pickup V4] human → briefing then awaiting accept');
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Gather input="speech dtmf" numDigits="1" speechTimeout="auto" ' +
              'timeout="10" finishOnKey="" ' +
              'action="' + decisionUrl + '" method="POST">' +
        humanBriefingTwiml(briefingPayload) +
      '</Gather>' +
      // Belt-and-suspenders: if Gather returns without firing the action URL
      // (e.g. transient Twilio issue), redirect to the same decision endpoint
      // so the no-response path still triggers fallback rather than hanging.
      '<Redirect method="POST">' + decisionUrl + '</Redirect>' +
    '</Response>'
  );
});

// ── Decision endpoint — Todd's response decides bridge vs fallback ────────────
// Fired by Gather's action URL with either Digits (press) or SpeechResult (voice).
//   accepted ('1' or "accept"/"yes"/"ok"/etc.) → return <Dial><Conference>
//   anything else / no input                   → say goodbye + <Hangup/>; the
//                                                agent-call status callback
//                                                will then trigger client fallback.
router.post('/agent-decision', (req, res) => {
  const conf          = req.query.conf;
  const clientCallSid = req.query.clientCallSid;
  const digits        = (req.body.Digits || '').trim();
  const speech        = (req.body.SpeechResult || '').toLowerCase().trim();

  const accepted = digits === '1' ||
                   /\b(accept|accepted|yes|yeah|yep|yup|ok|okay|sure|connect|connected)\b/.test(speech);

  console.log('[agent-decision V4] client=' + clientCallSid +
              ' digits="' + digits + '"' +
              ' speech="' + speech + '"' +
              ' accepted=' + accepted);

  if (accepted) {
    return res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
        '<Say voice="' + VOICE + '">Connecting you now.</Say>' +
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
  }

  // Declined or no response — hang up Todd's leg politely. The /call/status/agent
  // completed callback will see agentJoinedConference=false and trigger the
  // client fallback (Eryn will deliver the "Todd was unavailable" script).
  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say voice="' + VOICE + '">Okay, I will let them know. Goodbye.</Say>' +
      '<Hangup/>' +
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
