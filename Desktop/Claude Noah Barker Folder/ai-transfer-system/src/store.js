'use strict';

// ── Call state store ──────────────────────────────────────────────────────────
// One entry per active call.
// Shape: { state, conferenceName, callerNumber, aiLegSid, agentLegSid, streamSid, timer }
//
// Valid states:
//   GREETING      — AI answered, sending opening greeting
//   QUALIFYING    — AI is qualifying the caller
//   TRANSFERRING  — Agent is being dialed, hold music playing, AI muted
//   CONNECTED     — Agent picked up, both parties bridged, AI doing intro
//   FALLBACK      — Transfer failed, AI returned to caller
//   DONE          — Call ended and logged

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

module.exports = {
  getCall,
  setCall,
  updateCall,
  deleteCall,
  getConversation,
  addMessage,
  getMediaConnection,
  setMediaConnection,
};
