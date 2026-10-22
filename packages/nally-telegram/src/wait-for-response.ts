type MessageLike = {
  id?: string
  type?: string
  error?: any
  finish?: unknown
  time?: { completed?: unknown }
  content?: any[]
  model?: { providerID?: string; id?: string }
  providerID?: string
  modelID?: string
  parts?: any[]
  outcome?: "succeeded" | "failed" | "interrupted"
}

type MessageList = {
  data?: MessageLike[]
}

export type CompletedAssistantMessages = {
  messages: MessageLike[]
  userIndex: number
  terminalOutcome?: "succeeded" | "failed" | "interrupted"
}

/** Default wall-clock wait for a final assistant message (Telegram text). */
export const DEFAULT_ASSISTANT_TIMEOUT_MS = 90_000
/** Shorter wait for live voice calls — fail before the user stares at silence. */
export const VOICE_ASSISTANT_TIMEOUT_MS = 60_000
/** Allow slow model/tool turns to progress without failing on a generic status label. */
export const DEFAULT_STAGNATION_MS = 90_000

function humanizeToolName(value: string) {
  const leaf = value.split(/[.:/]/).filter(Boolean).pop() ?? value
  const cleaned = leaf.replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim()
  return cleaned ? cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) : "Unknown"
}

export function describeToolProgress(toolName: string): string {
  const name = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_")
  if (/(webfetch|^fetch$|fetch_page|fetch_url|fetchpage|open_url|scrape_page|read_url)/.test(name)) return "🌐 Fetching page…"
  if (/(websearch|search_web|web_search|search_the_web|tavily|exa_search|parallel_search)/.test(name)) return "🔎 Searching the web…"
  if (/(read_page|reading_page|browser_read|open_page|page_content|browse_page|webopen|^open$)/.test(name)) return "📖 Reading page…"
  if (/(read_file|file_read|fetch_file|open_file|^read$|^cat$|view_file|cat_file)/.test(name)) return "📄 Reading file…"
  if (/(grep|glob|search_file|search_code|find_file|list_files|list_directory|codesearch)/.test(name)) return "🔎 Searching files…"
  if (/(edit|patch|replace_file|apply_patch|update_file)/.test(name)) return "✏️ Editing file…"
  if (/(write_file|create_file|file_write|^write$)/.test(name)) return "📝 Writing file…"
  if (/(bash|shell|terminal|execute|run_command|command_run)/.test(name)) return "⌨️ Running command…"
  if (/(memory_search|memory_recall|knowledge_search)/.test(name)) return "🧠 Searching memory…"
  if (/(memory_remember|memory_update|knowledge_add)/.test(name)) return "🧠 Saving memory…"
  if (/(task|subagent|delegate)/.test(name)) return "🤝 Working with a subagent…"
  return "🛠 Using " + humanizeToolName(toolName) + " tool…"
}

function activeToolProgress(message: MessageLike | undefined): string {
  if (!message) return "🤔 Thinking…"
  const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : []
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part?.type !== "tool") continue
    const status = String(part.state?.status ?? "").toLowerCase()
    if (status && !["running", "pending", "input-streaming", "input-available"].includes(status)) continue
    const name = String(part.tool ?? part.name ?? part.state?.title ?? "")
    if (name) return describeToolProgress(name)
  }
  if (parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0)) {
    return "✍️ Drafting response…"
  }
  return "🤔 Thinking…"
}

// Detect underlying message changes even when the human-readable label remains
// the same (for example, streamed text growing while the label is "Thinking…").
// Only metadata and text lengths are used; message text is never logged.
function assistantProgressFingerprint(message: MessageLike | undefined): string {
  if (!message) return "no-assistant"
  const parts = Array.isArray(message.content) ? message.content : Array.isArray(message.parts) ? message.parts : []
  return JSON.stringify({
    id: message.id ?? "",
    finish: message.finish ?? "",
    completed: message.time?.completed ?? "",
    error: message.error ? String(message.error.name ?? message.error.type ?? "present") : "",
    parts: parts.map((part) => ({
      type: part?.type ?? "",
      tool: part?.tool ?? part?.name ?? "",
      status: part?.state?.status ?? "",
      title: part?.state?.title ?? "",
      textLength: typeof part?.text === "string" ? part.text.length : 0,
    })),
  })
}

function isToolCallIteration(message: MessageLike | undefined) {
  return String(message?.finish ?? "").toLowerCase() === "tool-calls"
}

function isCompletedAssistantIteration(message: MessageLike | undefined) {
  return !!message && message.type === "assistant" &&
    !!(message.time?.completed || message.error || message.finish)
}

export class AssistantWaitTimeoutError extends Error {
  readonly lastProgress: string
  readonly elapsedMs: number
  readonly reason: "deadline" | "stagnation"

  constructor(opts: { lastProgress: string; elapsedMs: number; reason: "deadline" | "stagnation" }) {
    const hint = opts.lastProgress ? ` (last status: ${opts.lastProgress})` : ""
    super(
      opts.reason === "stagnation"
        ? `Timed out waiting for a completed assistant message: no progress for too long${hint}`
        : `Timed out waiting for a completed assistant message${hint}`,
    )
    this.name = "AssistantWaitTimeoutError"
    this.lastProgress = opts.lastProgress
    this.elapsedMs = opts.elapsedMs
    this.reason = opts.reason
  }
}

export class AssistantPollingError extends Error {
  readonly consecutiveFailures: number
  readonly elapsedMs: number

  constructor(opts: { consecutiveFailures: number; elapsedMs: number; lastError: unknown }) {
    const detail = opts.lastError instanceof Error ? opts.lastError.message : String(opts.lastError)
    super(`Unable to read assistant progress after ${opts.consecutiveFailures} consecutive polling failures: ${detail.slice(0, 180)}`)
    this.name = "AssistantPollingError"
    this.consecutiveFailures = opts.consecutiveFailures
    this.elapsedMs = opts.elapsedMs
  }
}

export async function waitForAssistantMessage(
  getMessages: () => Promise<MessageList | undefined>,
  userMessageID: string,
  options: {
    timeoutMs?: number
    stagnationMs?: number
    pollIntervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    onProgress?: (status: string) => void | Promise<void>
    onPollError?: (error: unknown, consecutiveFailures: number) => void | Promise<void>
    maxConsecutivePollErrors?: number
  } = {},
): Promise<CompletedAssistantMessages> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASSISTANT_TIMEOUT_MS
  const stagnationMs = options.stagnationMs ?? DEFAULT_STAGNATION_MS
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let lastProgress = ""
  let lastProgressAt = startedAt
  let lastFingerprint = ""
  let consecutivePollErrors = 0
  const maxConsecutivePollErrors = options.maxConsecutivePollErrors ?? 5

  while (true) {
    const beforePoll = deadline - now()
    if (beforePoll <= 0) {
      throw new AssistantWaitTimeoutError({
        lastProgress,
        elapsedMs: now() - startedAt,
        reason: "deadline",
      })
    }

    let result: MessageList | undefined
    try {
      result = await getMessages()
      consecutivePollErrors = 0
    } catch (error) {
      consecutivePollErrors++
      await options.onPollError?.(error, consecutivePollErrors)
      if (consecutivePollErrors >= maxConsecutivePollErrors) {
        throw new AssistantPollingError({
          consecutiveFailures: consecutivePollErrors,
          elapsedMs: now() - startedAt,
          lastError: error,
        })
      }
      const remainingAfterError = deadline - now()
      if (remainingAfterError <= 0) {
        throw new AssistantWaitTimeoutError({
          lastProgress,
          elapsedMs: now() - startedAt,
          reason: "deadline",
        })
      }
      await sleep(Math.min(pollIntervalMs, remainingAfterError))
      continue
    }

    const messages = Array.isArray(result?.data) ? result.data : []
    const userIndex = messages.findIndex((message) => message.id === userMessageID)

    if (userIndex >= 0) {
      // Messages are fetched newest-first. Only inspect terminal states and assistant
      // iterations newer than the exact user message admitted by this Telegram update.
      const candidates = messages.slice(0, userIndex)
      const terminal = candidates.find(
        (message) => message.type === "idle" &&
          (message.outcome === "succeeded" || message.outcome === "failed" || message.outcome === "interrupted"),
      )
      if (terminal?.outcome) {
        return { messages, userIndex, terminalOutcome: terminal.outcome }
      }
      const assistant = candidates.find((message) => message.type === "assistant")
      // An assistant iteration ending with "tool-calls" is not the final answer:
      // the runtime still has to execute the tool and continue the same turn.
      if (isCompletedAssistantIteration(assistant) && !isToolCallIteration(assistant)) {
        return { messages, userIndex }
      }

      const progress = activeToolProgress(assistant)
      const fingerprint = assistantProgressFingerprint(assistant)
      const currentTime = now()
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint
        lastProgressAt = currentTime
      }
      if (progress !== lastProgress) {
        lastProgress = progress
        await options.onProgress?.(progress)
      }
      if (currentTime - lastProgressAt >= stagnationMs) {
        throw new AssistantWaitTimeoutError({
          lastProgress,
          elapsedMs: now() - startedAt,
          reason: "stagnation",
        })
      }
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new AssistantWaitTimeoutError({
        lastProgress,
        elapsedMs: now() - startedAt,
        reason: "deadline",
      })
    }
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}
