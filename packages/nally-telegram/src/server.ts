import { spawn } from "node:child_process"
import { createTelegramWebhook, type TelegramTextMessage } from "./webhook"
import { selectedModel } from "./model-config"
import { waitForAssistantMessage } from "./wait-for-response"

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
      { timeoutMs: 120_000, pollIntervalMs: 500, sleep: (ms) => Bun.sleep(ms) },
    )

    stage = "reading assistant response"
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
      if (text && !candidate.error) {
        log(`message completed in ${Date.now() - startedAt}ms`)
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
  const configuredModel = process.env.NALLY_DEFAULT_MODEL?.trim() || process.env.OPENCODE_MODEL?.trim()
  let modelLabel = configuredModel ? "invalid-or-unresolved" : "automatic (no model env set)"
  try {
    const explicitModel = selectedModel()
    if (explicitModel) modelLabel = `${explicitModel.providerID}/${explicitModel.id}`
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
