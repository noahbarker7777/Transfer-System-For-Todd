'use strict';

const express = require('express');
const router = express.Router();
const store = require('../store');

router.post('/inbound-twiml', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.To;
  const conferenceName = 'conf-' + callSid;
  const wsUrl = process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

  store.setCall(callSid, {
    state: 'GREETING',
    conferenceName: conferenceName,
    callerNumber: callerNumber,
    aiLegSid: callSid,
    agentLegSid: null,
    streamSid: null,
    timer: null,
  });

  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Start>' +
    '<Stream url="' + wsUrl + '">' +
    '<Parameter name="callSid" value="' + callSid + '" />' +
    '</Stream>' +
    '</Start>' +
    '<Pause length="60"/>' +
    '</Response>';

  res.type('text/xml').send(twiml);
});

router.post('/hold-twiml', (req, res) => {
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Play loop="10">https://com.twilio.music.classical.s3.amazonaws.com/BachGavotteShort.mp3</Play></Response>');
});

router.post('/agent-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="false" beep="false">' + conferenceName + '</Conference></Dial></Response>');
});

router.post('/client-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">' + conferenceName + '</Conference></Dial></Response>');
});

router.post('/voicemail-twiml', (req, res) => {
  const caller = req.query.caller || 'a client';
  const agentName = process.env.AGENT_NAME || 'Todd';
  const companyName = process.env.COMPANY_NAME || 'the office';
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="2"/><Say voice="Polly.Joanna">Hi ' + agentName + ', this is a message from ' + companyName + '. You have a client calling from ' + caller + ' who is interested in tax services. Please call them back. Thank you.</Say></Response>');
});

module.exports = router;
