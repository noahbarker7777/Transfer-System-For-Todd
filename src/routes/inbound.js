'use strict';

const { setCall } = require('../store');

function handleInbound(req, res) {
  const callSid      = req.body.CallSid;
  const callerNumber = req.body.From || 'unknown';
  const conferenceName = `conf-${callSid}`;

  console.log(`[inbound] New call ${callSid} from ${callerNumber}`);

  setCall(callSid, {
    state:        'GREETING',
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
}

module.exports = { handleInbound };
