/**
 * index.js — Entry point
 * Starts the Express HTTP server + WebSocket server.
 * Registers all routes and the Twilio Media Stream WebSocket handler.
 */

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { WebSocketServer } = require('ws');
const url        = require('url');

const config      = require('./config');
const inbound     = require('./routes/inbound');
const amdRoute    = require('./routes/amd');
const statusRoute = require('./routes/status');
const twimlRoute  = require('./routes/twiml');
const { handleMediaStream } = require('./handlers/mediaStream');

// ── Validate required config ──────────────────────────────────────────────────
const required = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
  'SERVER_URL',
];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));  // Twilio sends form-encoded bodies
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/call/inbound',            inbound);
app.post('/call/amd-result',         amdRoute);
app.post('/call/status',             statusRoute);
app.post('/call/agent-status',       statusRoute);   // agent leg events
app.post('/call/conference-status',  statusRoute);
app.post('/call/recording',          statusRoute);
app.use('/twiml',                    twimlRoute);
app.get('/health',                   (req, res) => res.json({ ok: true }));

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/media-stream') {
    console.log('[WS] New media stream connection');
    handleMediaStream(ws);
  } else {
    console.warn(`[WS] Unknown WebSocket path: ${pathname}`);
    ws.close();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(config.PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║     AI Transfer System — ${config.COMPANY_NAME.padEnd(20)}║
  ║     Agent: ${config.AGENT_NAME.padEnd(35)}║
  ╚══════════════════════════════════════════════╝
  Server:    http://localhost:${config.PORT}
  Public:    ${config.SERVER_URL}
  Webhook:   ${config.SERVER_URL}/call/inbound
  `);
});

module.exports = server;
