'use strict';

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getCall, updateCall, setMediaConnection } = require('../store');
const { onClientUtterance, stopCurrentAudio }     = require('./aiPipeline');

function handleMediaStream(ws, req) {
  console.log('[media] WebSocket connected');

  let callSid          = null;
  let dgConnection     = null;
  let inboundMediaCount = 0;
  let lastLogTime      = Date.now();

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'connected') {
        console.log('[MediaStream] Twilio protocol connected');
      }

      if (msg.event === 'start') {
        // callSid is passed as a custom stream parameter
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
        // Update the media connection — this also handles reconnection after
        // a voicemail fallback where a new WebSocket opens for the same callSid
        updateCall(callSid, { streamSid });
        setMediaConnection(callSid, ws);
        console.log('[MediaStream] Started — callSid=' + callSid + ' streamSid=' + streamSid);

        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
        dgConnection = deepgram.listen.live({
          model:           process.env.DEEPGRAM_MODEL    || 'nova-2',
          language:        process.env.DEEPGRAM_LANGUAGE || 'en-US',
          encoding:        'mulaw',
          sample_rate:     8000,
          channels:        1,
          smart_format:    true,
          interim_results: true,
          endpointing:     parseInt(process.env.DEEPGRAM_ENDPOINTING    || '300'),
          utterance_end_ms: parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS || '1000'),
        });

        dgConnection.on(LiveTranscriptionEvents.Open, () => {
          console.log('[Deepgram] Session open for ' + callSid);
          const call = getCall(callSid);
          if (!call) return;

          if (call.state === 'GREETING') {
            // First connection — fire the opening greeting
            updateCall(callSid, { state: 'QUALIFYING' });
            onClientUtterance(callSid, '__greeting__');
          } else if (call.pendingFallback) {
            // Reconnection after a failed transfer — AI delivers fallback script
            updateCall(callSid, { pendingFallback: false, state: 'FALLBACK' });
            onClientUtterance(callSid, '__fallback__');
          }
        });

        // Accumulate final-but-not-yet-speech_final chunks so we don't lose
        // multi-segment utterances like "Noah Barker [pause] my number is 555..."
        let pendingTranscript = '';

        dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
          const alt = data.channel?.alternatives?.[0];
          const transcript = alt?.transcript;
          if (!transcript || !transcript.trim()) return;

          console.log(
            '[Deepgram] "' + transcript + '"' +
            ' (final=' + data.is_final + ' speech_final=' + data.speech_final + ')'
          );

          if (data.is_final) {
            pendingTranscript = pendingTranscript
              ? pendingTranscript + ' ' + transcript
              : transcript;
          }

          if (data.speech_final) {
            const full = pendingTranscript || transcript;
            pendingTranscript = '';
            stopCurrentAudio(callSid);
            onClientUtterance(callSid, full);
          }
        });

        // UtteranceEnd fires after utterance_end_ms of silence — catches cases
        // where speech_final never fires (e.g. caller pauses after giving info)
        dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
          if (pendingTranscript) {
            const full = pendingTranscript;
            pendingTranscript = '';
            console.log('[Deepgram] UtteranceEnd → processing: "' + full + '"');
            stopCurrentAudio(callSid);
            onClientUtterance(callSid, full);
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

        // Periodic log to confirm audio is flowing
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log(
            '[media] ' + inboundMediaCount + ' packets from caller' +
            ' (track=' + msg.media.track + ')'
          );
          lastLogTime = now;
        }

        if (dgConnection && dgConnection.getReadyState() === 1) {
          dgConnection.send(Buffer.from(msg.media.payload, 'base64'));
        }
      }

      if (msg.event === 'stop') {
        console.log('[MediaStream] Stopped — callSid=' + callSid + ' total=' + inboundMediaCount);
        if (dgConnection) dgConnection.finish();
      }

    } catch (err) {
      console.error('[media] Parse error:', err.message);
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
