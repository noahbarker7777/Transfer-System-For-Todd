'use strict';

/**
 * routes/status.js — TRANSFER_V4
 *
 * Mounted at /call/status.
 *
 * Sub-routes:
 *   POST /             — root client call lifecycle (cleanup on completed)
 *   POST /agent        — Todd's outbound call lifecycle (decides fallback)
 *   POST /conference   — conference participant events (drives agentJoinedConference)
 *   POST /recording    — recording callbacks (kept for future use)
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const twilio  = require('../twilioClient');
const logging = require('../handlers/logging');
const { triggerClientFallback } = require('../handlers/transferHandler');

// ── Root client call lifecycle ────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus, CallDuration } = req.body;
  if (CallStatus !== 'completed') return;

  const call = store.getCall(CallSid);
  if (!call) return;

  console.log('[Status] Client ' + CallSid + ' completed (' + CallDuration + 's)');

  // If the client hangs up while Todd's outbound leg is still ringing or
  // being-AMD'd, cancel Todd's call so his phone doesn't keep ringing into
  // a void.
  if (call.agentCallSid && !call.agentJoinedConference) {
    console.log('[Status] Client gone — cancelling Todd leg ' + call.agentCallSid);
    await twilio.hangupCall(call.agentCallSid);
  }

  await logging.logOutcome(CallSid, call.state, CallDuration);
  store.deleteCall(CallSid);
});

// ── Todd's outbound call lifecycle ────────────────────────────────────────────
// Fires for 'answered' and 'completed' (per dialAgentWithAMD config).
router.post('/agent', async (req, res) => {
  res.sendStatus(200);

  const clientCallSid = req.query.clientCallSid;
  const {
    CallSid:       agentCallSid,
    CallStatus,
    CallDuration,
    AnsweredBy,
  } = req.body;

  console.log('[Status/Agent] client=' + clientCallSid +
              ' agent=' + agentCallSid +
              ' status=' + CallStatus +
              ' duration=' + CallDuration +
              ' answeredBy=' + AnsweredBy);

  const call = store.getCall(clientCallSid);
  if (!call) {
    console.log('[Status/Agent] No client record — ignoring');
    return;
  }

  if (AnsweredBy && !call.agentAnsweredBy) {
    store.updateCall(clientCallSid, { agentAnsweredBy: AnsweredBy });
  }

  if (CallStatus !== 'completed') return;

  // Only act on completed. If Todd successfully bridged, the conference
  // status callback will have set agentJoinedConference = true.
  const updatedCall = store.getCall(clientCallSid);
  if (!updatedCall) return;

  // Primary signal: conference participant-join wrote agentJoinedConference.
  // Backstop for webhook reordering: a human-answered call that lasted longer
  // than the briefing (~5s) almost certainly reached the bridge — even if the
  // conference webhook hasn't landed yet.
  const durationSec = parseInt(CallDuration || '0', 10);
  const ab          = (updatedCall.agentAnsweredBy || AnsweredBy || '').toLowerCase();
  const probablyBridged = updatedCall.agentJoinedConference ||
                          (ab === 'human' && durationSec > 8);

  if (probablyBridged) {
    console.log('[Status/Agent] Todd bridged & ended cleanly (duration=' + durationSec + 's)');
    store.updateCall(clientCallSid, { state: 'DONE' });
    return;
  }

  // Todd didn't bridge. Decide why so we can SMS Todd the right context and
  // tell the client what happened (Eryn's __fallback__ script handles wording).
  // Mirror the bridge-vs-voicemail decision from /agent-pickup: 'unknown' is
  // treated as voicemail there, so we tag it the same way here for consistent
  // CRM logging and SMS wording.
  let reason;
  if (ab.startsWith('machine') || ab === 'fax' || ab === 'unknown') {
    reason = 'voicemail';
  } else if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed') {
    reason = 'no-answer';
  } else {
    reason = 'abandoned';   // human answered but never reached the bridge
  }

  // Backup SMS noting the missed transfer outcome.
  twilio.smsBriefing({
    callerName:  updatedCall.callerName,
    callerPhone: updatedCall.callerPhone,
    taxType:     updatedCall.taxType,
    context:     reason === 'voicemail' ? 'voicemail' : 'no-answer',
  }).catch(err => console.error('[Status/Agent] SMS error:', err.message));

  await triggerClientFallback(clientCallSid, reason);
});

// ── Conference participant events ─────────────────────────────────────────────
// We watch for participant-join with CallSid === stored agentCallSid; that
// is the single source of truth for "Todd actually bridged". The agent call's
// completed callback reads the resulting flag.
router.post('/conference', (req, res) => {
  res.sendStatus(200);

  const clientCallSid = req.query.clientCallSid;
  const event         = req.body.StatusCallbackEvent;
  const eventCallSid  = req.body.CallSid;

  console.log('[Status/Conference] client=' + clientCallSid +
              ' event=' + event +
              ' eventCallSid=' + eventCallSid);

  if (event !== 'participant-join') return;

  const call = store.getCall(clientCallSid);
  if (!call) return;
  if (!call.agentCallSid) return;

  if (eventCallSid === call.agentCallSid) {
    // Always set agentJoinedConference (single source of truth for bridge happened).
    // But don't downgrade FALLBACK/DONE state — handles webhook reordering where
    // the agent's completed callback raced ahead of this participant-join event.
    const stateUpdate = ['FALLBACK', 'DONE'].includes(call.state)
      ? {}
      : { state: 'CONNECTED' };
    store.updateCall(clientCallSid, { agentJoinedConference: true, ...stateUpdate });
    console.log('[Status/Conference] Todd joined → bridge live');
  }
});

// ── Recording callback ────────────────────────────────────────────────────────
router.post('/recording', (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  console.log('[Recording] Call ' + CallSid + ' → ' + RecordingUrl +
              ' (' + RecordingDuration + 's)');
  store.updateCall(CallSid, { recordingUrl: RecordingUrl });
});

module.exports = router;
