# Phone and text agent

OpenMaus can use a Twilio number for inbound and outbound calls, plus inbound
and approved outbound SMS. Twilio ConversationRelay handles call speech
recognition and speech synthesis; the phone agent uses an OpenAI-compatible
chat-completions model for replies. The prompt uses a concise, curious,
lightly playful style. It does not require xAI/Grok.

## Configure the server

Set these values in the server environment or `.env`:

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567
OWNER_PHONE_NUMBER=+15557654321
PHONE_OWNER_NAME=Your Name
PHONE_AGENT_NAME=OpenMaus
TELEPHONY_PUBLIC_URL=https://your-public-host.example
```

The Twilio number must support Voice and SMS. The public address must route
HTTPS requests and WSS upgrades to this server. `TELEPHONY_PUBLIC_URL` takes
precedence over `OMB_PUBLIC_URL` and the app's saved custom-domain/fallback URL;
it must not include a trailing slash. The app can also use its saved custom
domain or fallback public URL. A private Tailscale address or plain LAN address
is not sufficient for Twilio webhooks; Twilio must be able to reach this URL.

For model replies, the server checks `PHONE_AGENT_API_BASE_URL`,
`PHONE_AGENT_API_KEY`, and `PHONE_AGENT_MODEL` first. If these are unset, it
uses `MINIMAX_BASE_URL`/`MINIMAX_API_KEY` and then the local MiniMax CLI
configuration at `~/.mmx/config.json`. The model defaults to
`MiniMax-M2.7-highspeed` if no model is configured. Any compatible chat
completions API can be selected with the `PHONE_AGENT_*` settings.

## Configure the Twilio number

In the Twilio Console, set the number's incoming voice webhook to
`https://your-public-host.example/api/telephony/voice` using HTTP POST, and its
incoming message webhook to
`https://your-public-host.example/api/telephony/sms` using HTTP POST. Enable
Twilio ConversationRelay for the account. The voice webhook returns TwiML that
connects to `wss://your-public-host.example/api/telephony/relay`.

Twilio requests are admitted before OpenMaus's normal app authentication only
after validation with `X-Twilio-Signature`. The server builds the signed URL
from the configured public address, not an untrusted Host or forwarded-host
header.

## Use the authenticated phone API

These routes accept an `admin` session or a limited `phone` session. From the
computer, open **Settings → Phone & devices** and create a pairing code with
**Phone assistant (calls and texts)** access. Pair the phone PWA with that
code. This grants the phone regular client access plus the telephony routes,
without giving it workspace administration. Keep the session token private.

The Phone assistant panel reports whether the Twilio account, model and public
HTTPS address appear configured. It never returns an account token or model
key. A ready status does not verify that Twilio's console webhooks are pointed
to this server.

Start an outbound call:

```http
POST /api/telephony/calls/outbound
Content-Type: application/json

{"to":"+15557654321","objective":"Ask whether Tuesday at 2 works for the appointment."}
```

The call begins immediately. The assistant identifies itself as an AI calling
on the owner's behalf and follows the supplied objective. It cannot access
OpenMaus contacts, files, calendar, or other tools.

Create and approve an outbound text as two distinct requests:

```http
POST /api/telephony/sms/drafts
Content-Type: application/json

{"to":"+15557654321","body":"I can meet Tuesday at 2."}
```

The response contains a draft `id`. Send that exact saved draft only after
review:

```http
POST /api/telephony/sms/drafts/DRAFT_ID/approve
Content-Type: application/json

{"confirm":true}
```

Cancel a pending draft at
`POST /api/telephony/sms/drafts/DRAFT_ID/cancel`. Read the message history at
`GET /api/telephony/sms`. A draft can be sent only once.

Inbound texts receive an automatic short reply. The service limits automatic
replies to 12 messages per sender in an hour. Call conversations stay in
memory for the life of the WebSocket; the server does not save call audio or
transcripts. SMS bodies and statuses are stored in `telephony.json` under the
OpenMaus data directory, capped at the latest 200 messages.

## Current scope

The Phone & devices Settings panel supports inbound SMS history, draft and
approval of outbound texts, and reviewed outbound calls on desktop and phone.
Inbound calls and texts are answered automatically by the configured agent.
Call audio and transcripts are not saved. The isolated verification fixture
uses fake credentials and does not contact Twilio or a model provider.

To run that fixture from the repository root:

```sh
pnpm exec vitest run server/telephony/agent.test.ts server/telephony/service.test.ts server/routes/telephony.test.ts
```
