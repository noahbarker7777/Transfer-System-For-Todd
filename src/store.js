/**
 * store.js
 * In-memory state for every active call.
 *
 * Call states:
 *   GREETING     → AI just answered, intro playing
 *   QUALIFYING   → AI is having the qualifying conversation
 *   TRANSFERRING → Transfer attempt in progress (agent leg dialing)
 *   CONNECTED    → Agent picked up, AI doing warm intro
 *   FALLBACK     → Transfer failed, AI returned to client
 *   DONE         → Call ended
 */

// One entry per active call, keyed by Twilio CallSid
const calls = new Map();

// Conversation history per call, keyed by Twilio CallSid
// Each entry is an array of { role: 'user' | 'assistant', content: string }
const conversations = new Map();

// ── Call state helpers ────────────────────────────────────────────────────

function createCall(callSid) {
  calls.set(callSid, {
    state: 'GREETING',
    callSid,
    conferenceName: `conf-${callSid}`,
    streamSid: null,       // Twilio Media Stream SID
    agentCallSid: null,    // SID of the outbound agent leg
    transferTimer: null,   // setTimeout handle for 20s timeout
    isAiMuted: false,      // whether we're suppressing AI audio output
    callerName: null,      // populated if we collect it
    callerPhone: null,     // populated from call metadata
  });
  conversations.set(callSid, []);
}

function getCall(callSid) {
  return calls.get(callSid) || null;
}

function updateCall(callSid, updates) {
  const call = calls.get(callSid);
  if (!call) return;
  Object.assign(call, updates);
}

function deleteCall(callSid) {
  const call = calls.get(callSid);
  if (call?.transferTimer) clearTimeout(call.transferTimer);
  calls.delete(callSid);
  conversations.delete(callSid);
}

function getConversation(callSid) {
  return conversations.get(callSid) || [];
}

function appendMessage(callSid, role, content) {
  const history = conversations.get(callSid) || [];
  history.push({ role, content });
  conversations.set(callSid, history);
}

function activeCalls() {
  return calls.size;
}

module.exports = {
  createCall,
  getCall,
  updateCall,
  deleteCall,
  getConversation,
  appendMessage,
  activeCalls,
};
