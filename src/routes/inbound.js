'use strict';

const { setCall } = require('../store');

function handleInbound(req, res) {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || req.body.To || 'unknown';
  const conferenceName = 'conf-' + callSid;
  const wsUrl = process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

  console.log('[inbound] New call ' + callSid + ' from ' + callerNumber);

  setCall(callSid, {
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
    '<Dial>' +
    '<Conference ' +
    'startConferenceOnEnter="true" ' +
    'endConferenceOnExit="true" ' +
    'waitUrl="' + process.env.SERVER_URL + '/call/hold-twiml" ' +
    'waitMethod="POST" ' +
    'beep="false">' +
    conferenceName +
    '</Conference>' +
    '</Dial>' +
    '</Response>';

  res.type('text/xml').send(twiml);
}

module.exports = { handleInbound };
