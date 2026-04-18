'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getCall, updateCall, setMediaConnection } = require('../store');
const { onClientUtterance, stopCurrentAudio }     = require('./aiPipeline');

function handleMediaStream(ws, req) {
  // Pull callSid from the WebSocket URL query string
  const url     = new URL(req.url, 'http://localhost');
  const callSid = url.searchParams.get('callSid');

  if (!callSid) {
    console.error('[media] No callSid provided in WebSocket URL — closing');
    ws.close();
    return;
  }

  console.log(`[media] Stream opened for call ${callSid}`);

  // Store this WebSocket so aiPipeline can send audio back into it
  setMediaConnection(callSid, ws);

  // ── Step 2 — Start Deepgram live transcription session ───────────────────
  const deepgram    = createClient(process.env.DEEPGRAM_API_KEY);
  const dgConnection = deepgram.listen.live({
    model:           process.env.DEEPGRAM_MODEL    || 'nova-2',
    language:        process.env.DEEPGRAM_LANGUAGE || 'en-US',
    smart_format:    true,
    interim_results: true,
    endpointing:     parseInt(process.env.DEEPGRAM_ENDPOINTING       || '300'),  // ms silence = end of utterance
    utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS || '1000'), // hard cutoff
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[deepgram] Session open for ${callSid}`);

    // Send the opening greeting as soon as Deepgram is ready
    const call = getCall(callSid);
    if (call && call.state === 'GREETING') {
      updateCall(callSid, { state: 'QUALIFYING' });
      onClientUtterance(callSid, '__greeting__');
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || !transcript.trim()) return;

    const speechFinal = data.speech_final;
    const isFinal     = data.is_final;

    if (speechFinal) {
      // Caller finished speaking — stop any playing AI audio (barge-in) and respond
      console.log(`[deepgram] Final: "${transcript}"`);
      stopCurrentAudio(callSid);
      onClientUtterance(callSid, transcript);
    } else if (isFinal) {
      console.log(`[deepgram] Interim final: "${transcript}"`);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[deepgram] Error for ${callSid}:`, err);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[deepgram] Session closed for ${callSid}`);
  });

  // ── Step 1 — Receive audio packets from Twilio and forward to Deepgram ────
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        // Twilio tells us the stream SID — we need this to inject audio back
        const streamSid = msg.start.streamSid;
        updateCall(callSid, { streamSid });
        console.log(`[media] Stream started — streamSid: ${streamSid}`);
      }

      if (msg.event === 'media') {
        // Raw mulaw 8kHz audio — forward directly to Deepgram
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        if (dgConnection.getReadyState() === 1) {
          dgConnection.send(audioBuffer);
        }
      }

      if (msg.event === 'stop') {
        console.log(`[media] Stream stopped for ${callSid}`);
        dgConnection.finish();
      }

    } catch (err) {
      console.error('[media] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[media] WebSocket closed for ${callSid}`);
    dgConnection.finish();
  });

  ws.on('error', (err) => {
    console.error(`[media] WebSocket error for ${callSid}:`, err.message);
  });
}

module.exports = { handleMediaStream };
