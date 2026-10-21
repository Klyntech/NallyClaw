import { spawn } from "node:child_process"
import { createTelegramWebhook, type TelegramTextMessage } from "./webhook"

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

function selectedModel() {
  // OPENCODE_MODEL accepts either "big-pickle" or an explicit "provider/model" reference.
  const configured = process.env.NALLY_DEFAULT_MODEL?.trim() || process.env.OPENCODE_MODEL?.trim()
  if (!configured) return undefined
  const slash = configured.indexOf("/")
  const providerID = slash > 0
    ? configured.slice(0, slash)
    : (process.env.NALLY_DEFAULT_PROVIDER?.trim() || "opencode")
  const id = slash > 0 ? configured.slice(slash + 1) : configured
  if (!providerID || !id) throw new Error("Invalid NALLY_DEFAULT_MODEL / OPENCODE_MODEL")
  return { providerID, id }
}

async function onMessage(message: TelegramTextMessage): Promise<string> {
  let stage = "waiting for agent readiness"
  const startedAt = Date.now()
  try {
    // Telegram may deliver queued updates while this process is booting.
    await waitForAgent()

    let sessionID = sessions.get(message.userID)
    if (!sessionID) {
      stage = "creating session"
      const model = selectedModel()
      const created = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({
          title: `Telegram chat ${message.userID}`,
          ...(model ? { model } : {}),
        }),
      })
      sessionID = created.data?.id
      if (typeof sessionID !== "string" || !sessionID) throw new Error("agent did not create a session")
      sessions.set(message.userID, sessionID)
    }

    stage = "submitting prompt"
    const admitted = await api(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: message.text, metadata: { channel: "telegram", updateID: message.updateID } }),
    })
    const userMessageID = admitted.data?.id
    if (typeof userMessageID !== "string" || !userMessageID) throw new Error("agent did not accept the message")

    stage = "waiting for model completion"
    await api(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, { method: "POST" }, 120_000)

    stage = "reading assistant response"
    const result = await api(`/api/session/${encodeURIComponent(sessionID)}/message?limit=200&order=desc`)
    const messages = Array.isArray(result.data) ? result.data : []
    const userIndex = messages.findIndex((item: any) => item.id === userMessageID)
    const candidates = userIndex >= 0 ? messages.slice(0, userIndex) : []
    for (const candidate of candidates) {
      if (candidate.type !== "assistant" || candidate.error) continue
      const text = Array.isArray(candidate.content)
        ? candidate.content
            .filter((part: any) => part?.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text)
            .join("")
            .trim()
        : ""
      if (text) {
        log(`message completed in ${Date.now() - startedAt}ms`)
        return text
      }
    }

    const newestTypes = messages.slice(0, 8).map((item: any) => item?.type ?? "unknown").join(",")
    log(`completed turn has no assistant text (user message found: ${userIndex >= 0}; newest types: ${newestTypes || "none"})`)
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

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, agent: agent.exitCode === null ? "starting" : "stopped", telegram: !!telegram })
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
  await waitForAgent()
  await registerWebhook()
  log(`HTTP listener ready on port ${port}`)
} catch (error) {
  log("startup check failed", error)
  server.stop(true)
  agent.kill("SIGTERM")
  process.exit(1)
}
