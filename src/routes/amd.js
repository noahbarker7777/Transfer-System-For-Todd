/**
 * routes/amd.js
 * POST /call/amd-result
 *
 * Twilio fires this webhook after its Answering Machine Detection (AMD)
 * determines whether the agent leg was answered by a human or voicemail.
 *
 * AnsweredBy values from Twilio:
 *   "human"             → live person picked up
 *   "machine_start"     → voicemail / answering machine
 *   "machine_end_beep"  → voicemail, heard the beep
 *   "machine_end_silence" / "machine_end_other" → also voicemail
 *   "fax"               → fax machine (treat as no-answer)
 *   "unknown"           → couldn't determine
 */

const express  = require('express');
const router   = express.Router();
const store    = require('../store');
const transfer = require('../handlers/transferHandler');

router.post('/', async (req, res) => {
  // Acknowledge fast — Twilio doesn't wait for our processing
  res.sendStatus(200);

  const { CallSid, AnsweredBy, ParentCallSid } = req.body;

  // The agent call's SID is CallSid; the original client call is ParentCallSid
  // (Twilio sets ParentCallSid on outbound calls created via the REST API)
  const clientCallSid = ParentCallSid || CallSid;

  console.log(`[AMD] Result for client=${clientCallSid}: AnsweredBy=${AnsweredBy}`);

  const call = store.getCall(clientCallSid);
  if (!call) {
    console.warn(`[AMD] No active call found for SID ${clientCallSid}`);
    return;
  }

  // Guard: only act if we're still waiting on a transfer result
  if (call.state !== 'TRANSFERRING') {
    console.log(`[AMD] Ignoring — call is in state ${call.state}, not TRANSFERRING`);
    return;
  }

  const isHuman = AnsweredBy === 'human';

  if (isHuman) {
    console.log(`[AMD] Human detected → bridging agent into conference`);
    await transfer.onAgentPickedUp(clientCallSid);
  } else {
    console.log(`[AMD] Voicemail/no-answer detected → fallback`);
    await transfer.onVoicemailDetected(clientCallSid);
  }
});

module.exports = router;
