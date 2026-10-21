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

async function api(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, internalURL), {
    ...init,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`agent API returned HTTP ${response.status}`)
  return response.json() as Promise<any>
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

async function onMessage(message: TelegramTextMessage): Promise<string> {
  let sessionID = sessions.get(message.userID)
  if (!sessionID) {
    const created = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: `Telegram chat ${message.userID}` }),
    })
    sessionID = created.data?.id
    if (typeof sessionID !== "string" || !sessionID) throw new Error("agent did not create a session")
    sessions.set(message.userID, sessionID)
  }

  const admitted = await api(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: message.text, metadata: { channel: "telegram", updateID: message.updateID } }),
  })
  const userMessageID = admitted.data?.id
  if (typeof userMessageID !== "string" || !userMessageID) throw new Error("agent did not accept the message")

  const deadline = Date.now() + 110_000
  while (Date.now() < deadline) {
    const active = await api("/api/session/active")
    if (!active.data?.[sessionID]) {
      const result = await api(`/api/session/${encodeURIComponent(sessionID)}/message?limit=50&order=desc`)
      const messages = Array.isArray(result.data) ? result.data : []
      const userIndex = messages.findIndex((item: any) => item.id === userMessageID)
      const answer = messages
        .slice(0, userIndex < 0 ? messages.length : userIndex)
        .find((item: any) => item.type === "assistant" && !item.error)
      const text = answer?.content
        ?.filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("")
        .trim()
      if (text) return text
      // If the run has completed without a text answer, do not leak internal state.
      throw new Error("agent completed without a text response")
    }
    await Bun.sleep(1_000)
  }
  return "That request is taking longer than expected. Please send another message in a moment."
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
