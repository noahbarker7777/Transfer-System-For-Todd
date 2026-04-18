'use strict';

const express = require('express');
const router = express.Router();

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
