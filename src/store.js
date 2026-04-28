'use strict';

// ── Call state store (TRANSFER_V4) ────────────────────────────────────────────
// One entry per active client call (initialized in routes/inbound.js).
//
// Shape:
//   state, callerNumber, callerPhone, callerName, taxType,
//   transferStarted, conferenceName, agentCallSid,
//   agentJoinedConference, agentAnsweredBy,
//   fallbackTriggered, fallbackReason, pendingFallback,
//   streamSid, recordingUrl
//
// Valid states:
//   GREETING      — AI answered, sending opening greeting
//   QUALIFYING    — AI is collecting name/phone/taxType
//   TRANSFERRING  — Locked while moving client to conference and dialing Todd
//   CONNECTED     — Conference participant-join confirmed Todd bridged
//   FALLBACK      — Transfer failed; AI redelivering on a fresh MediaStream
//   DONE          — Bridge ended cleanly

const calls           = new Map(); // callSid → call object
const conversations   = new Map(); // callSid → message history array for Haiku
const mediaConnections = new Map(); // callSid → open WebSocket to Twilio

// ── Call ──────────────────────────────────────────────────────────────────────
function getCall(callSid) {
  return calls.get(callSid);
}

function setCall(callSid, data) {
  calls.set(callSid, data);
}

function updateCall(callSid, updates) {
  const existing = calls.get(callSid) || {};
  calls.set(callSid, { ...existing, ...updates });
}

function deleteCall(callSid) {
  calls.delete(callSid);
  conversations.delete(callSid);
  mediaConnections.delete(callSid);
}

// ── Conversation history ──────────────────────────────────────────────────────
function getConversation(callSid) {
  return conversations.get(callSid) || [];
}

function addMessage(callSid, role, content) {
  const history = conversations.get(callSid) || [];
  history.push({ role, content });
  conversations.set(callSid, history);
}

// ── Media WebSocket connections ───────────────────────────────────────────────
function getMediaConnection(callSid) {
  return mediaConnections.get(callSid);
}

function setMediaConnection(callSid, ws) {
  mediaConnections.set(callSid, ws);
}

// Only delete if the stored ws is the one that closed — a fallback reconnect
// may have already registered a fresh socket for the same callSid.
function deleteMediaConnection(callSid, ws) {
  if (!ws || mediaConnections.get(callSid) === ws) {
    mediaConnections.delete(callSid);
  }
}

module.exports = {
  getCall,
  setCall,
  updateCall,
  deleteCall,
  getConversation,
  addMessage,
  getMediaConnection,
  setMediaConnection,
  deleteMediaConnection,
};
