require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');

const { handleInbound } = require('./routes/inbound');
const { handleAmdResult } = require('./routes/amd');
const { handleStatus } = require('./routes/status');
const twimlRoutes = require('./routes/twiml');
const outboundRoutes = require('./routes/outbound');
const { handleMediaStream } = require('./handlers/mediaStream');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Twilio webhook routes ─────────────────────────────────────────────────────
app.post('/call/inbound',    handleInbound);
app.post('/call/amd-result', handleAmdResult);
app.post('/call/status',     handleStatus);

// ── Outbound + TwiML routes ───────────────────────────────────────────────────
app.use('/call', outboundRoutes);
app.use('/call', twimlRoutes);

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = createServer(app);

const wss = new WebSocket.Server({ server, path: '/media-stream' });
wss.on('connection', (ws, req) => {
  console.log('[ws] Twilio media stream connected');
  handleMediaStream(ws, req);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] Public URL: ${process.env.SERVER_URL}`);
});
