'use strict';

const { setCall } = require('../store');

function handleInbound(req, res) {
  const callSid   = req.body.CallSid;
  const direction = (req.body.Direction || 'inbound').toLowerCase();
  // For outbound calls (Twilio-initiated) the *caller* is the dialed party (To).
  const callerNumber = direction.startsWith('outbound')
    ? (req.body.To   || 'unknown')
    : (req.body.From || 'unknown');
  const wsUrl = process.env.SERVER_URL.replace(/^https/, 'wss') + '/media-stream';

  console.log('[inbound] New call ' + callSid + ' (' + direction + ') from ' + callerNumber);

  setCall(callSid, {
    state: 'GREETING',
    callerNumber,
    callerPhone: callerNumber, // default; AI may override with confirmed number
    callerName: null,
    taxType: null,

    // ── Transfer-flow state (TRANSFER_V4) ─────────────────────────────────
    transferStarted: false,
    conferenceName: null,
    agentCallSid: null,
    agentJoinedConference: false,
    agentAnsweredBy: null,
    fallbackTriggered: false,
    pendingFallback: false,

    streamSid: null,
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
