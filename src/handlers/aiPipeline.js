'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const store     = require('../store');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
      'The transfer to ' + (process.env.AGENT_NAME || 'Todd') +
      ' did not go through — he is unavailable right now. ' +
      'Deliver the fallback message from your script naturally and without hesitation. ' +
      'Then offer to schedule a callback appointment so he can reach the client directly.';
  } else {
    userMessage = transcript;
  }

  store.addMessage(callSid, 'user', userMessage);
  const history = store.getConversation(callSid).filter(m => m.content !== '__init__');

  try {
    const response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: parseInt(process.env.MAX_RESPONSE_TOKENS || '150'),
      system:     AGENT_SYSTEM_PROMPT,
      messages:   history,
    });

    let aiText = response.content[0].text;
    console.log('[haiku] Response: "' + aiText + '"');

    // Parse [TRANSFER|name=First Last|phone=1234567890] signal
    let shouldTransfer = false;
    const transferMatch = aiText.match(/\[TRANSFER(?:\|name=([^|\]]+))?(?:\|phone=([^|\]]+))?\]/);
    if (transferMatch) {
      shouldTransfer = true;
      const callerName  = (transferMatch[1] || '').trim();
      const callerPhone = (transferMatch[2] || '').trim();
      if (callerName)  store.updateCall(callSid, { callerName });
      if (callerPhone) store.updateCall(callSid, { callerPhone });
      aiText = aiText.replace(transferMatch[0], '').trim();
    }

    store.addMessage(callSid, 'assistant', aiText);

    // Speak the response before triggering the transfer so the client hears it
    await speakToClient(callSid, aiText);

    if (shouldTransfer) {
      // Re-read state — speakToClient is async and state could have changed
      const current = store.getCall(callSid);
      if (current && current.state === 'QUALIFYING') {
        // Brief pause so speech finishes, then kick off the transfer
        setTimeout(() => {
          const { onTransferSignal } = require('./transferHandler'); // lazy to avoid circular dep
          onTransferSignal(callSid);
        }, 1500);
      }
    }

  } catch (err) {
    console.error('[haiku] Error:', err.message);
  }
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
        resolve();
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
