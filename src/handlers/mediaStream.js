'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getCall, updateCall, setMediaConnection } = require('../store');
const { onClientUtterance, stopCurrentAudio } = require('./aiPipeline');

function handleMediaStream(ws, req) {
  console.log('[media] WebSocket connected');

  let callSid = null;
  let dgConnection = null;
  let inboundMediaCount = 0;
  let lastLogTime = Date.now();

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'connected') {
        console.log('[MediaStream] Twilio protocol connected');
      }

      if (msg.event === 'start') {
        callSid = msg.start.customParameters && msg.start.customParameters.callSid;

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
        const tracks = msg.start.tracks;
        updateCall(callSid, { streamSid });
        setMediaConnection(callSid, ws);
        console.log('[MediaStream] Started — callSid=' + callSid + ', streamSid=' + streamSid + ', tracks=' + JSON.stringify(tracks));

        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
        dgConnection = deepgram.listen.live({
          model: process.env.DEEPGRAM_MODEL || 'nova-2',
          language: process.env.DEEPGRAM_LANGUAGE || 'en-US',
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1,
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
          console.log('[Deepgram] transcript: "' + transcript + '" (final=' + data.is_final + ', speech_final=' + data.speech_final + ')');
          if (data.speech_final) {
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
        inboundMediaCount++;

        // Log every 5 seconds to confirm audio is flowing in
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log('[media] Received ' + inboundMediaCount + ' audio packets from caller. Track: ' + msg.media.track);
          lastLogTime = now;
        }

        if (dgConnection && dgConnection.getReadyState() === 1) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          dgConnection.send(audioBuffer);
        }
      }

      if (msg.event === 'stop') {
        console.log('[MediaStream] Stopped — callSid=' + callSid + ', total inbound packets: ' + inboundMediaCount);
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
