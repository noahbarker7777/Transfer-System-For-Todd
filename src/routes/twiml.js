/**
 * routes/twiml.js
 * Serves TwiML snippets used at various points in the call flow.
 *
 * GET  /twiml/hold-music        → plays while transfer is being attempted
 * GET  /twiml/join-conference   → agent joins the client's conference room
 * GET  /twiml/health            → simple health check endpoint
 */

const express = require('express');
const router  = express.Router();
const config  = require('../config');

// ── Hold music (client hears this during transfer attempt) ───────────────────
// Replace HOLD_MUSIC_URL with a direct MP3 link — keep it short and loop-able.
// Free options: upload a short .mp3 to your Railway static files or use Twilio's built-in.
const HOLD_MUSIC_URL = process.env.HOLD_MUSIC_URL ||
  'https://com.twilio.sounds.music.us1.twilio.com/BO8e935bafc4ad3cdf6da02c67bfb45d58';

router.get('/hold-music', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="10">${HOLD_MUSIC_URL}</Play>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ── Agent joins conference ────────────────────────────────────────────────────
// Twilio calls this URL when the agent answers the outbound dial.
router.get('/join-conference', (req, res) => {
  const conferenceName = req.query.conf || '';
  if (!conferenceName) {
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      startConferenceOnEnter="false"
      endConferenceOnExit="false"
      beep="false"
    >${conferenceName}</Conference>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ── Health check ──────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ai-transfer-system', ts: new Date().toISOString() });
});

module.exports = router;
