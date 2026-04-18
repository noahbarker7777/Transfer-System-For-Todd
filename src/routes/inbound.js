/**
 * routes/inbound.js
 * POST /call/inbound
 *
 * Twilio hits this endpoint the moment a client calls your number.
 * We respond with TwiML that:
 *   1. Opens a bidirectional Media Stream (so our server hears/speaks audio)
 *   2. Places the caller in a named Conference room
 *   3. Plays hold music inside the conference so there's never silence
 */

const express = require('express');
const router  = express.Router();
const config  = require('../config');
const store   = require('../store');

router.post('/', (req, res) => {
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From || '';
  const callerName  = req.body.CallerName || '';  // populated if CNAM lookup enabled

  console.log(`[Inbound] New call SID=${callSid} from=${callerPhone}`);

  // Register this call in our state store
  store.createCall(callSid);
  store.updateCall(callSid, {
    callerPhone,
    callerName: callerName || null,
    state: 'GREETING',
  });

  const conferenceName = `conf-${callSid}`;

  // TwiML response:
  // - <Stream> opens a WebSocket to our server for bidirectional audio
  // - <Conference> places the client in a room with hold music
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.headers.host}/media-stream" track="both_tracks">
      <Parameter name="callSid" value="${callSid}" />
    </Stream>
  </Start>
  <Dial>
    <Conference
      waitUrl="${config.SERVER_URL}/twiml/hold-music"
      waitMethod="GET"
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      statusCallback="${config.SERVER_URL}/call/conference-status"
      statusCallbackEvent="start end join leave"
      statusCallbackMethod="POST"
      record="record-from-start"
      recordingStatusCallback="${config.SERVER_URL}/call/recording"
    >${conferenceName}</Conference>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

module.exports = router;
