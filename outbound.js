'use strict';

const express = require('express');
const router  = express.Router();
const { setCall } = require('../store');

const twilio = require('twilio');
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// POST /call/outbound
// Called by GHL webhook when a contact needs to be called
// Body: { "to": "+1XXXXXXXXXX" }

router.post('/outbound', async (req, res) => {
  const to = req.body.to || req.body.phone || req.body.contact_phone;

  if (!to) {
    console.error('[outbound] No phone number provided');
    return res.status(400).json({ error: 'No phone number provided' });
  }

  // Clean the number — remove spaces, dashes, parentheses
  const cleaned = to.replace(/[\s\-\(\)]/g, '');
  // Add +1 if not already there
  const formatted = cleaned.startsWith('+') ? cleaned : `+1${cleaned}`;

  console.log(`[outbound] Calling client: ${formatted}`);

  try {
    const call = await client.calls.create({
      to:   formatted,
      from: process.env.TWILIO_PHONE_NUMBER,
      // When client picks up, treat it exactly like an inbound call
      url:  `${process.env.SERVER_URL}/call/inbound-twiml`,
      statusCallback:       `${process.env.SERVER_URL}/call/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['initiated', 'ringing', 'answered', 'completed'],
    });

    console.log(`[outbound] Call created: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid });

  } catch (err) {
    console.error('[outbound] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
