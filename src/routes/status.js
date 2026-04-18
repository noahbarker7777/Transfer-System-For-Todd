'use strict';

const { getCall, updateCall } = require('../store');
const { logOutcome } = require('../handlers/logging');

async function handleStatus(req, res) {
  const parentCallSid = req.query.parentCallSid;
  const callStatus    = req.body.CallStatus;
  const callSid       = req.body.CallSid;

  console.log(`[status] ${callSid} → ${callStatus}`);

  if (!parentCallSid) return res.sendStatus(200);

  const call = getCall(parentCallSid);
  if (!call) return res.sendStatus(200);

  if (callSid === parentCallSid && callStatus === 'completed') {
    await logOutcome(parentCallSid, call.state, {
      callerNumber: call.callerNumber,
    });
    updateCall(parentCallSid, { state: 'DONE' });
  }

  res.sendStatus(200);
}

module.exports = { handleStatus };
