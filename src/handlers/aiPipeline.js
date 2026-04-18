'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const fs = require('fs');
const path = require('path');
const store = require('../store');
const { dialAgent, muteParticipant } = require('../twilioClient');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const AGENT_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../../system-prompt.txt'),
  'utf8'
);

const activeAudioStreams = new Map();

async function onClientUtterance(callSid, transcript) {
  const call = store.getCall(callSid);
  if (!call) return;
  if (['TRANSFERRING', 'CONNECTED', 'DONE'].includes(call.state)) return;

  console.log('[haiku] Processing: "' + transcript + '"');

  const userMessage = transcript === '__greeting__'
    ? 'The call just connected. Greet the caller warmly and introduce yourself briefly.'
    : transcript;

  store.addMessage(callSid, 'user', userMessage);
  const history = store.getConversation(callSid).filter(m => m.content !== '__init__');

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: parseInt(process.env.MAX_RESPONSE_TOKENS || '150'),
      system: AGENT_SYSTEM_PROMPT,
      messages: history,
    });

    let aiText = response.content[0].text;
    console.log('[haiku] Response: "' + aiText + '"');

    const shouldTransfer = aiText.includes('[TRANSFER]');
    aiText = aiText.replace('[TRANSFER]', '').trim();

    store.addMessage(callSid, 'assistant', aiText);

    await speakToClient(callSid, aiText);

    if (shouldTransfer && call.state === 'QUALIFYING') {
      setTimeout(() => initiateTransfer(callSid), 500);
    }

  } catch (err) {
    console.error('[haiku] Error:', err.message);
  }
}

async function speakToClient(callSid, text) {
  if (!text || !text.trim()) return;

  const call = store.getCall(callSid);
  if (!call) return;

  const ws = store.getMediaConnection(callSid);
  const streamSid = call.streamSid;

  if (!ws || ws.readyState !== 1 || !streamSid) {
    console.warn('[elevenlabs] No active stream for ' + callSid + ' — ws ready: ' + (ws && ws.readyState) + ', streamSid: ' + streamSid);
    return;
  }

  console.log('[elevenlabs] Speaking: "' + text + '"');

  try {
    const audioStream = await eleven.generate({
      voice: process.env.ELEVENLABS_VOICE_ID,
      text: text,
      model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2',
      output_format: 'ulaw_8000',
    });

    activeAudioStreams.set(callSid, audioStream);

    let chunkCount = 0;
    let totalBytes = 0;

    audioStream.on('data', (chunk) => {
      if (activeAudioStreams.get(callSid) !== audioStream) return;
      if (ws.readyState !== 1) return;

      chunkCount++;
      totalBytes += chunk.length;

      const payload = chunk.toString('base64');

      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: payload }
      }));
    });

    audioStream.on('end', () => {
      console.log('[elevenlabs] Finished speaking — ' + chunkCount + ' chunks, ' + totalBytes + ' bytes sent');

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'end-of-speech' }
        }));
      }

      if (activeAudioStreams.get(callSid) === audioStream) {
        activeAudioStreams.delete(callSid);
      }
    });

    audioStream.on('error', (err) => {
      console.error('[elevenlabs] Stream error:', err.message);
    });

  } catch (err) {
    console.error('[elevenlabs] Generate error:', err.message);
  }
}

function stopCurrentAudio(callSid) {
  const call = store.getCall(callSid);
  const ws = store.getMediaConnection(callSid);

  activeAudioStreams.delete(callSid);

  if (ws && ws.readyState === 1 && call && call.streamSid) {
    ws.send(JSON.stringify({
      event: 'clear',
      streamSid: call.streamSid
    }));
  }
}

async function initiateTransfer(callSid) {
  const call = store.getCall(callSid);
  if (!call || call.state !== 'QUALIFYING') return;

  console.log('[transfer] Initiating for ' + callSid);
  store.updateCall(callSid, { state: 'TRANSFERRING' });

  await muteParticipant(call.conferenceName, call.aiLegSid, true);
  const agentCall = await dialAgent(callSid, call.conferenceName);
  store.updateCall(callSid, { agentLegSid: agentCall.sid });

  const timer = setTimeout(async () => {
    const current = store.getCall(callSid);
    if (current && current.state === 'TRANSFERRING') {
      store.updateCall(callSid, { state: 'FALLBACK' });
      await muteParticipant(call.conferenceName, call.aiLegSid, false);
      signalAI(callSid, { action: 'FALLBACK' });
      const { leaveVoicemail } = require('../twilioClient');
      leaveVoicemail(callSid, call.callerNumber);
    }
  }, 20000);

  store.updateCall(callSid, { timer: timer });
}

function signalAI(callSid, { action }) {
  console.log('[ai] Signal: ' + action);

  if (action === 'INTRODUCE') {
    const agentName = process.env.AGENT_NAME || 'Todd';
    const script = agentName + ', I have a client on the line interested in tax services. I will let you two connect now.';
    speakToClient(callSid, script);
  }

  if (action === 'FALLBACK') {
    onClientUtterance(callSid, 'The transfer was unsuccessful. Run your fallback script — offer to schedule a callback.');
  }
}

module.exports = { onClientUtterance, speakToClient, stopCurrentAudio, signalAI, initiateTransfer };
