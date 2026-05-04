require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');

const { handleInbound }     = require('./routes/inbound');
const twimlRoutes           = require('./routes/twiml');
const statusRoutes          = require('./routes/status');
const outboundRoutes        = require('./routes/outbound');
const { handleMediaStream } = require('./handlers/mediaStream');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, build: 'ERYN_BOOKING_V1' }));

// ── Twilio webhook routes ─────────────────────────────────────────────────────
app.post('/call/inbound', handleInbound);
app.use('/call/status',   statusRoutes);
app.use('/call/outbound', outboundRoutes);
app.use('/call',          twimlRoutes);

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = createServer(app);

const wss = new WebSocket.Server({ server, path: '/media-stream' });
wss.on('connection', (ws, req) => {
  console.log('[ws] Twilio media stream connected');
  handleMediaStream(ws, req);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('[server] ERYN_BOOKING_V1 running on port ' + PORT);
  console.log('[server] Public URL: ' + process.env.SERVER_URL);
});
