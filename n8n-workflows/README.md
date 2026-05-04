# Eryn Booking Flow — n8n Workflows Build Guide

You will build 6 workflows in n8n cloud. Each lives in project `jdmpfT2TlkXgnnpg`.
After all 6 are built and **activated**, copy each Webhook trigger's "Production
URL" into the Railway env vars listed at the bottom.

Inputs from Railway → outputs to GHL inbound webhooks (which fire the SMS).

---

## Workflow 1 — `Eryn — Qualifying Answer`  (the simplest pattern)

**Purpose:** receive qualifying-question answer from Railway, forward to GHL so Todd gets an SMS.

### Nodes

1. **Webhook** (n8n-nodes-base.webhook)
   - HTTP Method: `POST`
   - Path: `eryn-qualifying-answer`
   - Response Mode: `Last Node`
   - Authentication: `None`

2. **HTTP Request** — name it `POST to GHL`
   - Method: `POST`
   - URL: `https://services.leadconnectorhq.com/hooks/jUmgPC7zTylsGAEVqMCT/webhook-trigger/44430d10-f21c-4ace-b0bd-9a4133332706`
   - Send Headers: ON
     - Header `Content-Type` = `application/json`
   - Send Body: ON
   - Body Content Type: `JSON`
   - JSON Body: paste this expression:
     ```
     ={{ $json.body }}
     ```
   - Response → Response Format: `JSON`

### Connect
Webhook → POST to GHL

### Save & Activate
Toggle **Active** ON. Click "Webhook" node → copy the **Production URL**.
That URL becomes `N8N_QUALIFYING_URL` on Railway.

---

## Workflow 2 — `Eryn — Scan Times`  (Google Calendar lookup)

**Purpose:** given a requested time, return the 3 nearest free 15-min slots in Todd's working hours over the next 21 days.

### Nodes

1. **Webhook**
   - HTTP Method: `POST`
   - Path: `eryn-scan-times`
   - Response Mode: `Using 'Respond to Webhook' Node`

2. **Code** — name `Build Range`
   - Language: `JavaScript`
   - Mode: `Run Once for All Items`
   - JS:
     ```js
     const body = $input.first().json.body || $input.first().json;
     const requested = body.requested_time;
     const tz = body.timezone || 'America/Los_Angeles';
     const now = new Date();
     const timeMin = new Date(now.getTime() - 60*60*1000).toISOString();
     const timeMax = new Date(now.getTime() + 22*24*60*60*1000).toISOString();
     return [{ json: { requested, tz, timeMin, timeMax, body } }];
     ```

3. **Google Calendar** — name `Get Events`
   - Resource: `Event`
   - Operation: `Get Many`
   - Calendar: pick `nbarker7777@gmail.com` (your authorized credential)
   - Return All: ON  *(or Limit 250 if you prefer)*
   - Add Filter:
     - After: `={{ $('Build Range').first().json.timeMin }}`
     - Before: `={{ $('Build Range').first().json.timeMax }}`
     - Single Events: ON  *(critical — expands recurring events into instances)*

4. **Code** — name `Compute Slots`
   - Language: `JavaScript`
   - Mode: `Run Once for All Items`
   - JS:
     ```js
     const ctx = $('Build Range').first().json;
     const events = $input.all().map(i => i.json);
     const TZ = ctx.tz || 'America/Los_Angeles';
     const reqT = new Date(ctx.requested).getTime();

     // Build busy intervals (ms timestamps).
     const busy = events
       .map(e => ({
         start: new Date(e.start?.dateTime || e.start?.date || 0).getTime(),
         end:   new Date(e.end?.dateTime   || e.end?.date   || 0).getTime(),
       }))
       .filter(b => b.start && b.end);

     // PT day/time helper.
     const fmtParts = (d) => {
       const p = new Intl.DateTimeFormat('en-US', {
         timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit',
         day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
       }).formatToParts(d);
       const o = {};
       for (const x of p) o[x.type] = x.value;
       return { wd: o.weekday, h: +o.hour, m: +o.minute };
     };

     const startBound = Date.now() + 30*60*1000;          // 30-min lead time
     const endBound   = Date.now() + 21*24*60*60*1000;
     const candidates = [];

     for (let t = startBound; t <= endBound; t += 15*60*1000) {
       const pt = fmtParts(new Date(t));
       if (!['Mon','Tue','Wed','Thu','Fri'].includes(pt.wd)) continue;
       const startMin = pt.h * 60 + pt.m;
       // Working hours: 11:00–15:00 PT, with overflow allowed up to 15:15 start
       // (slot would end 15:30 — within "overflow into 3:30" per spec).
       if (startMin < 11*60) continue;
       if (startMin > 15*60 + 15) continue;
       const sStart = t;
       const sEnd   = t + 15*60*1000;
       if (busy.some(b => b.start < sEnd && b.end > sStart)) continue;
       candidates.push({ start: sStart, end: sEnd });
     }

     candidates.sort((a, b) => Math.abs(a.start - reqT) - Math.abs(b.start - reqT));

     const fmtLabel = (ms) => new Date(ms).toLocaleString('en-US', {
       timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
       hour: 'numeric', minute: '2-digit', hour12: true,
     });

     const slots = candidates.slice(0, 3).map(s => ({
       start_iso: new Date(s.start).toISOString(),
       end_iso:   new Date(s.end).toISOString(),
       label:     fmtLabel(s.start),
     }));

     return [{ json: { slots } }];
     ```

5. **Respond to Webhook** — name `Respond`
   - Respond With: `JSON`
   - Response Body: `={{ $json }}`

### Connect
Webhook → Build Range → Get Events → Compute Slots → Respond

### Save & Activate
Active ON → Webhook Production URL → `N8N_SCAN_URL` on Railway.

---

## Workflow 3 — `Eryn — Book Time`  (Google Calendar insert)

### Nodes

1. **Webhook**
   - Method: `POST`, Path: `eryn-book-time`
   - Response Mode: `Using 'Respond to Webhook' Node`

2. **Google Calendar** — name `Create Event`
   - Resource: `Event`
   - Operation: `Create`
   - Calendar: `nbarker7777@gmail.com`
   - Start: `={{ $json.body.start_iso || $json.start_iso }}`
   - End:   `={{ $json.body.end_iso   || $json.end_iso }}`
   - Use Default Reminders: ON
   - Additional Fields:
     - Summary: `={{ "Todd Call – " + ($json.body.caller_name || $json.caller_name) + " (" + ($json.body.caller_phone || $json.caller_phone) + ")" }}`
     - Description: `={{ "Booked via Eryn. CallSid: " + ($json.body.call_sid || $json.call_sid) }}`
     - Time Zone: `America/Los_Angeles`

3. **Respond to Webhook**
   - Respond With: `JSON`
   - Response Body:
     ```
     ={{ { appointment_id: $json.id, start_iso: $json.start.dateTime } }}
     ```

### Connect
Webhook → Create Event → Respond

### Activate → URL → `N8N_BOOK_URL`

---

## Workflow 4 — `Eryn — Appt Details`  (notify Todd of booking)

### Nodes

1. **Webhook**: Method `POST`, Path `eryn-appt-details`, Response Mode `Last Node`
2. **HTTP Request** — name `POST to GHL`
   - Method: `POST`
   - URL: `https://services.leadconnectorhq.com/hooks/jUmgPC7zTylsGAEVqMCT/webhook-trigger/5304b2a5-45ff-4fae-8eb5-9674e88a15fe`
   - Headers: `Content-Type: application/json`
   - Body Content Type: `JSON`
   - JSON Body: `={{ $json.body }}`

### Connect: Webhook → POST to GHL

### Activate → URL → `N8N_APPT_DETAILS_URL`

---

## Workflow 5 — `Eryn — Todd Successful`  (cancel appt + notify Todd)

### Nodes

1. **Webhook**: Method `POST`, Path `eryn-todd-success`, Response Mode `Last Node`

2. **IF** — name `Has Appointment`
   - Condition: String → `={{ $json.body.appointment_id || $json.appointment_id }}` is not empty

3. **Google Calendar** — name `Delete Event` (TRUE branch)
   - Resource: `Event`
   - Operation: `Delete`
   - Calendar: `nbarker7777@gmail.com`
   - Event ID: `={{ $json.body.appointment_id || $json.appointment_id }}`
   - On Error: `Continue` *(handles already-deleted gracefully)*

4. **HTTP Request** — name `POST to GHL` (runs after both branches merge, OR run from Webhook in parallel — see connections)
   - URL: `https://services.leadconnectorhq.com/hooks/jUmgPC7zTylsGAEVqMCT/webhook-trigger/ab16bf87-7267-4bfb-bdd0-546afc9727d2`
   - Method: `POST`, Headers + Body same as Workflow 4
   - JSON Body: `={{ $('Webhook').first().json.body }}`

### Connect

The cleanest layout uses two parallel paths from the Webhook:

- Path A: Webhook → IF → (true) Delete Event
- Path B: Webhook → POST to GHL

Both branches are independent. To accomplish this, after the Webhook node, drag two arrows out of its single output → one into IF, one into POST to GHL.

### Activate → URL → `N8N_TODD_SUCCESS_URL`

---

## Workflow 6 — `Eryn — Todd Unsuccessful`  (notify Todd of missed call)

Identical pattern to Workflow 4.

### Nodes

1. **Webhook**: Method `POST`, Path `eryn-todd-failed`, Response Mode `Last Node`
2. **HTTP Request** — name `POST to GHL`
   - URL: `https://services.leadconnectorhq.com/hooks/jUmgPC7zTylsGAEVqMCT/webhook-trigger/3e2d0fbd-4d25-4e78-b4d9-ce48ab26b245`
   - Method: `POST`, Headers + Body same as Workflow 4
   - JSON Body: `={{ $json.body }}`

### Connect: Webhook → POST to GHL

### Activate → URL → `N8N_TODD_FAILED_URL`

---

## Final Step — Railway Env Vars

After all 6 workflows are saved & **active**, set these env vars on Railway and redeploy:

```
N8N_QUALIFYING_URL=https://noahb77.app.n8n.cloud/webhook/eryn-qualifying-answer
N8N_SCAN_URL=https://noahb77.app.n8n.cloud/webhook/eryn-scan-times
N8N_BOOK_URL=https://noahb77.app.n8n.cloud/webhook/eryn-book-time
N8N_APPT_DETAILS_URL=https://noahb77.app.n8n.cloud/webhook/eryn-appt-details
N8N_TODD_SUCCESS_URL=https://noahb77.app.n8n.cloud/webhook/eryn-todd-success
N8N_TODD_FAILED_URL=https://noahb77.app.n8n.cloud/webhook/eryn-todd-failed
```

(Replace each with the exact "Production URL" shown in each workflow's Webhook node — they should match the paths above.)

## Sanity Test (after activation)

```bash
# Test Workflow 1 (qualifying)
curl -X POST https://noahb77.app.n8n.cloud/webhook/eryn-qualifying-answer \
  -H 'Content-Type: application/json' \
  -d '{"call_sid":"TEST","caller_name":"Bernard Smith","caller_phone":"+15551234567","answer":"yes","answer_text":"is interested in detailed planning services"}'
```

Expect: 200 OK, GHL workflow fires, you get the test SMS.

```bash
# Test Workflow 2 (scan)
curl -X POST https://noahb77.app.n8n.cloud/webhook/eryn-scan-times \
  -H 'Content-Type: application/json' \
  -d '{"call_sid":"TEST","requested_time":"2026-05-01T13:00:00-07:00","timezone":"America/Los_Angeles"}'
```

Expect: JSON response with 3 slot objects.

```bash
# Test Workflow 3 (book) — book a real test event
curl -X POST https://noahb77.app.n8n.cloud/webhook/eryn-book-time \
  -H 'Content-Type: application/json' \
  -d '{"call_sid":"TEST","caller_name":"Bernard Smith","caller_phone":"+15551234567","start_iso":"2026-05-01T13:00:00-07:00","end_iso":"2026-05-01T13:15:00-07:00","timezone":"America/Los_Angeles"}'
```

Expect: JSON `{appointment_id: "abc", start_iso: "..."}`. Verify event appears in your Google Calendar — then delete it manually before the next test.
