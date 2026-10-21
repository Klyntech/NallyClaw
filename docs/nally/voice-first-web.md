# Nally Voice-First Web

## Product goal

Give Nally a browser-based, real-time voice-call experience while keeping the existing OpenCode-derived runtime as the agentic engine. Deepgram handles live speech recognition; the existing Nally/OpenCode session handles reasoning and tool execution; ElevenLabs speaks Nally's response.

Do **not** route the conversation through Deepgram's hosted Voice Agent LLM. That would duplicate or replace the agent engine and break the product architecture.

## Target experience

- Open `/voice` in a browser over HTTPS.
- Tap **Start call** and grant microphone permission.
- Stream microphone audio to Deepgram's live transcription WebSocket using a short-lived Deepgram token minted by the backend.
- Display interim transcript and call state (Listening, Thinking, Using a tool, Speaking, Reconnecting).
- Submit finalized utterances to the existing Nally agent session. Wait for the completed assistant turn, not an intermediate tool-call iteration.
- Stream the completed response through ElevenLabs TTS and play it in the browser.
- Support mute, end call, reconnect, visible transcript, and interruption/barge-in as a follow-up milestone.
- Keep Telegram working independently; voice and Telegram must not share session mappings accidentally.

## Provider responsibilities

- **Deepgram:** live browser microphone transcription only.
- **OpenCode-derived runtime:** conversation history, model selection, tool calls, agent iterations, and final answer.
- **ElevenLabs:** low-latency speech synthesis for the final assistant response.

## Security and cost controls

- Keep `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` server-side only.
- Mint a short-lived Deepgram token via `POST https://api.deepgram.com/v1/auth/grant`; use `ttl_seconds` and pass only the returned token to the browser.
- Protect voice endpoints with a dedicated `NALLY_VOICE_ACCESS_TOKEN` until a proper account/session login is available. Never expose the internal agent API publicly.
- Require HTTPS, validate request sizes and text lengths, add basic rate limiting, and never log keys, access tokens, raw audio, or full private transcripts.
- Voice features should fail closed if provider keys or the access token are missing. Telegram text chat must remain available.

## Environment variables

Required to enable the voice MVP:

- `NALLY_VOICE_ACCESS_TOKEN`: a strong secret used by the browser voice page to authenticate voice requests.
- `DEEPGRAM_API_KEY`: server-only key used to mint short-lived live-transcription tokens.
- `ELEVENLABS_API_KEY`: server-only key used for speech synthesis.
- `ELEVENLABS_VOICE_ID`: chosen voice ID; do not hardcode an unverified account-specific voice.
- Optional model overrides: `DEEPGRAM_STT_MODEL` (default `nova-3`), `ELEVENLABS_TTS_MODEL` (default `eleven_flash_v2_5`).

Do not commit these values to Git.

## Delivery sequence

1. Add authenticated voice endpoints and an accessible `/voice` page without exposing the internal agent API.
2. Connect Deepgram live transcription and visible partial/final transcript.
3. Connect finalized utterances to Nally's existing session/prompt/wait flow.
4. Add ElevenLabs speech playback and call controls.
5. Add interruption handling, tests, usage limits, documentation, and browser/live verification.

## Acceptance criteria

- Browser microphone access works only over HTTPS/localhost and can be revoked by ending the call.
- No provider API key is present in client assets or browser network requests.
- A spoken prompt invokes the same configured Nally model and tool system as Telegram.
- Tool-call iterations are not spoken as final answers.
- Missing provider configuration produces a safe, actionable UI error and does not break Telegram.
- Tests cover authentication, token minting failures, malformed input, response errors, and session separation.
- Deployment is not considered verified until a live browser call succeeds on Render.


## Current implementation status

The first browser MVP is now present on branch `nally/voice-first-web`:

- `GET /` and `GET /voice` serve the browser call UI.
- `POST /api/voice/deepgram-token` mints a short-lived Deepgram token.
- `POST /api/voice/session` creates a separate OpenCode-derived session for the browser call.
- `POST /api/voice/message` submits a finalized transcript to that session and waits past tool-call iterations for the final answer.
- `POST /api/voice/speech` proxies ElevenLabs streaming TTS without exposing the provider key.
- Voice APIs require `Authorization: Bearer <NALLY_VOICE_ACCESS_TOKEN>`.
- The page captures microphone audio, streams 16 kHz linear PCM to Deepgram, shows the transcript, and plays generated speech.

## Current limitations / next verification

- This is turn-based voice, not yet full-duplex interruption: the microphone stream is suppressed while Nally is thinking or speaking. Barge-in and sentence-by-sentence speech streaming are follow-up work.
- Voice session mappings are in memory and are lost on restart.
- The access token is a shared service secret entered by the user; it is not a per-user identity system. Rotate it if exposed.
- Browser microphone access requires HTTPS (Render provides this) or localhost.
- No tests, typecheck, browser test, or live Render call have been verified yet. Do not treat this branch as production-ready until those pass.
