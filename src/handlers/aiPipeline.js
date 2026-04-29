'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const store     = require('../store');
const config    = require('../config');

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const AGENT_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../../system-prompt.txt'),
  'utf8'
);

// Track the active ElevenLabs stream per call so we can interrupt it
const activeAudioStreams = new Map();

// ── Main entry point: called when Deepgram produces a final transcript ────────
async function onClientUtterance(callSid, transcript) {
  const call = store.getCall(callSid);
  if (!call) return;

  // Block AI responses while transfer is in progress or call is fully handed off
  if (['TRANSFERRING', 'CONNECTED', 'DONE'].includes(call.state)) return;

  console.log('[haiku] Processing: "' + transcript + '"');

  let userMessage;
  if (transcript === '__greeting__') {
    userMessage = 'The call just connected. Greet the caller warmly and introduce yourself briefly.';
  } else if (transcript === '__fallback__') {
    // Triggered automatically after a failed transfer reconnects the AI stream
    userMessage =
      'The transfer to ' + config.AGENT_NAME +
      ' did not go through — he is unavailable right now. ' +
      'Deliver the fallback message from your script naturally and without hesitation. ' +
      'Then offer to schedule a callback appointment so he can reach the client directly.';
  } else {
    userMessage = transcript;
  }

  // Build the messages array WITHOUT mutating saved history yet — if the API
  // call throws, we don't want a dangling user turn that desyncs Anthropic's
  // strict alternation requirement on the next call.
  const baseHistory = store.getConversation(callSid);
  const history     = [...baseHistory, { role: 'user', content: userMessage }];

  try {
    const response = await anthropic.messages.create({
      model:      config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_RESPONSE_TOKENS,
      system:     AGENT_SYSTEM_PROMPT,
      messages:   history,
    });

    let aiText = response.content[0].text;
    console.log('[haiku] Response: "' + aiText + '"');

    // Parse [TRANSFER|key=value|key=value|...] — order-insensitive, optional fields.
    // Recognized keys: name, phone, taxType.
    let shouldTransfer = false;
    const transferMatch = aiText.match(/\[TRANSFER((?:\|[^\]]+)*)\]/);
    if (transferMatch) {
      shouldTransfer = true;
      // Lock state IMMEDIATELY so any background-noise transcript that arrives
      // during the upcoming awaits (extractCallerInfo + speakToClient) can't
      // kick off a parallel AI turn. The early state check at the top of this
      // function will reject those.
      store.updateCall(callSid, { state: 'TRANSFERRING' });

      const fields = {};
      (transferMatch[1] || '')
        .split('|')
        .filter(Boolean)
        .forEach(pair => {
          const eq = pair.indexOf('=');
          if (eq < 0) return;
          fields[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
        });

      const updates = {};
      // Keys are lowercased on parse (line ~73), so token "taxType" → "taxtype".
      if (fields.name)    updates.callerName  = fields.name;
      if (fields.phone)   updates.callerPhone = fields.phone;
      if (fields.taxtype) updates.taxType     = normalizeTaxType(fields.taxtype);
      if (Object.keys(updates).length) store.updateCall(callSid, updates);

      // Strip ALL transfer tokens — defends against the model emitting more than one.
      aiText = aiText.replace(/\[TRANSFER[^\]]*\]/g, '').trim();

      // If the model omitted name/phone/taxType, mine them from the conversation
      // history BEFORE the briefing fires, so Todd hears the right details.
      const current = store.getCall(callSid);
      if (current && (!current.callerName || !current.callerPhone || !current.taxType)) {
        await extractCallerInfo(callSid, history);
      }
    }

    // Persist both turns only after a successful API response.
    store.addMessage(callSid, 'user',      userMessage);
    store.addMessage(callSid, 'assistant', aiText);

    // Speak the response before triggering the transfer so the client hears it
    const audioBytes = await speakToClient(callSid, aiText);

    if (shouldTransfer) {
      // State was already locked to TRANSFERRING when [TRANSFER] was parsed
      // (see above). Just verify the call still exists and schedule the dial
      // after the audio buffer drains.
      const current = store.getCall(callSid);
      if (current && current.state === 'TRANSFERRING') {
        // Wait for Twilio to finish playing buffered audio: mulaw is 8000 bytes/sec.
        // Floor at 1500ms to cover tiny utterances ("Connecting!") where the math
        // would otherwise cut audio off mid-word.
        const computed = audioBytes ? Math.ceil((audioBytes / 8000) * 1000) + 400 : 2500;
        const audioMs  = Math.max(1500, computed);
        setTimeout(() => {
          const { onTransferSignal } = require('./transferHandler'); // lazy to avoid circular dep
          onTransferSignal(callSid);
        }, audioMs);
      } else {
        console.log('[haiku] Skipping transfer dial — state=' + current?.state);
      }
    }

  } catch (err) {
    console.error('[haiku] Error:', err.message);
  }
}

// ── Extract caller name + phone + taxType from conversation when AI omits ─────
// Fires a lightweight Claude call on the saved history. Awaited by the transfer
// flow so the agent briefing has correct details before the redirect happens.
async function extractCallerInfo(callSid, history) {
  try {
    const extraction = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 80,
      system:
        'Extract the caller\'s first and last name, phone number, and tax type ' +
        '(personal, business, or both) from this transcript. Reply ONLY with JSON ' +
        'like {"name":"John Smith","phone":"7145551234","taxType":"personal"}. ' +
        'Use null for any field not found.',
      messages:   history,
    });
    const raw = extraction.content[0].text.trim();
    const parsed = JSON.parse(raw.match(/\{.*\}/s)?.[0] || '{}');
    const updates = {};
    if (parsed.name    && parsed.name    !== 'null') updates.callerName  = parsed.name;
    if (parsed.phone   && parsed.phone   !== 'null') updates.callerPhone = parsed.phone;
    if (parsed.taxType && parsed.taxType !== 'null') updates.taxType     = normalizeTaxType(parsed.taxType);
    if (Object.keys(updates).length) {
      store.updateCall(callSid, updates);
      console.log('[extract] Caller info:', updates);
    }
  } catch (err) {
    console.error('[extract] Failed to extract caller info:', err.message);
  }
}

// Map free-form tax-type strings to a canonical value used in briefings.
function normalizeTaxType(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('both'))     return 'personal and business';
  if (s.includes('business')) return 'business';
  if (s.includes('personal')) return 'personal';
  return s.trim();
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
        if (activeAudioStreams.get(callSid) !== apiRes) return; // interrupted
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

// ── Interrupt any in-progress TTS when caller starts speaking ─────────────────
function stopCurrentAudio(callSid) {
  activeAudioStreams.delete(callSid);
  const call = store.getCall(callSid);
  const ws   = store.getMediaConnection(callSid);
  if (ws && ws.readyState === 1 && call?.streamSid) {
    ws.send(JSON.stringify({ event: 'clear', streamSid: call.streamSid }));
  }
}

module.exports = { onClientUtterance, speakToClient, stopCurrentAudio };
