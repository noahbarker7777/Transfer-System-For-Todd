'use strict';

/**
 * routes/outbound.js
 *
 * GHL workflow hits POST /call/outbound to start an Eryn call to a client.
 *
 * Expected body (form or JSON):
 *   caller_name:  "Bernard Smith"   (required)
 *   caller_phone: "+15551234567"    (required, E.164 preferred)
 *
 * We dial the client via Twilio REST. When they pick up, Twilio fetches
 * /call/inbound which returns the MediaStream TwiML — same entry point as
 * inbound calls, so the Eryn flow is identical from there.
 *
 * Caller name/phone are passed through as query params on the AnswerUrl so
 * /call/inbound can store them on the call record before Eryn speaks.
 */

const express = require('express');
const router  = express.Router();
const config  = require('../config');
const twilio  = require('twilio');

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

router.post('/', async (req, res) => {
  // Accept several common key spellings so different upstream callers
  // (GHL workflow vs. n8n vs. direct) all work without renaming fields.
  const callerName  = req.body.caller_name  || req.body.callerName  ||
                      req.body.name         || '';
  const callerPhone = req.body.caller_phone || req.body.callerPhone ||
                      req.body.phone        || req.body.to          || '';

  if (!callerPhone) {
    return res.status(400).json({ ok: false, error: 'caller_phone required' });
  }

  const params = new URLSearchParams({
    caller_name:  callerName,
    caller_phone: callerPhone,
  }).toString();

  const answerUrl = config.SERVER_URL + '/call/inbound?' + params;
  const statusUrl = config.SERVER_URL + '/call/status';

  try {
    const call = await client.calls.create({
      to:     callerPhone,
      from:   config.TWILIO_PHONE_NUMBER,
      url:    answerUrl,
      method: 'POST',
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['initiated', 'answered', 'completed'],
    });
    console.log('[outbound] Started Eryn call to ' + callerPhone +
                ' (name="' + callerName + '") → SID ' + call.sid);
    res.json({ ok: true, call_sid: call.sid });
  } catch (err) {
    console.error('[outbound] Twilio create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
