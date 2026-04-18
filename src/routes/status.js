/**
 * routes/status.js
 * POST /call/status         → generic Twilio call status updates
 * POST /call/agent-status   → status updates for the outbound agent leg
 * POST /call/conference-status → conference participant events
 * POST /call/recording      → recording status callback
 */

const express  = require('express');
const router   = express.Router();
const store    = require('../store');
const logging  = require('../handlers/logging');
const transfer = require('../handlers/transferHandler');

// ── Generic call status ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus, CallDuration } = req.body;

  if (CallStatus === 'completed') {
    const call = store.getCall(CallSid);
    if (call) {
      console.log(`[Status] Call ${CallSid} ended after ${CallDuration}s`);
      await logging.logOutcome(CallSid, call.state, CallDuration);
      store.deleteCall(CallSid);
    }
  }
});

// ── Agent leg status ──────────────────────────────────────────────────────────
router.post('/agent', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus, ParentCallSid } = req.body;
  const clientCallSid = ParentCallSid || CallSid;

  console.log(`[AgentStatus] Agent leg ${CallSid} → ${CallStatus}`);

  // If agent leg failed to connect at all (busy, no-answer, failed)
  // and we're still in TRANSFERRING state, trigger fallback
  if (['busy', 'no-answer', 'failed'].includes(CallStatus)) {
    const call = store.getCall(clientCallSid);
    if (call && call.state === 'TRANSFERRING') {
      console.log(`[AgentStatus] Agent leg failed (${CallStatus}) → fallback`);
      await transfer.onTransferFailed(clientCallSid);
    }
  }
});

// ── Conference participant events ─────────────────────────────────────────────
router.post('/conference', (req, res) => {
  res.sendStatus(200);
  const { FriendlyName, StatusCallbackEvent, CallSid } = req.body;
  console.log(`[Conference] ${FriendlyName} → ${StatusCallbackEvent} (${CallSid})`);
});

// ── Recording callback ────────────────────────────────────────────────────────
router.post('/recording', (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  console.log(`[Recording] Call ${CallSid} → ${RecordingUrl} (${RecordingDuration}s)`);
  store.updateCall(CallSid, { recordingUrl: RecordingUrl });
});

module.exports = router;
