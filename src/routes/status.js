'use strict';

/**
 * routes/status.js — ERYN_BOOKING_V1 (over TRANSFER_V4 plumbing)
 *
 * Mounted at /call/status.
 *
 * Sub-routes:
 *   POST /             — root client call lifecycle (cleanup on completed)
 *   POST /agent        — Todd's outbound call lifecycle (decides success/fail)
 *   POST /conference   — conference participant events (drives agentJoinedConference)
 *   POST /recording    — recording callbacks (kept for future use)
 *
 * Outcome routing per spec:
 *   - Todd bridges        → WH5 (cancel appt + SMS Todd "appt canceled, you're on the line")
 *   - Todd never bridges  → WH6 (keep appt + SMS Todd "missed call, appt still booked")
 *                            then HANG UP both legs — no callback to client.
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const twilio  = require('../twilioClient');
const logging = require('../handlers/logging');
const ghl     = require('../handlers/ghlWebhooks');

// Track which Todd-outcome webhook we've already fired per call to keep them
// idempotent across retried Twilio status callbacks.
const outcomeFired = new Map();   // clientCallSid → 'success' | 'failed'

function markFired(callSid, kind) {
  if (outcomeFired.get(callSid)) return false;
  outcomeFired.set(callSid, kind);
  return true;
}

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
  outcomeFired.delete(CallSid);
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

  const updatedCall = store.getCall(clientCallSid);
  if (!updatedCall) return;

  // Same backstop as before: long-duration human-answered calls almost
  // certainly bridged even if the conference webhook hasn't landed.
  const durationSec = parseInt(CallDuration || '0', 10);
  const ab          = (updatedCall.agentAnsweredBy || AnsweredBy || '').toLowerCase();
  const probablyBridged = updatedCall.agentJoinedConference ||
                          (ab === 'human' && durationSec > 25);

  if (probablyBridged) {
    console.log('[Status/Agent] Todd bridged (duration=' + durationSec + 's)');
    if (markFired(clientCallSid, 'success')) {
      ghl.fireToddSuccess({
        callSid:        clientCallSid,
        callerName:     updatedCall.callerName,
        callerPhone:    updatedCall.callerPhone,
        appointmentId:  updatedCall.bookedAppointmentId,
        startPretty:    updatedCall.bookedStartPretty,
      });
    }
    store.updateCall(clientCallSid, { state: 'DONE' });
    return;
  }

  // Todd did not bridge — voicemail / no-answer / abandoned briefing.
  console.log('[Status/Agent] Todd did NOT bridge — firing WH6 + hanging up client');

  if (markFired(clientCallSid, 'failed')) {
    ghl.fireToddFailed({
      callSid:        clientCallSid,
      callerName:     updatedCall.callerName,
      callerPhone:    updatedCall.callerPhone,
      appointmentId:  updatedCall.bookedAppointmentId,
      startPretty:    updatedCall.bookedStartPretty,
    });
  }

  // Per spec: do NOT call the client back to AI. Hang up both legs.
  store.updateCall(clientCallSid, { state: 'DONE' });
  await twilio.hangupCall(clientCallSid);
});

// ── Conference participant events ─────────────────────────────────────────────
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
    const stateUpdate = ['DONE'].includes(call.state) ? {} : { state: 'CONNECTED' };
    store.updateCall(clientCallSid, { agentJoinedConference: true, ...stateUpdate });
    console.log('[Status/Conference] Todd joined → bridge live');

    // Fire WH5 the moment we know Todd is on the line. Idempotent so the
    // /agent completed callback won't double-fire it.
    if (markFired(clientCallSid, 'success')) {
      ghl.fireToddSuccess({
        callSid:        clientCallSid,
        callerName:     call.callerName,
        callerPhone:    call.callerPhone,
        appointmentId:  call.bookedAppointmentId,
        startPretty:    call.bookedStartPretty,
      });
    }
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
