'use strict';

const Anthropic                   = require('@anthropic-ai/sdk');
const { ElevenLabsClient }        = require('elevenlabs');
const fs                          = require('fs');
const path                        = require('path');
const { getCall, updateCall, getConversation, addMessage, getMediaConnection } = require('../store');
const { dialAgent, muteParticipant }                                           = require('../twilioClient');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const eleven    = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Load the system prompt once at startup
const AGENT_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../../system-prompt.txt'),
  'utf8'
);

// Track active ElevenLabs audio streams per call so we can cancel on barge-in
const activeAudioStreams = new Map(); // callSid → current audioStream reference

// ── Step 3 — Claude Haiku generates a response ────────────────────────────────
async function onClientUtterance(callSid, transcript) {
  const call = getCall(callSid);
  if (!call) return;

  // Do not respond during transfer, connection, or after the call is done
  if (['TRANSFERRING', 'CONNECTED', 'DONE'].includes(call.state)) return;

  console.log(`[haiku] Processing: "${transcript}"`);

  // Convert special greeting token into a real instruction for Haiku
  const userMessage = transcript === '__greeting__'
    ? 'The call just connected. Greet the caller warmly and introduce yourself briefly.'
    : transcript;

  addMessage(callSid, 'user', userMessage);

  const history = getConversation(callSid).filter(m => m.content !== '__init__');

  try {
    const response = await anthropic.messages.create({
      model:      process.env.ANTHROPIC_MODEL    || 'claude-haiku-4-5',
      max_tokens: parseInt(process.env.MAX_RESPONSE_TOKENS || '150'),
      system:     AGENT_SYSTEM_PROMPT,
      messages:   history,
    });

    let aiText = response.content[0].text;
    console.log(`[haiku] Response: "${aiText}"`);

    // Detect the [TRANSFER] signal before ElevenLabs speaks it
    const shouldTransfer = aiText.includes('[TRANSFER]');
    aiText = aiText.replace('[TRANSFER]', '').trim();

    addMessage(callSid, 'assistant', aiText);

    // Step 4 + 5 — Speak the response to the caller
    await speakToClient(callSid, aiText);

    // Initiate transfer after the speaking starts
    if (shouldTransfer && call.state === 'QUALIFYING') {
      setTimeout(() => initiateTransfer(callSid), 500);
    }

  } catch (err) {
    console.error(`[haiku] Error for ${callSid}:`, err.message);
  }
}

// ── Step 4 — ElevenLabs converts text to speech ───────────────────────────────
async function speakToClient(callSid, text) {
  if (!text || !text.trim()) return;

  const call = getCall(callSid);
  if (!call) return;

  const ws       = getMediaConnection(callSid);
  const streamSid = call.streamSid;

  if (!ws || ws.readyState !== 1 || !streamSid) {
    console.warn(`[elevenlabs] Cannot speak — no active stream for ${callSid}`);
    return;
  }

  console.log(`[elevenlabs] Speaking: "${text}"`);

  try {
    // eleven_turbo_v2 = lowest latency model
    // ulaw_8000 = matches Twilio's native audio format — no conversion needed
    const audioStream = await eleven.generate({
      voice:         process.env.ELEVENLABS_VOICE_ID,
      text,
      model_id:      process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2',
      output_format: 'ulaw_8000',
    });

    // Register this stream as the currently active one for this call
    activeAudioStreams.set(callSid, audioStream);

    // ── Step 5 — Inject audio back into the Twilio conference ────────────────
    audioStream.on('data', (chunk) => {
      // If a newer stream has replaced this one (barge-in), stop sending
      if (activeAudioStreams.get(callSid) !== audioStream) return;

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          event:     'media',
          streamSid,
          media: {
            payload: chunk.toString('base64'), // Twilio expects base64-encoded mulaw
          },
        }));
      }
    });

    audioStream.on('end', () => {
      if (activeAudioStreams.get(callSid) === audioStream) {
        activeAudioStreams.delete(callSid);
      }
    });

    audioStream.on('error', (err) => {
      console.error(`[elevenlabs] Stream error for ${callSid}:`, err.message);
    });

  } catch (err) {
    console.error(`[elevenlabs] Generate error for ${callSid}:`, err.message);
  }
}

// ── Barge-in — stop current audio when caller starts speaking ─────────────────
// Called by mediaStream.js when Deepgram fires speech_final while audio is playing
function stopCurrentAudio(callSid) {
  // Replacing the map reference invalidates the active stream's data handler
  activeAudioStreams.delete(callSid);
}

// ── Transfer — mute AI, dial agent, start 20s safety timeout ─────────────────
async function initiateTransfer(callSid) {
  const call = getCall(callSid);
  if (!call || call.state !== 'QUALIFYING') return;

  console.log(`[transfer] Initiating for ${callSid}`);
  updateCall(callSid, { state: 'TRANSFERRING' });

  // Mute AI leg — caller hears hold music from the conference waitUrl
  await muteParticipant(call.conferenceName, call.aiLegSid, true);

  // Dial the agent with AMD
  const agentCall = await dialAgent(callSid, call.conferenceName);
  updateCall(callSid, { agentLegSid: agentCall.sid });

  // 20-second safety net in case the AMD webhook never fires
  const timer = setTimeout(async () => {
    const current = getCall(callSid);
    if (current?.state !== 'TRANSFERRING') return; // AMD already handled it

    console.log(`[transfer] 20s timeout — running fallback for ${callSid}`);
    updateCall(callSid, { state: 'FALLBACK' });
    await muteParticipant(call.conferenceName, call.aiLegSid, false);
    signalAI(callSid, { action: 'FALLBACK' });

    const { leaveVoicemail } = require('../twilioClient');
    leaveVoicemail(callSid, call.callerNumber);
  }, 20000);

  updateCall(callSid, { timer });
}

// ── Signal the AI to take a specific action ───────────────────────────────────
// Called by amd.js and the 20s timeout
function signalAI(callSid, { action }) {
  console.log(`[ai] Signal: ${action} for ${callSid}`);

  if (action === 'INTRODUCE') {
    // Warm introduction — spoken to both the agent and the caller
    const agentName = process.env.AGENT_NAME || 'Todd';
    const script    = `${agentName}, I have a client on the line who is interested in tax services. I will let you two connect now.`;
    speakToClient(callSid, script);
  }

  if (action === 'FALLBACK') {
    // Tell Haiku to run its fallback script naturally
    onClientUtterance(
      callSid,
      `The transfer to ${process.env.AGENT_NAME || 'the specialist'} was unsuccessful. Please run your fallback script — offer to schedule a callback or send a follow-up message.`
    );
  }
}

module.exports = { onClientUtterance, speakToClient, stopCurrentAudio, signalAI, initiateTransfer };
