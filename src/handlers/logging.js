/**
 * handlers/logging.js
 * Logs call outcomes to HubSpot or Airtable after each call ends.
 *
 * Outcomes:
 *   "transferred"    → agent picked up and call was bridged
 *   "voicemail_left" → transfer failed, voicemail was left for agent
 *   "no_answer"      → transfer failed, no voicemail possible
 *   "completed"      → call ended normally without a transfer
 */

const config = require('../config');
const store  = require('../store');

// Map the in-memory call state to the discrete outcome strings used by the
// CRM logger. Callers pass in `call.state` (DONE / FALLBACK / QUALIFYING /
// GREETING / TRANSFERRING) — those don't match the HubSpot/Airtable schema.
function stateToOutcome(state, fallbackReason) {
  switch (state) {
    case 'DONE':
    case 'CONNECTED':    return 'transferred';
    case 'FALLBACK':
      // Refine using fallbackReason set by triggerClientFallback.
      return fallbackReason === 'voicemail' ? 'voicemail_left' : 'no_answer';
    case 'TRANSFERRING': return 'no_answer';   // bridge attempt that never finalized
    default:             return 'completed';   // GREETING / QUALIFYING / unknown
  }
}

// ── Main log function ─────────────────────────────────────────────────────────
async function logOutcome(callSid, stateOrOutcome, durationSeconds) {
  const call = store.getCall(callSid);
  // Accept either a raw state ('DONE', 'FALLBACK', ...) or a pre-mapped outcome.
  const KNOWN_OUTCOMES = ['transferred', 'voicemail_left', 'no_answer', 'completed'];
  const outcome = KNOWN_OUTCOMES.includes(stateOrOutcome)
    ? stateOrOutcome
    : stateToOutcome(stateOrOutcome, call?.fallbackReason);

  const record = {
    callSid,
    outcome,
    durationSeconds: durationSeconds || null,
    callerName:      call?.callerName  || null,
    callerPhone:     call?.callerPhone || null,
    recordingUrl:    call?.recordingUrl || null,
    timestamp:       new Date().toISOString(),
    agentName:       config.AGENT_NAME,
  };

  console.log(`[Logging] Outcome: ${outcome} (state=${stateOrOutcome}) for call ${callSid}`, record);

  // Run both in parallel (whichever is configured will succeed)
  await Promise.allSettled([
    logToHubSpot(record),
    logToAirtable(record),
  ]);
}

// ── HubSpot CRM ───────────────────────────────────────────────────────────────
async function logToHubSpot(record) {
  if (!config.HUBSPOT_API_KEY) return;  // skip if not configured

  try {
    // 1. Create or update contact
    const contactPayload = {
      properties: {
        phone:     record.callerPhone || '',
        firstname: record.callerName  || '',
        hs_lead_status: outcomeToHubSpotStatus(record.outcome),
      },
    };

    const contactRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.HUBSPOT_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(contactPayload),
    });

    const contact = await contactRes.json();
    console.log(`[HubSpot] Contact logged — ID: ${contact.id}`);

    // 2. Log a call activity on the contact
    if (contact.id) {
      const activityPayload = {
        properties: {
          hs_call_title:     `AI Transfer Call — ${record.outcome}`,
          hs_call_duration:  String((record.durationSeconds || 0) * 1000),
          hs_call_status:    record.outcome === 'transferred' ? 'COMPLETED' : 'MISSED',
          hs_call_body:      `Outcome: ${record.outcome}. Recording: ${record.recordingUrl || 'N/A'}`,
          hs_timestamp:      String(Date.now()),
        },
        associations: [{
          to: { id: contact.id },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
        }],
      };

      await fetch('https://api.hubapi.com/crm/v3/objects/calls', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.HUBSPOT_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(activityPayload),
      });
    }
  } catch (err) {
    console.error('[HubSpot] Logging error:', err.message);
  }
}

function outcomeToHubSpotStatus(outcome) {
  const map = {
    transferred:    'CONNECTED',
    voicemail_left: 'ATTEMPTED',
    no_answer:      'ATTEMPTED',
    completed:      'OPEN',
  };
  return map[outcome] || 'OPEN';
}

// ── Airtable ──────────────────────────────────────────────────────────────────
async function logToAirtable(record) {
  if (!config.AIRTABLE_API_KEY || !config.AIRTABLE_BASE_ID) return;

  try {
    await fetch(
      `https://api.airtable.com/v0/${config.AIRTABLE_BASE_ID}/Calls`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.AIRTABLE_API_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          fields: {
            'Call SID':      record.callSid,
            'Outcome':       record.outcome,
            'Caller Name':   record.callerName  || '',
            'Caller Phone':  record.callerPhone || '',
            'Duration (s)':  record.durationSeconds || 0,
            'Recording URL': record.recordingUrl || '',
            'Timestamp':     record.timestamp,
            'Agent':         record.agentName,
          },
        }),
      }
    );

    console.log(`[Airtable] Call logged`);
  } catch (err) {
    console.error('[Airtable] Logging error:', err.message);
  }
}

module.exports = { logOutcome };
