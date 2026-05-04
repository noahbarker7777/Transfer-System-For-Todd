'use strict';

const { setCall } = require('../store');

function handleInbound(req, res) {
  const callSid   = req.body.CallSid;
  const direction = (req.body.Direction || 'inbound').toLowerCase();
  // For outbound calls (Twilio-initiated) the *caller* is the dialed party (To).
  const callerNumber = direction.startsWith('outbound')
    ? (req.body.To   || 'unknown')
    : (req.body.From || 'unknown');

  // Outbound calls pass caller name/phone as query params (set by /call/outbound).
  const qName  = req.query.caller_name  || '';
  const qPhone = req.query.caller_phone || '';

  const wsUrl = process.env.SERVER_URL.replace(/^https/, 'wss') + '/media-stream';

  console.log('[inbound] New call ' + callSid + ' (' + direction + ') from ' + callerNumber +
              (qName  ? ' name="' + qName  + '"' : '') +
              (qPhone ? ' qphone="' + qPhone + '"' : ''));

  setCall(callSid, {
    state: 'GREETING',
    callerNumber,
    callerPhone: qPhone || callerNumber,  // CRM-supplied if available
    callerName:  qName  || null,

    // ── Booking-flow state (ERYN_BOOKING_V1) ──────────────────────────────
    qualifyingAnswer:    null,    // 'yes' | 'no'
    offeredSlots:        null,    // [{start_iso,end_iso,label}]
    bookingAttempts:     0,
    bookedAppointmentId: null,
    bookedStartISO:      null,
    bookedStartPretty:   null,
    pendingTool:         null,    // 'scan' | 'book' | null — blocks AI while a webhook is in flight

    // ── Transfer-flow state (TRANSFER_V4) ─────────────────────────────────
    transferStarted: false,
    conferenceName: null,
    agentCallSid: null,
    agentJoinedConference: false,
    agentAnsweredBy: null,
    fallbackTriggered: false,
    pendingFallback: false,

    streamSid: null,
  });

  const twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Connect>' +
    '<Stream url="' + wsUrl + '">' +
    '<Parameter name="callSid" value="' + callSid + '" />' +
    '</Stream>' +
    '</Connect>' +
    '</Response>';

  res.type('text/xml').send(twiml);
}

module.exports = { handleInbound };
