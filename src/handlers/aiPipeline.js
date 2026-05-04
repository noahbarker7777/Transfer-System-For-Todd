'use strict';

/**
 * handlers/aiPipeline.js — ERYN_BOOKING_V1
 *
 * Eryn's two-goal flow: qualifying question → booking → transfer.
 *
 * Claude emits one of four tag tokens at the end of any turn:
 *   [QUALIFY|answer=yes|no]   — fire WH1 (qualifying answer to Todd)
 *   [SCAN|time=ISO_8601]      — fire WH2 (Google Cal free/busy → 3 slots)
 *   [BOOK|index=1|2|3]        — fire WH3 (insert event) + WH4 (appt details)
 *   [TRANSFER]                — start the V4 transfer flow
 *
 * The system speaks slot offers and the booking confirmation/disclaimer
 * directly (templated for reliability). Claude handles all other dialogue.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const store     = require('../store');
const config    = require('../config');
const ghl       = require('./ghlWebhooks');

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const AGENT_SYSTEM_PROMPT_BASE = fs.readFileSync(
  path.join(__dirname, '../../system-prompt.txt'),
  'utf8'
);

const activeAudioStreams = new Map();

// ── Main entry ────────────────────────────────────────────────────────────────
async function onClientUtterance(callSid, transcript) {
  const call = store.getCall(callSid);
  if (!call) return;

  // Block AI while a transfer is in flight, the call is bridged/done, or a
  // tool call (scan/book) is awaiting a response from n8n.
  if (['TRANSFERRING', 'CONNECTED', 'DONE'].includes(call.state)) return;
  if (call.pendingTool) {
    console.log('[haiku] Ignored utterance — pendingTool=' + call.pendingTool);
    return;
  }

  console.log('[haiku] Processing: "' + transcript + '"');

  let userMessage;
  if (transcript === '__greeting__') {
    userMessage = 'The call just connected. Deliver Step 1 — the exact greeting from the script.';
  } else {
    userMessage = transcript;
  }

  const baseHistory = store.getConversation(callSid);
  const history     = [...baseHistory, { role: 'user', content: userMessage }];

  // Inject runtime context (today's date in PT + current offered slots if any)
  // so Claude can emit accurate ISO times and reason about indexes.
  const runtimeSystem = AGENT_SYSTEM_PROMPT_BASE +
    '\n\nRUNTIME CONTEXT:\n' +
    '- Current date/time in PT: ' + nowInPT() + '\n' +
    (call.offeredSlots
      ? '- Currently offered slots:\n' +
        call.offeredSlots.map((s, i) => '    ' + (i + 1) + '. ' + s.label + ' (' + s.start_iso + ')').join('\n')
      : '- No slots currently offered.');

  let response;
  try {
    response = await anthropic.messages.create({
      model:      config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_RESPONSE_TOKENS,
      system:     runtimeSystem,
      messages:   history,
    });
  } catch (err) {
    console.error('[haiku] Error:', err.message);
    return;
  }

  let aiText = response.content[0].text;
  console.log('[haiku] Response: "' + aiText + '"');

  // Parse all tags up-front so we know the action and can sanitize spoken text.
  const tag = parseTag(aiText);
  const spoken = aiText.replace(/\[(QUALIFY|SCAN|BOOK|TRANSFER)[^\]]*\]/g, '').trim();

  // Persist both turns BEFORE side effects so any partial work is auditable.
  store.addMessage(callSid, 'user',      userMessage);
  store.addMessage(callSid, 'assistant', aiText);

  // Speak whatever Claude said (minus tags). Slot/booking templates are spoken
  // separately below, AFTER the n8n response, so order matters. For a TRANSFER
  // tag, the very next step redirects the call leg — drain audio fully so the
  // pre-transfer phrase doesn't get cut off.
  if (spoken) {
    if (tag?.kind === 'TRANSFER') await speakAndDrain(callSid, spoken);
    else                          await speakToClient(callSid, spoken);
  }

  if (!tag) return;

  // ── Dispatch the tag ────────────────────────────────────────────────────
  if (tag.kind === 'QUALIFY') {
    ghl.fireQualifyingAnswer({
      callSid,
      callerName:  call.callerName,
      callerPhone: call.callerPhone,
      answer:      tag.answer === 'no' ? 'no' : 'yes',
    });
    return;
  }

  if (tag.kind === 'SCAN') {
    await handleScan(callSid, tag.time);
    return;
  }

  if (tag.kind === 'BOOK') {
    await handleBook(callSid, tag.index);
    return;
  }

  if (tag.kind === 'TRANSFER') {
    await handleTransfer(callSid, 0);  // already drained above
    return;
  }
}

// ── Tag parsing ──────────────────────────────────────────────────────────────
function parseTag(text) {
  const m = text.match(/\[(QUALIFY|SCAN|BOOK|TRANSFER)((?:\|[^\]]+)?)\]/);
  if (!m) return null;
  const kind = m[1];
  const fields = {};
  (m[2] || '').split('|').filter(Boolean).forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    fields[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  });
  if (kind === 'QUALIFY')  return { kind, answer: (fields.answer || '').toLowerCase() };
  if (kind === 'SCAN')     return { kind, time:   fields.time };
  if (kind === 'BOOK')     return { kind, index:  parseInt(fields.index, 10) };
  if (kind === 'TRANSFER') return { kind };
  return null;
}

// ── SCAN handler — fetch 3 nearest slots, speak them, store for BOOK ─────────
async function handleScan(callSid, requestedISO) {
  const call = store.getCall(callSid);
  if (!call) return;

  if (!requestedISO) {
    await speakToClient(callSid, "Sorry, I missed that — what time works best for you?");
    return;
  }

  store.updateCall(callSid, { pendingTool: 'scan' });
  let result;
  try {
    result = await ghl.scanTimes({ callSid, requestedISO });
  } catch (err) {
    console.error('[haiku] scan failed:', err.message);
    store.updateCall(callSid, { pendingTool: null });
    await speakAndDrain(callSid,
      "I'm having trouble reaching Todd's calendar. Let me transfer you to him now.");
    await handleTransfer(callSid, 0);
    return;
  }

  const slots = Array.isArray(result?.slots) ? result.slots.slice(0, 3) : [];
  if (slots.length === 0) {
    const attempts = (call.bookingAttempts || 0) + 1;
    store.updateCall(callSid, { bookingAttempts: attempts, pendingTool: null });
    if (attempts >= 2) {
      await speakAndDrain(callSid,
        "It seems we're having trouble booking. Let me transfer you to Todd for better help.");
      await handleTransfer(callSid, 0);
      return;
    }
    await speakToClient(callSid,
      "I couldn't find anything close to that. Could you give me another time?");
    store.addMessage(callSid, 'assistant',
      '(System: scan returned 0 slots near ' + requestedISO + '. Asked client for another time.)');
    return;
  }

  // Set offeredSlots BEFORE clearing pendingTool so a race-fast utterance can't
  // see a half-applied state (no slots, but AI unblocked).
  store.updateCall(callSid, { offeredSlots: slots, pendingTool: null });
  store.addMessage(callSid, 'assistant',
    '(System offered slots: ' + slots.map((s, i) => (i + 1) + ') ' + s.label).join('; ') + ')');

  const sentence = formatOffer(slots);
  await speakToClient(callSid, sentence);
}

function formatOffer(slots) {
  if (slots.length === 1) return "I have one option close to that: " + slots[0].label + ". Does that work?";
  if (slots.length === 2) return "I have two options near that time: " + slots[0].label + ", or " + slots[1].label + ". Which one works?";
  return "I have three options close to that time. Option one: " + slots[0].label +
         ". Option two: " + slots[1].label +
         ". Option three: " + slots[2].label + ". Which one works best?";
}

// ── BOOK handler — insert event, fire WH4, speak disclaimer, transfer ────────
async function handleBook(callSid, index) {
  const call = store.getCall(callSid);
  if (!call) return;

  const slots = call.offeredSlots || [];
  const slot  = slots[index - 1];
  if (!slot) {
    await speakToClient(callSid, "Sorry, which option did you want — one, two, or three?");
    return;
  }

  store.updateCall(callSid, { pendingTool: 'book' });
  let result;
  try {
    result = await ghl.bookTime({
      callSid,
      callerName:  call.callerName,
      callerPhone: call.callerPhone,
      startISO:    slot.start_iso,
      endISO:      slot.end_iso,
    });
  } catch (err) {
    console.error('[haiku] book failed:', err.message);
    store.updateCall(callSid, { pendingTool: null });
    await speakAndDrain(callSid,
      "I had trouble locking that in. Let me transfer you to Todd directly.");
    await handleTransfer(callSid, 0);
    return;
  }

  const appointmentId = result?.appointment_id || result?.id || '';
  store.updateCall(callSid, {
    bookedAppointmentId: appointmentId,
    bookedStartISO:      slot.start_iso,
    bookedStartPretty:   slot.label,
    offeredSlots:        null,
    pendingTool:         null,
  });

  // Fire WH4 — Todd's "appt booked" SMS — fire-and-forget.
  ghl.fireApptDetails({
    callSid,
    callerName:    call.callerName,
    callerPhone:   call.callerPhone,
    appointmentId,
    startISO:      slot.start_iso,
    startPretty:   slot.label,
  });

  // Speak confirmation + disclaimer — this MUST play in full before the
  // transfer redirect, or the disclaimer gets cut off mid-sentence.
  const confirmation =
    "You're booked for " + slot.label + ". " +
    "Now I'll transfer you to Todd. If he picks up, this appointment cancels automatically — " +
    "no double booking. Once I transfer you, I won't return, so enjoy your time with Todd. " +
    "Connecting you now.";
  store.addMessage(callSid, 'assistant', '(System spoke booking confirmation + disclaimer.)');
  await speakAndDrain(callSid, confirmation);

  await handleTransfer(callSid, 0);
}

// ── TRANSFER handler — kick off V4 transfer ──────────────────────────────────
// `delayMs` defaults to 2500 to cover Claude's short pre-transfer spoken phrase
// when called directly from a [TRANSFER] tag. Callers that have already drained
// their audio (via speakAndDrain) should pass 0 to avoid extra dead air.
async function handleTransfer(callSid, delayMs = 2500) {
  const call = store.getCall(callSid);
  if (!call) return;
  if (['TRANSFERRING', 'CONNECTED', 'DONE'].includes(call.state)) return;

  store.updateCall(callSid, { state: 'TRANSFERRING' });

  setTimeout(() => {
    const { onTransferSignal } = require('./transferHandler');
    onTransferSignal(callSid);
  }, delayMs);
}

// Speak a line and wait for Twilio to fully play it from its buffer before
// returning. Critical when the very next action (transfer, hangup) would
// otherwise cut the audio off mid-sentence.
//   mulaw 8kHz = 8000 bytes/s → drainMs = bytes/8 + pad.
async function speakAndDrain(callSid, text, padMs = 500) {
  const bytes = await speakToClient(callSid, text);
  if (!bytes) return;
  const drainMs = Math.ceil(bytes / 8) + padMs;
  await new Promise(r => setTimeout(r, drainMs));
}

// ── Utility: now in America/Los_Angeles ──────────────────────────────────────
function nowInPT() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' PT';
}

// ── Speak text to client via ElevenLabs → WebSocket ──────────────────────────
async function speakToClient(callSid, text) {
  if (!text || !text.trim()) return;

  const call = store.getCall(callSid);
  if (!call) return;

  const ws        = store.getMediaConnection(callSid);
  const streamSid = call.streamSid;
  if (!ws || ws.readyState !== 1 || !streamSid) return;

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

  console.log('[elevenlabs] Speaking: "' + text + '"');

  const postData = JSON.stringify({
    text,
    model_id: modelId,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  const options = {
    hostname: 'api.elevenlabs.io',
    port:     443,
    path:     '/v1/text-to-speech/' + voiceId + '/stream?output_format=ulaw_8000',
    method:   'POST',
    headers:  {
      'xi-api-key':    process.env.ELEVENLABS_API_KEY,
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errorBody = '';
        apiRes.on('data', (chunk) => { errorBody += chunk; });
        apiRes.on('end', () => {
          console.error('[elevenlabs] API error:', errorBody);
          resolve();
        });
        return;
      }

      activeAudioStreams.set(callSid, apiRes);
      let chunkCount = 0;
      let totalBytes = 0;

      apiRes.on('data', (chunk) => {
        if (activeAudioStreams.get(callSid) !== apiRes) return;
        const currentWs = store.getMediaConnection(callSid);
        if (!currentWs || currentWs.readyState !== 1) return;

        chunkCount++;
        totalBytes += chunk.length;

        currentWs.send(JSON.stringify({
          event:     'media',
          streamSid: store.getCall(callSid)?.streamSid || streamSid,
          media:     { payload: chunk.toString('base64') },
        }));
      });

      apiRes.on('end', () => {
        console.log('[elevenlabs] Done — ' + chunkCount + ' chunks, ' + totalBytes + ' bytes');
        if (activeAudioStreams.get(callSid) === apiRes) {
          activeAudioStreams.delete(callSid);
        }
        resolve(totalBytes);
      });

      apiRes.on('error', (err) => {
        console.error('[elevenlabs] Response error:', err.message);
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error('[elevenlabs] Request error:', err.message);
      resolve();
    });

    req.write(postData);
    req.end();
  });
}

// ── Interrupt any in-progress TTS when caller starts speaking ────────────────
function stopCurrentAudio(callSid) {
  activeAudioStreams.delete(callSid);
  const call = store.getCall(callSid);
  const ws   = store.getMediaConnection(callSid);
  if (ws && ws.readyState === 1 && call?.streamSid) {
    ws.send(JSON.stringify({ event: 'clear', streamSid: call.streamSid }));
  }
}

module.exports = { onClientUtterance, speakToClient, stopCurrentAudio };
