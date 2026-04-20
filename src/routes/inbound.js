'use strict';

const { setCall } = require('../store');

function handleInbound(req, res) {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || req.body.To || 'unknown';
  const wsUrl = process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

  console.log('[inbound] New call ' + callSid + ' from ' + callerNumber);

  setCall(callSid, {
    state: 'GREETING',
    conferenceName: 'conf-' + callSid,
    callerNumber: callerNumber,
    callerPhone: callerNumber, // default to caller ID; AI may override with confirmed number
    callerName: null,
    aiLegSid: callSid,
    agentCallSid: null,
    streamSid: null,
    pendingFallback: false,
    transferTimer: null,
  });

  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Connect>' +
    '<Stream url="' + wsUrl + '">' +
    '<Parameter name="callSid" value="' + callSid + '" />' +
    '</Stream>' +
    '</Connect>' +
    '</Response>';

  res.type('text/xml').send(twiml);
}

module.exports = { handleInbound };
