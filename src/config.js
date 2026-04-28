require('dotenv').config();

module.exports = {
  // ── Server ──────────────────────────────────────────────────────────────
  PORT: process.env.PORT || 3000,
  SERVER_URL: process.env.SERVER_URL, // your Railway URL e.g. https://xxx.up.railway.app

  // ── Twilio ───────────────────────────────────────────────────────────────
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN:  process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,

  // ── Transfer target (Todd) ───────────────────────────────────────────────
  AGENT_PHONE:  process.env.AGENT_PHONE  || '+17146241900',
  AGENT_NAME:   process.env.AGENT_NAME   || 'Todd',
  TRANSFER_TIMEOUT_MS: parseInt(process.env.TRANSFER_TIMEOUT_SECONDS || '20') * 1000,

  // ── Deepgram ─────────────────────────────────────────────────────────────
  DEEPGRAM_API_KEY:    process.env.DEEPGRAM_API_KEY,
  DEEPGRAM_MODEL:      process.env.DEEPGRAM_MODEL      || 'nova-2',
  DEEPGRAM_LANGUAGE:   process.env.DEEPGRAM_LANGUAGE   || 'en-US',
  DEEPGRAM_ENDPOINTING: parseInt(process.env.DEEPGRAM_ENDPOINTING || '300'),

  // ── Anthropic (Claude Haiku) ─────────────────────────────────────────────
  ANTHROPIC_API_KEY:      process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL:        process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  MAX_RESPONSE_TOKENS:    parseInt(process.env.MAX_RESPONSE_TOKENS || '150'),

  // ── ElevenLabs ───────────────────────────────────────────────────────────
  ELEVENLABS_API_KEY:  process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  // Must match the default in handlers/aiPipeline.js — flash_v2_5 has the
  // lowest end-to-end latency for ulaw_8000 streaming, which the call needs.
  ELEVENLABS_MODEL:    process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',

  // ── Branding ─────────────────────────────────────────────────────────────
  COMPANY_NAME:    process.env.COMPANY_NAME    || 'Frazier Industries',
  ASSISTANT_NAME:  process.env.ASSISTANT_NAME  || 'Eryn',

  // ── CRM (optional) ───────────────────────────────────────────────────────
  HUBSPOT_API_KEY:  process.env.HUBSPOT_API_KEY  || '',
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY || '',
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || '',
};
