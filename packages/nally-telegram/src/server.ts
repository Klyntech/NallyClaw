import { spawn } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { voicePage } from "./voice-page"
import { createTelegramWebhook, type TelegramProgressReporter, type TelegramTextMessage } from "./webhook"
import { selectedModel } from "./model-config"
import { buildConversationContext } from "../../core/src/nally-memory/retrieval"
import { waitForAssistantMessage } from "./wait-for-response"
import { checkMemoryDatabase, getRecentConversationTurns, getTelegramSession, saveConversationTurn, saveTelegramSession, searchConversationTurns } from "../../core/src/nally-memory/store"

const host = "127.0.0.1"
const internalPort = Number(process.env.NALLY_INTERNAL_PORT ?? 3001)
const port = Number(process.env.PORT ?? 3000)
const publicURL = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "")
const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ""
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? ""
const allowedUserIDs = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
)

const password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || crypto.randomUUID()
process.env.OPENCODE_SERVER_PASSWORD = password
const internalURL = `http://${host}:${internalPort}`
const auth = `Basic ${btoa(`opencode:${password}`)}`
const sessions = new Map<number, string>()
const voiceSessions = new Map<string, string>()
const voiceRestoreSessions = new Set<string>()
const voiceProgress = new Map<string, string>()
// Cache short, repeated voice fillers so ElevenLabs is only called once per phrase/voice/model.
const speechCache = new Map<string, { audio: Uint8Array; contentType: string; cachedAt: number }>()
const SPEECH_CACHE_MAX_ENTRIES = 64
const SPEECH_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHEABLE_VOICE_FILLERS = new Set([
  "I'm looking that up now.",
  "Let me find the most relevant sources.",
  "I'll check a couple of sources first.",
  "I'm searching for reliable information.",
  "Let me see what the web turns up.",
  "I'm opening that page now.",
  "I've found a page to check.",
  "Let me pull up the page details.",
  "I'm fetching the page so I can inspect it.",
  "Let me go through the page.",
  "I'm reading through the relevant sections.",
  "I'll check what the page actually says.",
  "Let me pull out the useful details.",
  "Let me inspect the file first.",
  "I'm reading through that file.",
  "I'll trace how this file is put together.",
  "Let me see how this is wired up.",
  "I'm checking the relevant files.",
  "I'll trace where that comes from.",
  "Let me find the part that matters.",
  "I'm looking across the project for that.",
  "I'm making that change now.",
  "I've found where to update it.",
  "I'm adjusting that part of the code.",
  "Let me make the change in the right place.",
  "I'm writing that out now.",
  "I'm putting the changes into the file.",
  "Let me update the implementation.",
  "I'm applying that edit now.",
  "I'm running that and checking the result.",
  "Let's see what the command reports.",
  "I'm checking the output now.",
  "I'll verify what that produces.",
  "Let me check what I have in memory.",
  "I'm checking the saved context.",
  "I'll look at the relevant conversation context.",
  "Let me check what was saved.",
  "I'm splitting up part of the work to check it carefully.",
  "I'm asking a helper process to inspect one part.",
  "I'll check this part separately as well.",
  "I'm using a tool to check that.",
  "I'm checking that with the relevant tool.",
  "Let me use the right tool for this.",
  "I'm verifying that with a tool.",
  "Let me work through this.",
  "I'm connecting the pieces now.",
  "I'm working out the next step.",
  "Give me a moment to reason this through.",
  "I'm working through that now.",
  "Let me check the next step.",
  "I'm putting the pieces together.",
])
const voiceAccessToken = process.env.NALLY_VOICE_ACCESS_TOKEN?.trim() ?? ""
let voiceRateWindowStart = Date.now()
let voiceRateCount = 0

function log(message: string, error?: unknown) {
  // Never log credentials, webhook URLs containing tokens, or raw Telegram payloads.
  console.error(`[nally-telegram] ${message}`, error instanceof Error ? error.message : error ?? "")
}

async function api(path: string, init?: RequestInit, timeoutMs = 15_000) {
  const response = await fetch(new URL(path, internalURL), {
    ...init,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`agent API returned HTTP ${response.status}`)

  // OpenCode's wait endpoint may complete successfully with an empty response body.
  // Only parse JSON when the endpoint actually returned content.
  const body = await response.text()
  if (!body.trim()) return undefined
  try {
    return JSON.parse(body) as any
  } catch {
    throw new Error(`agent API returned invalid JSON for ${path}`)
  }
}

async function waitForAgent() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (agent.exitCode !== null) throw new Error("agent server exited during startup")
    try {
      const response = await fetch(new URL("/api/info", internalURL), {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {}
    await Bun.sleep(1_000)
  }
  throw new Error("agent server did not become ready")
}

async function agentSessionExists(sessionID: string): Promise<boolean> {
  try {
    const response = await fetch(new URL(`/api/session/${encodeURIComponent(sessionID)}`, internalURL), {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}

function credentialPresence(name: string) {
  return process.env[name]?.trim() ? "present" : "missing"
}

function authFailureHint(error: any) {
  const reason = error?.reason ?? error?.data?.reason ?? error?.cause?.reason
  const message = [
    error?.message,
    reason?.message,
    error?.data?.message,
    error?.cause?.message,
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase()
  const status = [
    error?.status,
    error?.response?.status,
    reason?.http?.status,
    error?.http?.status,
  ].find((value) => typeof value === "number")

  // Return only a category; never log provider response bodies or raw errors.
  if (/not set|missing auth credential|missing credential|no api key|api key required|credential required/.test(message)) {
    return "missing-credential"
  }
  if (/model.{0,30}(disabled|not enabled|not available|no access)|disabled.{0,30}model/.test(message)) {
    return "model-not-enabled"
  }
  if (/insufficient credits|no credits|billing|quota|usage limit|credits exhausted|payment required/.test(message)) {
    return "account-limit-or-billing"
  }
  if (/invalid api key|incorrect api key|invalid token|expired key|revoked key/.test(message) || status === 401) {
    return "credential-rejected"
  }
  if (/unknown model|model not found|unsupported model/.test(message)) {
    return "model-id-not-recognized"
  }
  if (/workspace|organization|permission|not authorized|access denied|forbidden/.test(message)) {
    return "workspace-or-model-permission"
  }
  if (status === 403) return "provider-403-details-not-exposed"
  return "auth-details-unavailable"
}

async function recoveredConversationPrompt(userID: number, currentText: string) {
  const [recent, relevant] = await Promise.all([
    getRecentConversationTurns(userID, 8),
    searchConversationTurns(userID, currentText, 3),
  ])
  return buildConversationContext(recent, relevant, currentText)
}

async function onMessage(message: TelegramTextMessage, reportProgress: TelegramProgressReporter): Promise<string> {
  let stage = "waiting for agent readiness"
  const startedAt = Date.now()
  try {
    await reportProgress("🤔 Thinking…")
    // Telegram may deliver queued updates while this process is booting.
    await waitForAgent()

    let sessionID = sessions.get(message.userID)
    let restoreHistory = false
    if (!sessionID) {
      stage = "restoring Telegram session"
      await reportProgress("🗂️ Restoring conversation…")
      sessionID = await getTelegramSession(message.userID)
      // The mapping lives in Neon, but the upstream runtime's session database may
      // still be local SQLite. Never reuse a Neon mapping to a missing runtime session.
      if (sessionID && !(await agentSessionExists(sessionID))) {
        sessionID = undefined
        restoreHistory = true
      }
      if (!sessionID) {
        stage = "creating session"
        await reportProgress("🧵 Starting conversation…")
        const model = selectedModel()
        const created = await api("/api/session", {
          method: "POST",
          body: JSON.stringify({
            title: `Telegram chat ${message.userID}`,
            ...(model ? { model } : {}),
          }),
        })
        const createdID = created.data?.id
        if (typeof createdID !== "string" || !createdID) throw new Error("agent did not create a session")
        stage = "persisting Telegram session"
        await reportProgress("💾 Saving conversation…")
        sessionID = await saveTelegramSession(message.userID, createdID)
        // Neon is the durable transcript. If the runtime SQLite session disappeared,
        // rebuild a bounded context from completed turns before accepting new work.
        restoreHistory = true
      }
      sessions.set(message.userID, sessionID)
    }

    let promptText = message.text
    if (restoreHistory) promptText = await recoveredConversationPrompt(message.userID, message.text)

    stage = "submitting prompt"
    await reportProgress("🤔 Thinking…")
    const admitted = await api(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: promptText, metadata: { channel: "telegram", updateID: message.updateID } }),
    }, 120_000)
    const userMessageID = admitted.data?.id
    if (typeof userMessageID !== "string" || !userMessageID) throw new Error("agent did not accept the message")

    stage = "waiting for model completion"
    // OpenCode's wait endpoint may return immediately if the wake-up has not started
    // yet. The TUI follows the event stream; Telegram instead polls the durable message
    // projection until this exact user turn has a completed assistant message.
    const { messages, userIndex } = await waitForAssistantMessage(
      () => api(`/api/session/${encodeURIComponent(sessionID)}/message?limit=200&order=desc`),
      userMessageID,
      { timeoutMs: 120_000, pollIntervalMs: 500, sleep: (ms) => Bun.sleep(ms), onProgress: reportProgress },
    )

    stage = "reading assistant response"
    await reportProgress("✍️ Preparing response…")
    const candidates = userIndex >= 0 ? messages.slice(0, userIndex) : []
    const assistantDiagnostics: string[] = []
    for (const candidate of candidates) {
      if (candidate.type !== "assistant") continue
      const parts = Array.isArray(candidate.content) ? candidate.content : []
      const text = parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("")
        .trim()
      // Tool-call iterations can contain user-facing commentary, but are not the final answer.
      if (text && !candidate.error && String(candidate.finish ?? "").toLowerCase() !== "tool-calls") {
        await saveConversationTurn({
          userID: message.userID,
          sessionID,
          source: "telegram",
          sourceEventID: String(message.updateID),
          userText: message.text,
          assistantText: text,
        })
        log(`message completed and persisted in ${Date.now() - startedAt}ms`)
        return text
      }

      // Log structure only: never emit prompt text, model output, credentials, or raw provider errors.
      const error = candidate.error
      const errorKind = error && typeof error === "object"
        ? String(error.name ?? error.type ?? error.code ?? "present").slice(0, 60)
        : error ? "present" : "none"
      const status = typeof error?.status === "number" ? error.status : "unknown"
      const authHint = error && typeof error === "object" && String(error.type ?? "").startsWith("provider.auth")
        ? `;authHint=${authFailureHint(error)}`
        : ""
      assistantDiagnostics.push(
        `error=${errorKind};status=${status}${authHint};provider=${String(candidate.model?.providerID ?? candidate.providerID ?? "unknown").slice(0, 60)};model=${String(candidate.model?.id ?? candidate.modelID ?? "unknown").slice(0, 80)};parts=${parts.map((part: any) => String(part?.type ?? "unknown")).slice(0, 12).join("/") || "none"}`,
      )
    }

    const newestTypes = messages.slice(0, 8).map((item: any) => item?.type ?? "unknown").join(",")
    log(`completed turn has no assistant text (user message found: ${userIndex >= 0}; newest types: ${newestTypes || "none"}; assistant diagnostics: ${assistantDiagnostics.slice(0, 4).join(" | ") || "none"})`)
    if (assistantDiagnostics.some((item) => item.includes("error=provider.auth"))) {
      return "Nally couldn't authenticate with the configured AI provider. The service now records a safe diagnostic; check the provider's API key and model access in Render."
    }
    return "I couldn't get a text response from the model. Please try again; if this keeps happening, the model/provider configuration needs checking."
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log(`message failed at stage "${stage}" after ${Date.now() - startedAt}ms`, detail)
    throw error
  }
}

const agent = spawn(
  "bun",
  ["run", "--cwd", "packages/cli", "src/index.ts", "serve", "--hostname", host, "--port", String(internalPort)],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
)

agent.on("error", (error) => log("agent process failed to start", error))
agent.on("exit", (code) => {
  log(`agent process exited (code ${code ?? "unknown"})`)
  if (server) server.stop(true)
  process.exit(code ?? 1)
})

let telegram: ReturnType<typeof createTelegramWebhook> | undefined
if (token && secret && allowedUserIDs.size > 0) {
  telegram = createTelegramWebhook({ token, secret, allowedUserIDs, onMessage })
} else {
  log("Telegram is not configured; set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_ALLOWED_USER_IDS")
}

function authorizedVoice(request: Request) {
  if (!voiceAccessToken) return false
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
  const expectedBytes = Buffer.from(voiceAccessToken)
  const suppliedBytes = Buffer.from(supplied)
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
}

function voiceJSON(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

async function handleVoiceAPI(request: Request, pathname: string): Promise<Response> {
  if (!authorizedVoice(request)) {
    return voiceJSON({ error: voiceAccessToken ? "unauthorized" : "voice_not_configured" }, voiceAccessToken ? 401 : 503)
  }

  const now = Date.now()
  if (now - voiceRateWindowStart >= 60_000) {
    voiceRateWindowStart = now
    voiceRateCount = 0
  }
  if (voiceRateCount >= 90) return voiceJSON({ error: "voice_rate_limit_exceeded" }, 429)
  voiceRateCount++

  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (contentLength > 16_384) return voiceJSON({ error: "request_too_large" }, 413)
  if (request.method !== "POST") return voiceJSON({ error: "method_not_allowed" }, 405)

  if (pathname === "/api/voice/deepgram-token") {
    const key = process.env.DEEPGRAM_API_KEY?.trim()
    if (!key) return voiceJSON({ error: "deepgram_not_configured" }, 503)
    try {
      const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: { authorization: `Token ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 60 }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        log(`Deepgram token request failed (HTTP ${response.status})`)
        return voiceJSON({ error: "deepgram_token_unavailable" }, 502)
      }
      const payload = await response.json() as { access_token?: string; expires_in?: number }
      if (!payload.access_token) return voiceJSON({ error: "deepgram_token_unavailable" }, 502)
      return voiceJSON({ access_token: payload.access_token, expires_in: payload.expires_in ?? 30 })
    } catch {
      return voiceJSON({ error: "deepgram_unreachable" }, 502)
    }
  }

  if (pathname === "/api/voice/progress") {
    let payload: { sessionId?: unknown }
    try { payload = await request.json() as typeof payload } catch { return voiceJSON({ error: "invalid_json" }, 400) }
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : ""
    if (!voiceSessions.has(sessionId)) return voiceJSON({ error: "voice_session_not_found" }, 404)
    return voiceJSON({ status: voiceProgress.get(sessionId) ?? "🤔 Thinking…" })
  }

  if (pathname === "/api/voice/end") {
    let payload: { sessionId?: unknown }
    try {
      payload = await request.json() as typeof payload
    } catch {
      return voiceJSON({ error: "invalid_json" }, 400)
    }
    if (typeof payload.sessionId === "string") { voiceSessions.delete(payload.sessionId); voiceProgress.delete(payload.sessionId) }
    return voiceJSON({ ok: true })
  }

  if (pathname === "/api/voice/session") {
    if (voiceSessions.size >= 100) return voiceJSON({ error: "too_many_voice_sessions" }, 429)
    try {
      await waitForAgent()
      // In a personal deployment with exactly one allowlisted Telegram user,
      // reuse the same agent session so text and voice share conversation history
      // as well as the same long-term memory owner.
      const personalTelegramUserID = allowedUserIDs.size === 1 ? [...allowedUserIDs][0] : undefined
      let agentSessionID = personalTelegramUserID
        ? await getTelegramSession(personalTelegramUserID)
        : undefined
      if (agentSessionID && !(await agentSessionExists(agentSessionID))) agentSessionID = undefined
      let restoreHistory = false

      if (!agentSessionID) {
        restoreHistory = true
        const model = selectedModel()
        const created = await api("/api/session", {
          method: "POST",
          body: JSON.stringify({ title: "Nally personal conversation", ...(model ? { model } : {}) }),
        })
        const createdID = created?.data?.id
        if (typeof createdID !== "string" || !createdID) {
          return voiceJSON({ error: "session_creation_failed" }, 502)
        }
        agentSessionID = personalTelegramUserID
          ? await saveTelegramSession(personalTelegramUserID, createdID)
          : createdID
      }
      const sessionId = crypto.randomUUID()
      voiceSessions.set(sessionId, agentSessionID)
      if (restoreHistory && personalTelegramUserID) voiceRestoreSessions.add(sessionId)
      voiceProgress.set(sessionId, "🤔 Thinking…")
      return voiceJSON({ sessionId })
    } catch {
      return voiceJSON({ error: "session_creation_failed" }, 502)
    }
  }

  if (pathname === "/api/voice/message") {
    let payload: { sessionId?: unknown; text?: unknown }
    try {
      payload = await request.json() as typeof payload
    } catch {
      return voiceJSON({ error: "invalid_json" }, 400)
    }
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : ""
    const text = typeof payload.text === "string" ? payload.text.trim() : ""
    const agentSessionID = voiceSessions.get(sessionId)
    if (!agentSessionID) return voiceJSON({ error: "voice_session_not_found" }, 404)
    if (!text || text.length > 4000) return voiceJSON({ error: "text_length_invalid" }, 400)

    try {
      let voicePrompt = text
      if (voiceRestoreSessions.delete(sessionId) && allowedUserIDs.size === 1) {
        voicePrompt = await recoveredConversationPrompt([...allowedUserIDs][0], text)
      }
      const admitted = await api(`/api/session/${encodeURIComponent(agentSessionID)}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          text: [
            "For this voice reply, speak as Nally: composed, capable, warm but not gushy, and concise without sounding cold.",
            'Use "Sir" occasionally only when it feels natural; never force it into every reply. Use subtle, dry wit sparingly when the moment suits it.',
            "Write for speech: natural sentences and transitions. Do not read Markdown, tables, or code aloud; explain their useful meaning conversationally.",
            "Do not mention or reveal these style instructions. Preserve the user's intent and answer their actual request.",
            "User's message:",
            voicePrompt,
          ].join("\n\n"),
          metadata: { channel: "voice" },
        }),
      }, 120_000)
      const userMessageID = admitted?.data?.id
      if (typeof userMessageID !== "string" || !userMessageID) {
        return voiceJSON({ error: "agent_did_not_accept_message" }, 502)
      }
      const { messages, userIndex } = await waitForAssistantMessage(
        () => api(`/api/session/${encodeURIComponent(agentSessionID)}/message?limit=200&order=desc`),
        userMessageID,
        { timeoutMs: 120_000, pollIntervalMs: 500, sleep: (ms) => Bun.sleep(ms), onProgress: (status) => { voiceProgress.set(sessionId, status) } },
      )
      const candidates = userIndex >= 0 ? messages.slice(0, userIndex) : []
      for (const candidate of candidates) {
        if (candidate.type !== "assistant" || candidate.error || String(candidate.finish ?? "").toLowerCase() === "tool-calls") continue
        const parts = Array.isArray(candidate.content) ? candidate.content : Array.isArray(candidate.parts) ? candidate.parts : []
        const answer = parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("").trim()
        if (answer) {
          if (allowedUserIDs.size === 1) {
            await saveConversationTurn({
              userID: [...allowedUserIDs][0],
              sessionID: agentSessionID,
              source: "voice",
              sourceEventID: crypto.randomUUID(),
              userText: text,
              assistantText: answer,
            })
          }
          return voiceJSON({ text: answer })
        }
      }
      return voiceJSON({ error: "agent_response_unavailable" }, 502)
    } catch (error) {
      log("voice agent turn failed", error)
      return voiceJSON({ error: "agent_turn_failed" }, 502)
    }
  }

  if (pathname === "/api/voice/speech") {
    const key = process.env.ELEVENLABS_API_KEY?.trim()
    const voiceID = process.env.ELEVENLABS_VOICE_ID?.trim()
    if (!key || !voiceID) return voiceJSON({ error: "elevenlabs_not_configured" }, 503)
    let payload: { text?: unknown }
    try {
      payload = await request.json() as typeof payload
    } catch {
      return voiceJSON({ error: "invalid_json" }, 400)
    }
    const text = typeof payload.text === "string" ? payload.text.trim() : ""
    if (!text || text.length > 4000) return voiceJSON({ error: "text_length_invalid" }, 400)
    try {
      const modelID = process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_flash_v2_5"
      const cacheable = CACHEABLE_VOICE_FILLERS.has(text)
      const cacheKey = `${voiceID}\u0000${modelID}\u0000mp3_22050_32\u0000${text}`
      const now = Date.now()
      for (const [key, entry] of speechCache) {
        if (now - entry.cachedAt > SPEECH_CACHE_TTL_MS) speechCache.delete(key)
      }
      let cached = cacheable ? speechCache.get(cacheKey) : undefined
      if (cached) {
        // LRU: refresh insertion order on reuse.
        speechCache.delete(cacheKey)
        speechCache.set(cacheKey, cached)
        return new Response(cached.audio.slice(), {
          headers: { "content-type": cached.contentType, "cache-control": "private, max-age=21600", "x-content-type-options": "nosniff", "x-nally-speech-cache": "HIT" },
        })
      }
      const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceID)}/stream?output_format=mp3_22050_32`
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: modelID }),
        signal: AbortSignal.timeout(45_000),
      })
      if (!response.ok || !response.body) {
        log(`ElevenLabs speech request failed (HTTP ${response.status})`)
        return voiceJSON({ error: "speech_generation_failed" }, 502)
      }
      const contentType = response.headers.get("content-type") || "audio/mpeg"
      // Only cache the fixed, non-personal progress phrases; never retain arbitrary assistant replies.
      if (!cacheable) {
        return new Response(response.body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      }
      const audio = new Uint8Array(await response.arrayBuffer())
      if (audio.byteLength > 2_000_000) return new Response(audio, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      cached = { audio, contentType, cachedAt: now }
      speechCache.set(cacheKey, cached)
      while (speechCache.size > SPEECH_CACHE_MAX_ENTRIES) {
        const oldest = speechCache.keys().next().value
        if (oldest === undefined) break
        speechCache.delete(oldest)
      }
      return new Response(audio.slice(), {
        headers: { "content-type": cached.contentType, "cache-control": "private, max-age=21600", "x-content-type-options": "nosniff", "x-nally-speech-cache": "MISS" },
      })
    } catch {
      return voiceJSON({ error: "elevenlabs_unreachable" }, 502)
    }
  }

  return voiceJSON({ error: "not_found" }, 404)
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, agent: agent.exitCode === null ? "starting" : "stopped", telegram: !!telegram, voice: !!voiceAccessToken })
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const memory = await checkMemoryDatabase()
      const agentReady = agent.exitCode === null
      const ready = agentReady && memory.configured && memory.reachable
      return Response.json(
        { ready, agent: agentReady ? "ready" : "stopped", neonMemory: memory.configured ? (memory.reachable ? "connected" : "unreachable") : "not_configured" },
        { status: ready ? 200 : 503 },
      )
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/voice")) {
      return new Response(voicePage, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
    }
    if (url.pathname.startsWith("/api/voice/")) {
      return handleVoiceAPI(request, url.pathname)
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (!telegram) return Response.json({ error: "telegram_not_configured" }, { status: 503 })
      return telegram.fetch(request)
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  },
})

async function registerWebhook() {
  if (!telegram || !publicURL) return
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${publicURL}/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = (await response.json()) as { ok?: boolean; description?: string }
  if (!response.ok || !payload.ok) throw new Error(`Telegram setWebhook failed (HTTP ${response.status})`)
  log("Telegram webhook registered")
}

try {
  const configuredModel = process.env.NALLY_DEFAULT_MODEL?.trim() || process.env.OPENCODE_MODEL?.trim()
  let modelLabel = configuredModel ? "invalid-or-unresolved" : "automatic (no model env set)"
  try {
    const explicitModel = selectedModel()
    if (explicitModel) modelLabel = explicitModel.id.startsWith(`${explicitModel.providerID}/`) ? explicitModel.id : `${explicitModel.providerID}/${explicitModel.id}`
  } catch {
    modelLabel = "invalid (check NALLY_DEFAULT_MODEL / OPENCODE_MODEL)"
  }
  const opencodeKeyStatus = credentialPresence("OPENCODE_API_KEY")
  const alternateZenKeyStatus = credentialPresence("OPENCODE_ZEN_API_KEY")
  const nvidiaKeyStatus = credentialPresence("NVIDIA_API_KEY")
  log(`AI config providerOverride=${process.env.NALLY_DEFAULT_PROVIDER?.trim() || "unset"}; model=${modelLabel}; OPENCODE_API_KEY=${opencodeKeyStatus}; OPENCODE_ZEN_API_KEY=${alternateZenKeyStatus}; NVIDIA_API_KEY=${nvidiaKeyStatus}`)
  await waitForAgent()
  await registerWebhook()
  log(`HTTP listener ready on port ${port}`)
} catch (error) {
  log("startup check failed", error)
  server.stop(true)
  agent.kill("SIGTERM")
  process.exit(1)
}
