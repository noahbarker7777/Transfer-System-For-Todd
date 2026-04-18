'use strict';

const express = require('express');
const router = express.Router();
const store = require('../store');

router.post('/inbound-twiml', (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.To;
  const conferenceName = 'conf-' + callSid;

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
    '<Stream url="wss://' + req.headers.host + '/media-stream?callSid=' + callSid + '" />' +
    '</Start>' +
    '<Pause length="60"/>' +
    '</Response>';

  res.type('text/xml').send(twiml);
});

router.post('/hold-twiml', (req, res) => {
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Play loop="10">https://com.twilio.music.classical.s3.amazonaws.com/BachGavotteShort.mp3</Play>' +
    '</Response>';
  res.type('text/xml').send(twiml);
});

router.post('/agent-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Dial>' +
    '<Conference startConferenceOnEnter="false" endConferenceOnExit="false" beep="false">' +
    conferenceName +
    '</Conference>' +
    '</Dial>' +
    '</Response>';
  res.type('text/xml').send(twiml);
});

router.post('/client-conference-twiml', (req, res) => {
  const conferenceName = req.query.conf;
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Dial>' +
    '<Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">' +
    conferenceName +
    '</Conference>' +
    '</Dial>' +
    '</Response>';
  res.type('text/xml').send(twiml);
});

router.post('/voicemail-twiml', (req, res) => {
  const caller = req.query.caller || 'a client';
  const agentName = process.env.AGENT_NAME || 'Todd';
  const companyName = process.env.COMPANY_NAME || 'the office';
  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Pause length="2"/>' +
    '<Say voice="Polly.Joanna">' +
    'Hi ' + agentName + ', this is a message from ' + companyName + '. ' +
    'You have a client calling from ' + caller + ' who is interested in tax services. ' +
    'Please give them a call back as soon as you can. Thank you.' +
    '</Say>' +
    '</Response>';
  res.type('text/xml').send(twiml);
});

module.exports = router;
