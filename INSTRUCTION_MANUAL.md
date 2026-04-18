# AI Live Transfer System — Instruction Manual
### Frazier Industries | Agent: Todd | Assistant: Aria

---

## What This System Does

When a client calls your Twilio phone number, an AI named Aria answers and has a natural
conversation. When the client is qualified and ready, Aria silently dials Todd in the
background while the client hears hold music. If Todd picks up, the call bridges seamlessly
with a warm introduction. If Todd doesn't answer, Aria leaves him a voicemail silently and
returns to the client as if nothing happened — offering to schedule a callback or take a
message. The client never hears a phone ringing or dead air. It sounds like a real human
agent transfer.

---

## System Architecture

```
Client calls Twilio number
        │
        ▼
  Twilio receives call
        │
        ├── Opens Media Stream WebSocket to your server
        └── Places client in Conference Room (hold music plays)
                │
                ▼
        Your Node.js Server
                │
                ├── Audio → Deepgram (speech-to-text, real-time)
                ├── Text  → Claude Haiku (conversation + decision)
                └── Text  → ElevenLabs (text-to-speech, injected back)
                │
                │  [TRANSFER] signal detected
                ▼
        Transfer Handler
                │
                ├── Mutes AI audio (client hears hold music)
                ├── Dials Todd via Twilio (separate call leg)
                └── AMD: waits up to 20 seconds
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
         HUMAN PICKS UP       VOICEMAIL / NO ANSWER
              │                    │
              │             Leave voicemail (silent)
              │             Return AI to client
              ▼                    ▼
       Bridge conference    AI delivers fallback message
       AI does warm intro   Offers to schedule callback
       AI removed           Call continues
       Agent + client alone
```

---

## Tech Stack

| Role | Tool | Why |
|------|------|-----|
| Phone numbers + call routing | Twilio | Programmable conference rooms, AMD, media streams |
| Speech-to-text | Deepgram Nova-2 | Under 200ms latency, streaming transcription |
| AI brain | Claude Haiku | Fast, cheap, handles structured conversations perfectly |
| Text-to-speech | ElevenLabs Turbo v2 | Most human-sounding, lowest latency, ulaw_8000 output |
| Orchestration server | Node.js + Express | Manages all state and coordinates every piece |
| Deployment | Railway | Always-on, deploys from GitHub, free to start |
| CRM logging | HubSpot or Airtable | Records every call outcome (optional) |

---

## Cost Per Call (Approximate)

| Service | Cost per 5-minute call |
|---------|----------------------|
| Deepgram Nova-2 | ~$0.02 |
| Claude Haiku | ~$0.001 |
| ElevenLabs Turbo | ~$0.005 |
| Twilio (inbound + agent dial) | ~$0.017 |
| **Total** | **~$0.04–0.05** |

Compare to GPT-4o Realtime: ~$0.50–$1.50 per call. This stack is 10–30x cheaper.

---

## Project File Structure

```
ai-transfer-system/
├── src/
│   ├── index.js                  ← Server entry point
│   ├── config.js                 ← All environment variables
│   ├── store.js                  ← In-memory call state tracker
│   ├── twilioClient.js           ← All Twilio API commands
│   ├── routes/
│   │   ├── inbound.js            ← Answers incoming calls from Twilio
│   │   ├── amd.js                ← Handles voicemail vs human detection
│   │   ├── status.js             ← Tracks call status events
│   │   └── twiml.js              ← Serves hold music + conference TwiML
│   └── handlers/
│       ├── mediaStream.js        ← Manages Twilio WebSocket audio stream
│       ├── aiPipeline.js         ← Deepgram → Haiku → ElevenLabs pipeline
│       ├── transferHandler.js    ← Core transfer state machine
│       └── logging.js            ← HubSpot + Airtable call logging
├── system-prompt.txt             ← Aria's personality and scripts
├── .env                          ← Your API keys (never commit this)
├── .env.example                  ← Template for .env
├── .gitignore                    ← Keeps .env off GitHub
├── package.json                  ← Node dependencies
└── INSTRUCTION_MANUAL.md         ← This file
```

---

## Step-by-Step Setup

### Step 1 — Get a Twilio Account

1. Go to https://twilio.com and sign up (free trial available)
2. From your dashboard, copy:
   - **Account SID** → paste into `.env` as `TWILIO_ACCOUNT_SID`
   - **Auth Token** → paste into `.env` as `TWILIO_AUTH_TOKEN`
3. Go to **Phone Numbers → Buy a Number** → buy a US number
   - Copy the number (e.g. `+18005551234`) → paste into `.env` as `TWILIO_PHONE_NUMBER`
4. Do NOT configure the number yet — you'll do that in Step 6

---

### Step 2 — Get a Deepgram Account

1. Go to https://console.deepgram.com and sign up (free $200 credit)
2. Go to **API Keys → Create a New API Key**
3. Copy the key → paste into `.env` as `DEEPGRAM_API_KEY`

---

### Step 3 — Get an Anthropic Account

1. Go to https://console.anthropic.com and sign up
2. Go to **API Keys → Create Key**
3. Copy the key → paste into `.env` as `ANTHROPIC_API_KEY`
4. Add a payment method (required even for small usage)

---

### Step 4 — Get an ElevenLabs Account

1. Go to https://elevenlabs.io and sign up (free tier available)
2. Go to **Profile → API Key** → copy it → paste into `.env` as `ELEVENLABS_API_KEY`
3. Go to **Voice Library** and choose a voice, or create one
4. Click the voice → copy the **Voice ID** → paste into `.env` as `ELEVENLABS_VOICE_ID`
   - Recommended: choose a warm, professional female voice for Aria

---

### Step 5 — Deploy to Railway

#### 5a — Push code to GitHub
1. Go to https://github.com → create a new repo (name it `ai-transfer-system`)
2. Download **GitHub Desktop** from https://desktop.github.com
3. Open GitHub Desktop → sign in → click **Add Local Repository**
4. Navigate to this project folder and select it
5. Click **Commit to main** → then **Push origin**

#### 5b — Deploy on Railway
1. Go to https://railway.app → sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `ai-transfer-system` repo
4. Railway will auto-detect Node.js and start deploying
5. Click your service → **Settings → Networking → Generate Domain**
6. Copy the URL (e.g. `https://ai-transfer-system.up.railway.app`)
7. Paste it into your `.env` as `SERVER_URL`
8. Go to **Variables** tab in Railway → add every variable from your `.env` file
9. Railway will restart automatically

#### 5c — Verify it's running
Open a browser and go to:
```
https://your-app.up.railway.app/health
```
You should see: `{"ok":true}`

---

### Step 6 — Connect Twilio to Your Server

1. Go to https://console.twilio.com
2. Go to **Phone Numbers → Manage → Active Numbers**
3. Click your phone number
4. Under **Voice Configuration**:
   - **A call comes in**: Webhook
   - **URL**: `https://your-app.up.railway.app/call/inbound`
   - **HTTP Method**: `POST`
5. Click **Save**

---

### Step 7 — Test the System

**Test 1 — Full successful transfer:**
- Call your Twilio number
- Go through the qualifying conversation
- Have Todd answer when Aria tries to transfer
- You should hear: AI speaks → hold music → AI warm intro → Todd and client connected

**Test 2 — Voicemail fallback:**
- Call your Twilio number
- Go through the qualifying conversation
- Have Todd NOT answer (let it go to voicemail)
- You should hear: AI speaks → hold music → AI returns seamlessly → offers callback

**Test 3 — No answer at all:**
- Same as Test 2 but Todd's phone is off
- Should behave identically to voicemail fallback

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVER_URL` | ✅ | Your Railway public URL |
| `PORT` | ✅ | Server port (default: 3000) |
| `TWILIO_ACCOUNT_SID` | ✅ | From Twilio dashboard |
| `TWILIO_AUTH_TOKEN` | ✅ | From Twilio dashboard |
| `TWILIO_PHONE_NUMBER` | ✅ | Your Twilio phone number |
| `AGENT_PHONE` | ✅ | Todd's direct line |
| `AGENT_NAME` | ✅ | Todd |
| `TRANSFER_TIMEOUT_SECONDS` | ✅ | How long to wait for Todd (default: 20) |
| `DEEPGRAM_API_KEY` | ✅ | From Deepgram console |
| `DEEPGRAM_MODEL` | ✅ | nova-2 (best accuracy) |
| `DEEPGRAM_ENDPOINTING` | ✅ | 300ms (silence before AI responds) |
| `ANTHROPIC_API_KEY` | ✅ | From Anthropic console |
| `ANTHROPIC_MODEL` | ✅ | claude-haiku-4-5 |
| `ELEVENLABS_API_KEY` | ✅ | From ElevenLabs dashboard |
| `ELEVENLABS_VOICE_ID` | ✅ | Your chosen voice ID |
| `ELEVENLABS_MODEL` | ✅ | eleven_turbo_v2 (lowest latency) |
| `COMPANY_NAME` | ✅ | Frazier Industries |
| `ASSISTANT_NAME` | ✅ | Aria |
| `HUBSPOT_API_KEY` | ❌ | Optional — for CRM logging |
| `AIRTABLE_API_KEY` | ❌ | Optional — for CRM logging |

---

## Troubleshooting

**AI doesn't respond to speech**
- Check Deepgram API key is correct
- Check Twilio Media Stream URL points to `wss://your-app.up.railway.app/media-stream`
- Check Railway logs for errors

**AI cuts off mid-sentence**
- Increase `DEEPGRAM_ENDPOINTING` from 300 to 500
- This gives more silence before Deepgram triggers a final transcript

**Transfer never triggers**
- Make sure system prompt includes `[TRANSFER]` on the correct line
- Check Railway logs — look for "Transfer signal received"

**Client hears ringing during transfer**
- This means the conference hold music isn't configured
- Verify `HOLD_MUSIC_URL` is accessible, or leave it blank to use Twilio's default

**AMD always returns "machine"**
- Twilio AMD can be slow — increase `TRANSFER_TIMEOUT_SECONDS` to 25
- Make sure Todd's phone has a greeting (not silent)

**Server returns 500 errors**
- Check Railway → Deployments → view logs
- Most common cause: missing environment variable

---

## Call State Machine

```
GREETING → QUALIFYING → TRANSFERRING → CONNECTED → DONE
                    └──────────────→ FALLBACK
```

- `GREETING` — AI just answered, about to speak the opening line
- `QUALIFYING` — AI is having the qualifying conversation with the client
- `TRANSFERRING` — Transfer dial is in progress, client hears hold music
- `CONNECTED` — Agent picked up, AI doing warm intro
- `FALLBACK` — Transfer failed, AI returned to client
- `DONE` — Call handed off to agent, AI removed from conference

---

## Accounts You Need (Summary)

1. **Twilio** — https://twilio.com (free trial with $15 credit)
2. **Deepgram** — https://console.deepgram.com (free $200 credit)
3. **Anthropic** — https://console.anthropic.com (pay as you go, ~$0.001/call)
4. **ElevenLabs** — https://elevenlabs.io (free tier: 10,000 chars/month)
5. **Railway** — https://railway.app (free tier available)
6. **GitHub** — https://github.com (free)
