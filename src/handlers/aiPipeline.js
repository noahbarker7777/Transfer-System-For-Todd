'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const store = require('../store');
const { client: twilioClient } = require('../twilioClient');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
      // Wait for the speech to finish, then transfer
      setTimeout(() => initiateTransfer(callSid), 1500);
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

  if (!ws || ws.readyState !== 1 || !streamSid) return;

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

  console.log('[elevenlabs] Speaking: "' + text + '"');

  const postData = JSON.stringify({
    text: text,
    model_id: modelId,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  const options = {
    hostname: 'api.elevenlabs.io',
    port: 443,
    path: '/v1/text-to-speech/' + voiceId + '/stream?output_format=ulaw_8000',
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
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
        if (activeAudioStreams.get(callSid) !== apiRes) return;
        if (ws.readyState !== 1) return;

        chunkCount++;
        totalBytes += chunk.length;

        ws.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: chunk.toString('base64') }
        }));
      });

      apiRes.on('end', () => {
        console.log('[elevenlabs] Finished — ' + chunkCount + ' chunks, ' + totalBytes + ' bytes');
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

function stopCurrentAudio(callSid) {
  activeAudioStreams.delete(callSid);
  const call = store.getCall(callSid);
  const ws = store.getMediaConnection(callSid);
  if (ws && ws.readyState === 1 && call && call.streamSid) {
    ws.send(JSON.stringify({
      event: 'clear',
      streamSid: call.streamSid
    }));
  }
}

// NEW — Transfer redirects the client's call to a Dial TwiML that calls Todd
async function initiateTransfer(callSid) {
  const call = store.getCall(callSid);
  if (!call) return;

  console.log('[transfer] Redirecting client call ' + callSid + ' to agent: ' + process.env.AGENT_PHONE);
  store.updateCall(callSid, { state: 'TRANSFERRING' });

  try {
    // Update the client's call to use new TwiML that dials the agent
    await twilioClient.calls(callSid).update({
      url: process.env.SERVER_URL + '/call/dial-agent-twiml',
      method: 'POST',
    });
    console.log('[transfer] Call successfully redirected to agent dial TwiML');
  } catch (err) {
    console.error('[transfer] Error:', err.message);
  }
}

function signalAI(callSid, params) {
  const action = params.action;
  console.log('[ai] Signal: ' + action);
  // These signals were from the old conference-based flow — no-ops now
}

module.exports = { onClientUtterance, speakToClient, stopCurrentAudio, signalAI, initiateTransfer };
