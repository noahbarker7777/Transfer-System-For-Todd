'use strict';

const express = require('express');
const router  = express.Router();

// ── Outbound call answered — treat exactly like an inbound call ───────────────
// When GHL triggers an outbound call and the client picks up, this fires
router.post('/inbound-twiml', (req, res) => {
  const callSid      = req.body.CallSid;
  const callerNumber = req.body.To; // outbound: the client's number is the "To"
  const conferenceName = `conf-${callSid}`;

  const { setCall } = require('../store');
  setCall(callSid, {
    state: 'GREETING',
    conferenceName,
    callerNumber,
    aiLegSid:    callSid,
    agentLegSid: null,
    streamSid:   null,
    timer:       null,
  });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.headers.host}/media-stream?callSid=${callSid}" />
  </Start>
  <Dial>
    <Conference
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      waitUrl="${process.env.SERVER_URL}/call/hold-twiml"
      waitMethod="POST"
      beep="false">
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ── Hold music — plays to the caller while the agent leg is being dialed ──────
router.post('/hold-twiml', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="10">https://com.twilio.music.classical.s3.amazonaws.com/BachGavotteShort.mp3</Play>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ── Agent conference — agent joins the same named room as the caller ──────────
router.post('/agent-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      startConferenceOnEnter="false"
      endConferenceOnExit="false"
      beep="false">
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ── Client conference — used if caller needs to be re-entered into the room ───
router.post('/client-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      startConferenceOnEnter="true"
      endConferenceOnExit="true"
      beep="false">
      ${conferenceName}
    </Conference>
  </Dial>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ── Voicemail — plays on a separate silent call leg to the agent ──────────────
// The caller never hears this. It fires in the background during fallback.
router.post('/voicemail-twiml', (req, res) => {
  const caller      = req.query.caller  || 'a client';
  const agentName   = process.env.AGENT_NAME   || 'Todd';
  const companyName = process.env.COMPANY_NAME || 'the office';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Say voice="Polly.Joanna">
    Hi ${agentName}, this is a message from ${companyName}.
    You have a client calling from ${caller} who is interested in tax services.
    Please give them a call back as soon as you can. Thank you.
  </Say>
</Response>`;
  res.type('text/xml').send(twiml);
});

module.exports = router;
