'use strict';

/**
 * routes/amd.js
 * POST /call/amd-result?clientCallSid=CAXX
 *
 * Twilio fires this after AMD determines human vs voicemail on the agent leg.
 * We pass clientCallSid as a query param when creating the agent call so we
 * can look it up here (async AMD does NOT send ParentCallSid).
 *
 * AnsweredBy values:
 *   "human"               → live person picked up
 *   "machine_start"       → voicemail / answering machine
 *   "machine_end_beep"    → voicemail heard the beep
 *   "machine_end_silence" / "machine_end_other" → also voicemail
 *   "fax"                 → treat as no-answer
 *   "unknown"             → couldn't determine
 */

const express  = require('express');
const router   = express.Router();
const store    = require('../store');
const transfer = require('../handlers/transferHandler');

router.post('/', async (req, res) => {
  res.sendStatus(200); // ack fast — Twilio doesn't wait

  const { CallSid, AnsweredBy } = req.body;
  // clientCallSid is passed as a query param when we create the agent call
  const clientCallSid = req.query.clientCallSid;

  console.log(`[AMD] Agent SID=${CallSid} AnsweredBy=${AnsweredBy} client=${clientCallSid}`);

  if (!clientCallSid) {
    console.warn('[AMD] No clientCallSid in query — cannot route result');
    return;
  }

  const call = store.getCall(clientCallSid);
  if (!call) {
    console.warn(`[AMD] No active call found for ${clientCallSid}`);
    return;
  }

  if (call.state !== 'TRANSFERRING') {
    console.log(`[AMD] Ignoring — call is in state ${call.state}, not TRANSFERRING`);
    return;
  }

  const DEFINITIVE_MACHINE = ['machine_end_beep'];

  if (AnsweredBy === 'human') {
    console.log('[AMD] Human detected → bridging conference');
    store.updateCall(clientCallSid, { agentAnsweredLive: true });
    await transfer.onAgentPickedUp(clientCallSid);
  } else if (DEFINITIVE_MACHINE.includes(AnsweredBy)) {
    console.log(`[AMD] Definitive machine (${AnsweredBy}) → voicemail fallback`);
    await transfer.onVoicemailDetected(clientCallSid);
  } else if (AnsweredBy === 'fax' || AnsweredBy === 'unknown') {
    console.log(`[AMD] ${AnsweredBy} → transfer failed fallback`);
    await transfer.onTransferFailed(clientCallSid);
  } else {
    // machine_start / machine_end_silence / machine_end_other — not definitive enough.
    // machine_end_silence fires when a live person is silent (e.g. listening to <Pause>).
    // The 30s post-answer timer handles actual voicemails that don't produce a beep.
    console.log(`[AMD] ${AnsweredBy} — not definitive, waiting for timer or beep`);
  }
});

module.exports = router;
