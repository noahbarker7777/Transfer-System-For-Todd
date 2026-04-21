'use strict';

/**
 * routes/status.js
 * Mounted at /call/status — handles all Twilio call lifecycle events.
 *
 * POST /call/status/          → generic call status (client call ended)
 * POST /call/status/agent     → agent leg status (busy / no-answer / failed)
 * POST /call/status/conference → conference participant events (debug logging)
 * POST /call/status/recording  → recording callback
 */

const express  = require('express');
const router   = express.Router();
const store    = require('../store');
const logging  = require('../handlers/logging');
const transfer = require('../handlers/transferHandler');

// ── Generic call status (root client call) ────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (CallStatus === 'completed') {
    const call = store.getCall(CallSid);
    if (call) {
      console.log(`[Status] Call ${CallSid} completed after ${CallDuration}s`);
      await logging.logOutcome(CallSid, call.state, CallDuration);
      store.deleteCall(CallSid);
    }
  }
});

// ── Agent leg status ──────────────────────────────────────────────────────────
// clientCallSid is passed as ?clientCallSid= when we create the agent call
router.post('/agent', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus } = req.body;
  const clientCallSid = req.query.clientCallSid || req.body.ParentCallSid;

  console.log(`[AgentStatus] Agent ${CallSid} → ${CallStatus}  client=${clientCallSid}`);

  if (!clientCallSid) return;

  if (CallStatus === 'answered') {
    const call = store.getCall(clientCallSid);
    if (call && call.state === 'TRANSFERRING') {
      if (call.transferTimer) clearTimeout(call.transferTimer);
      // Bridge immediately on answer — AMD is unreliable for silent live callers.
      // agentAnsweredLive guards prevent any later timer or status from firing fallback.
      store.updateCall(clientCallSid, { agentAnsweredLive: true });
      console.log('[AgentStatus] Agent answered — bridging immediately');
      await transfer.onAgentPickedUp(clientCallSid);
    }
  }

  if (['busy', 'no-answer', 'failed'].includes(CallStatus)) {
    const call = store.getCall(clientCallSid);
    if (call && call.state === 'TRANSFERRING') {
      console.log(`[AgentStatus] Agent leg ${CallStatus} → triggering fallback`);
      await transfer.onTransferFailed(clientCallSid);
    }
  }

  if (CallStatus === 'completed') {
    const call = store.getCall(clientCallSid);
    if (call && call.state === 'TRANSFERRING' && !call.agentAnsweredLive) {
      console.log('[AgentStatus] Agent leg completed without confirmed live answer → fallback');
      await transfer.onTransferFailed(clientCallSid);
    }
  }
});

// ── Conference events ─────────────────────────────────────────────────────────
// conference-start fires when the first startConferenceOnEnter="true" participant
// joins — that's always the agent. Voicemail systems cannot join Twilio conferences,
// so this event is a 100% reliable "live human answered" signal.
router.post('/conference', async (req, res) => {
  res.sendStatus(200);
  const { FriendlyName, StatusCallbackEvent, CallSid } = req.body;
  const clientCallSid = req.query.clientCallSid;

  console.log(`[Conference] ${FriendlyName} → ${StatusCallbackEvent} (${CallSid}) client=${clientCallSid}`);

  // conference-start fires for both live humans AND voicemail systems (both can join
  // a Twilio conference), so it is NOT a reliable live-answer signal — AMD is used instead
});

// ── Recording callback ────────────────────────────────────────────────────────
router.post('/recording', (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  console.log(`[Recording] Call ${CallSid} → ${RecordingUrl} (${RecordingDuration}s)`);
  store.updateCall(CallSid, { recordingUrl: RecordingUrl });
});

module.exports = router;
