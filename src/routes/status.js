'use strict';

/**
 * routes/status.js
 * Mounted at /call/status.
 *
 * The new warm-transfer architecture uses a single <Dial> with action URL,
 * so there is no separate agent leg, no AMD, no conference. Callbacks here
 * exist only to log and clean up the client call when it ends.
 */

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const logging = require('../handlers/logging');

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

// ── Legacy agent-leg status (no-op, logs only) ────────────────────────────────
router.post('/agent', (req, res) => {
  res.sendStatus(200);
  console.log('[AgentStatus-Legacy] Ignored:', JSON.stringify(req.body));
});

// ── Legacy conference events (no-op, logs only) ───────────────────────────────
router.post('/conference', (req, res) => {
  res.sendStatus(200);
  console.log('[Conference-Legacy] Ignored:', JSON.stringify(req.body));
});

// ── Recording callback ────────────────────────────────────────────────────────
router.post('/recording', (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  console.log(`[Recording] Call ${CallSid} → ${RecordingUrl} (${RecordingDuration}s)`);
  store.updateCall(CallSid, { recordingUrl: RecordingUrl });
});

module.exports = router;
