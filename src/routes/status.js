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

  if (['busy', 'no-answer', 'failed', 'completed'].includes(CallStatus)) {
    const call = store.getCall(clientCallSid);
    if (call && call.state === 'TRANSFERRING') {
      console.log(`[AgentStatus] Agent leg ${CallStatus} → triggering fallback`);
      await transfer.onTransferFailed(clientCallSid);
    }
  }
});

// ── Conference events (debug logging only) ────────────────────────────────────
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
