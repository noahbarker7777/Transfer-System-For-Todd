'use strict';

const { getCall, updateCall } = require('../store');
const { muteParticipant, kickParticipant, leaveVoicemail } = require('../twilioClient');
const { signalAI } = require('../handlers/aiSignal');

async function handleAmdResult(req, res) {
  const parentCallSid = req.query.parentCallSid;
  const answeredBy    = req.body.AnsweredBy;

  console.log(`[amd] Result for ${parentCallSid}: ${answeredBy}`);

  const call = getCall(parentCallSid);
  if (!call) return res.sendStatus(200);

  if (call.state !== 'TRANSFERRING') return res.sendStatus(200);

  if (call.timer) clearTimeout(call.timer);

  if (answeredBy === 'human') {
    updateCall(parentCallSid, { state: 'CONNECTED' });
    await muteParticipant(call.conferenceName, call.aiLegSid, false);
    signalAI(parentCallSid, { action: 'INTRODUCE' });
    setTimeout(async () => {
      await kickParticipant(call.conferenceName, call.aiLegSid);
      updateCall(parentCallSid, { state: 'DONE' });
    }, 10000);
  } else {
    updateCall(parentCallSid, { state: 'FALLBACK' });
    await muteParticipant(call.conferenceName, call.aiLegSid, false);
    signalAI(parentCallSid, { action: 'FALLBACK' });
    leaveVoicemail(parentCallSid, call.callerNumber);
  }

  res.sendStatus(200);
}

module.exports = { handleAmdResult };
