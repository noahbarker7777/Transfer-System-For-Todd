/**
 * handlers/mediaStream.js
 * Manages the WebSocket connection Twilio opens for Media Streams.
 *
 * Twilio sends these event types over the WebSocket:
 *   "connected"  → stream established
 *   "start"      → stream started, contains callSid and streamSid
 *   "media"      → audio chunk (base64 mulaw 8kHz)
 *   "stop"       → stream ended
 *   "mark"       → marker event (used for playback sync)
 */

const store      = require('../store');
const aiPipeline = require('./aiPipeline');

function handleMediaStream(ws) {
  let callSid   = null;
  let streamSid = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      // ── Stream established ────────────────────────────────────────────────
      case 'connected':
        console.log('[MediaStream] WebSocket connected');
        break;

      // ── Stream started — we now know callSid and streamSid ───────────────
      case 'start': {
        callSid   = msg.start?.callSid   || msg.start?.customParameters?.callSid;
        streamSid = msg.start?.streamSid;

        if (!callSid) {
          console.warn('[MediaStream] start event missing callSid');
          break;
        }

        console.log(`[MediaStream] Started — callSid=${callSid} streamSid=${streamSid}`);

        // Store streamSid so aiPipeline can inject audio back
        store.updateCall(callSid, { streamSid });

        // Initialize the AI pipeline for this call
        aiPipeline.initPipeline(callSid, ws);
        break;
      }

      // ── Audio chunk received from client ──────────────────────────────────
      case 'media': {
        if (!callSid) break;
        const payload = msg.media?.payload;
        if (payload) {
          aiPipeline.feedAudio(callSid, payload);
        }
        break;
      }

      // ── Stream ended (call hung up) ───────────────────────────────────────
      case 'stop':
        console.log(`[MediaStream] Stopped — callSid=${callSid}`);
        if (callSid) {
          aiPipeline.disconnectStream(callSid);
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[MediaStream] WebSocket closed — callSid=${callSid}`);
    if (callSid) {
      aiPipeline.disconnectStream(callSid);
    }
  });

  ws.on('error', (err) => {
    console.error(`[MediaStream] WebSocket error:`, err.message);
  });
}

module.exports = { handleMediaStream };
