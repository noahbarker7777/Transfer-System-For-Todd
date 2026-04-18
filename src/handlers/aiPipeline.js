/**
 * handlers/aiPipeline.js
 * The three-piece AI voice pipeline:
 *   Twilio audio stream → Deepgram STT → Claude Haiku → ElevenLabs TTS → back to Twilio
 *
 * Flow per client utterance:
 *   1. Twilio sends raw mulaw 8kHz audio chunks via WebSocket
 *   2. mediaStream.js forwards those chunks here
 *   3. Deepgram transcribes in real time (streaming)
 *   4. On final transcript → Claude Haiku generates a text response
 *   5. Response text → ElevenLabs → audio chunks
 *   6. Audio chunks injected back into the Twilio media stream
 *   7. Client hears the AI response
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Anthropic  = require('@anthropic-ai/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const config     = require('../config');
const store      = require('../store');

// SDK clients (initialized once, reused for all calls)
const deepgramClient  = createClient(config.DEEPGRAM_API_KEY);
const anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const elevenClient    = new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY });

// Per-call pipeline state
// callSid → { deepgramConn, isPlaying, isPaused, mediaWs, currentStream }
const pipelines = new Map();

// ── Initialize pipeline for a new call ───────────────────────────────────────
function initPipeline(callSid, mediaWs) {
  const deepgramConn = deepgramClient.listen.live({
    model:              config.DEEPGRAM_MODEL,
    language:           config.DEEPGRAM_LANGUAGE,
    smart_format:       true,
    interim_results:    true,
    endpointing:        config.DEEPGRAM_ENDPOINTING,
    utterance_end_ms:   1000,
    encoding:           'mulaw',
    sample_rate:        8000,
  });

  pipelines.set(callSid, {
    deepgramConn,
    isPlaying:   false,    // true while ElevenLabs audio is streaming out
    isPaused:    false,    // true during transfer attempt (client hears hold music)
    mediaWs,               // the open WebSocket to Twilio
    currentStream: null,   // active ElevenLabs stream (so we can cancel on barge-in)
  });

  // ── Deepgram transcript events ────────────────────────────────────────────
  deepgramConn.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[Deepgram] Session open for call ${callSid}`);
    // Transition to QUALIFYING once Deepgram is ready
    store.updateCall(callSid, { state: 'QUALIFYING' });
    // AI speaks the greeting first
    _speakGreeting(callSid);
  });

  deepgramConn.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const pipeline = pipelines.get(callSid);
    if (!pipeline || pipeline.isPaused) return;

    const alt        = data.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim();
    const isFinal    = data.is_final;

    if (!transcript) return;

    // Barge-in: if client starts speaking while AI is talking, stop the AI
    if (pipeline.isPlaying) {
      console.log(`[Pipeline] Barge-in detected — stopping AI audio for ${callSid}`);
      _stopCurrentAudio(callSid);
    }

    if (isFinal) {
      console.log(`[Deepgram] Final transcript: "${transcript}"`);
      await _handleUtterance(callSid, transcript);
    }
  });

  deepgramConn.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Deepgram] Error for ${callSid}:`, err);
  });

  deepgramConn.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[Deepgram] Session closed for ${callSid}`);
  });

  return deepgramConn;
}

// ── Feed raw audio from Twilio into Deepgram ──────────────────────────────────
function feedAudio(callSid, audioPayload) {
  const pipeline = pipelines.get(callSid);
  if (!pipeline || pipeline.isPaused) return;

  try {
    const audioBuffer = Buffer.from(audioPayload, 'base64');
    if (pipeline.deepgramConn?.getReadyState() === 1) {
      pipeline.deepgramConn.send(audioBuffer);
    }
  } catch (err) {
    console.error(`[Pipeline] feedAudio error for ${callSid}:`, err.message);
  }
}

// ── Handle a completed client utterance ───────────────────────────────────────
async function _handleUtterance(callSid, transcript) {
  const call = store.getCall(callSid);
  if (!call || call.state === 'DONE') return;

  // Append to conversation history
  store.appendMessage(callSid, 'user', transcript);
  const history = store.getConversation(callSid);

  try {
    const response = await anthropicClient.messages.create({
      model:      config.ANTHROPIC_MODEL,
      max_tokens: config.MAX_RESPONSE_TOKENS,
      system:     _buildSystemPrompt(call),
      messages:   history,
    });

    let aiText = response.content[0]?.text || '';
    console.log(`[Haiku] Response: "${aiText}"`);

    // Store AI response in history (strip signal tokens first)
    store.appendMessage(callSid, 'assistant', aiText.replace('[TRANSFER]', '').trim());

    // Check for transfer signal
    if (aiText.includes('[TRANSFER]')) {
      aiText = aiText.replace('[TRANSFER]', '').trim();
      // Speak the bridge line first, then trigger transfer
      if (aiText) await speakToClient(callSid, aiText);
      const { onTransferSignal } = require('./transferHandler');
      await onTransferSignal(callSid);
      return;
    }

    if (aiText) {
      await speakToClient(callSid, aiText);
    }
  } catch (err) {
    console.error(`[Haiku] Error for ${callSid}:`, err.message);
  }
}

// ── Build the system prompt with live call context ────────────────────────────
function _buildSystemPrompt(call) {
  const fs = require('fs');
  const path = require('path');
  try {
    let prompt = fs.readFileSync(
      path.join(__dirname, '../../system-prompt.txt'), 'utf8'
    );
    prompt = prompt
      .replace(/\{\{company_name\}\}/g, config.COMPANY_NAME)
      .replace(/\{\{assistant_name\}\}/g, config.ASSISTANT_NAME)
      .replace(/\{\{agent_name\}\}/g, config.AGENT_NAME)
      .replace(/\{\{client_name\}\}/g, call.callerName   || 'the caller')
      .replace(/\{\{client_phone\}\}/g, call.callerPhone || 'unknown');
    return prompt;
  } catch {
    return `You are ${config.ASSISTANT_NAME}, a professional intake assistant for ${config.COMPANY_NAME}. Qualify callers for tax services and transfer them to ${config.AGENT_NAME}.`;
  }
}

// ── Speak the opening greeting when the AI first connects ─────────────────────
async function _speakGreeting(callSid) {
  const call = store.getCall(callSid);
  const greeting = call?.callerName
    ? `Hi ${call.callerName}, thanks for calling ${config.COMPANY_NAME}! This is ${config.ASSISTANT_NAME}. How can I help you today?`
    : `Thank you for calling ${config.COMPANY_NAME}. This is ${config.ASSISTANT_NAME}. How can I help you today?`;
  await speakToClient(callSid, greeting);
}

// ── Convert text to speech and stream it into the Twilio media stream ─────────
async function speakToClient(callSid, text) {
  const pipeline = pipelines.get(callSid);
  if (!pipeline || !text.trim()) return;

  pipeline.isPlaying = true;
  console.log(`[ElevenLabs] Speaking to ${callSid}: "${text.substring(0, 60)}..."`);

  try {
    const audioStream = await elevenClient.generate({
      voice:     config.ELEVENLABS_VOICE_ID,
      text:      text,
      model_id:  config.ELEVENLABS_MODEL,
      output_format: 'ulaw_8000',  // matches Twilio's mulaw 8kHz exactly — no conversion needed
    });

    pipeline.currentStream = audioStream;

    const call = store.getCall(callSid);
    const streamSid = call?.streamSid;

    for await (const chunk of audioStream) {
      // Stop if paused mid-speech (e.g. transfer triggered during AI speech)
      if (pipeline.isPaused || !pipelines.has(callSid)) break;

      if (pipeline.mediaWs?.readyState === 1 && streamSid) {
        pipeline.mediaWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') },
        }));
      }
    }
  } catch (err) {
    console.error(`[ElevenLabs] Error for ${callSid}:`, err.message);
  } finally {
    const p = pipelines.get(callSid);
    if (p) {
      p.isPlaying     = false;
      p.currentStream = null;
    }
  }
}

// ── Pause AI audio output (during transfer — client hears hold music) ─────────
function pauseAudio(callSid) {
  const pipeline = pipelines.get(callSid);
  if (pipeline) {
    pipeline.isPaused = true;
    _stopCurrentAudio(callSid);
    console.log(`[Pipeline] Audio paused for ${callSid}`);
  }
}

// ── Resume AI audio output (after transfer fails) ─────────────────────────────
function resumeAudio(callSid) {
  const pipeline = pipelines.get(callSid);
  if (pipeline) {
    pipeline.isPaused = false;
    console.log(`[Pipeline] Audio resumed for ${callSid}`);
  }
}

// ── Stop any currently playing audio (barge-in or mute) ──────────────────────
function _stopCurrentAudio(callSid) {
  const pipeline = pipelines.get(callSid);
  if (!pipeline) return;
  pipeline.isPlaying = false;
  // Destroying the async iterator will abort the ElevenLabs stream
  if (pipeline.currentStream?.destroy) pipeline.currentStream.destroy();
  pipeline.currentStream = null;
}

// ── Disconnect and clean up this call's pipeline ──────────────────────────────
function disconnectStream(callSid) {
  const pipeline = pipelines.get(callSid);
  if (!pipeline) return;
  _stopCurrentAudio(callSid);
  if (pipeline.deepgramConn) {
    try { pipeline.deepgramConn.finish(); } catch {}
  }
  pipelines.delete(callSid);
  console.log(`[Pipeline] Disconnected for ${callSid}`);
}

module.exports = {
  initPipeline,
  feedAudio,
  speakToClient,
  pauseAudio,
  resumeAudio,
  disconnectStream,
};
