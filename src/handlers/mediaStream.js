'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getCall, updateCall, setMediaConnection } = require('../store');
const { onClientUtterance, stopCurrentAudio } = require('./aiPipeline');

function handleMediaStream(ws, req) {
  console.log('[media] WebSocket connected');

  let callSid = null;
  let dgConnection = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'connected') {
        console.log('[MediaStream] WebSocket connected');
      }

      if (msg.event === 'start') {
        // Get callSid from custom parameters (sent via TwiML <Parameter>)
        callSid = msg.start.customParameters && msg.start.customParameters.callSid;

        // Fallback: try to get from URL query
        if (!callSid) {
          const url = new URL(req.url, 'http://localhost');
          callSid = url.searchParams.get('callSid');
        }

        if (!callSid) {
          console.error('[media] No callSid found — closing');
          ws.close();
          return;
        }

        const streamSid = msg.start.streamSid;
        updateCall(callSid, { streamSid });
        setMediaConnection(callSid, ws);
        console.log('[MediaStream] Started — callSid=' + callSid + ' streamSid=' + streamSid);

        // Start Deepgram
        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
        dgConnection = deepgram.listen.live({
          model: process.env.DEEPGRAM_MODEL || 'nova-2',
          language: process.env.DEEPGRAM_LANGUAGE || 'en-US',
          smart_format: true,
          interim_results: true,
          endpointing: parseInt(process.env.DEEPGRAM_ENDPOINTING || '300'),
          utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS || '1000'),
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          console.log('[Deepgram] Session open for call ' + callSid);
          const call = getCall(callSid);
          if (call && call.state === 'GREETING') {
            updateCall(callSid, { state: 'QUALIFYING' });
            onClientUtterance(callSid, '__greeting__');
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
          const transcript = data.channel && data.channel.alternatives && data.channel.alternatives[0] && data.channel.alternatives[0].transcript;
          if (!transcript || !transcript.trim()) return;
          if (data.speech_final) {
            console.log('[Deepgram] Final transcript: "' + transcript + '"');
            stopCurrentAudio(callSid);
            onClientUtterance(callSid, transcript);
          }
        });

        dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
          console.error('[Deepgram] Error:', err);
        });

        dgConnection.on(LiveTranscriptionEvents.Close, () => {
          console.log('[Deepgram] Session closed for ' + callSid);
        });
      }

      if (msg.event === 'media') {
        if (dgConnection && dgConnection.getReadyState() === 1) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          dgConnection.send(audioBuffer);
        }
      }

      if (msg.event === 'stop') {
        console.log('[MediaStream] Stopped — callSid=' + callSid);
        if (dgConnection) dgConnection.finish();
      }

    } catch (err) {
      console.error('[media] Error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[media] WebSocket closed — callSid=' + callSid);
    if (dgConnection) dgConnection.finish();
  });

  ws.on('error', (err) => {
    console.error('[media] WebSocket error:', err.message);
  });
}

module.exports = { handleMediaStream };
