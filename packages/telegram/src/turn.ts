import { renderPlainText } from "./render.js"
import type { OpenCodeClient, OpenCodeMessage } from "./opencode.js"

export interface TelegramSessionMap {
  /** Return the existing agent session for this Telegram chat, if any. */
  get(chatId: number): Promise<string | undefined>
  /** Persist the chat-to-session mapping before accepting later messages. */
  set(chatId: number, sessionId: string): Promise<void>
}

export type AgentTurnRunnerOptions = {
  client: Pick<OpenCodeClient, "createSession" | "sendPrompt" | "listMessages" | "getMessage">
  sessions: TelegramSessionMap
  pollIntervalMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function timestamp(message: OpenCodeMessage): number {
  const time = message.time
  if (typeof time !== "object" || time === null) return Number.NaN
  const created = (time as Record<string, unknown>).created
  if (typeof created === "number") return created
  if (typeof created === "string") return Date.parse(created)
  return Number.NaN
}

function messageType(message: OpenCodeMessage): string | undefined {
  return typeof message.type === "string" ? message.type : undefined
}

function messageId(message: OpenCodeMessage): string | undefined {
  return typeof message.id === "string" ? message.id : undefined
}

function idleOutcome(message: OpenCodeMessage): string | undefined {
  if (messageType(message) !== "idle") return
  return typeof message.outcome === "string" ? message.outcome : undefined
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Connect Telegram chat turns to the existing agent session API.
 *
 * The supplied TelegramSessionMap must be backed by durable storage in production.
 * This runner waits for the agent's idle marker instead of replying with the admitted
 * user message, and collects only assistant text generated after that prompt.
 */
export function createAgentTurnRunner(options: AgentTurnRunnerOptions) {
  const pollIntervalMs = options.pollIntervalMs ?? 800
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) {
    throw new RangeError("pollIntervalMs must be an integer of at least 50ms")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive")
  }

  async function executeTurn(input: { chatId: number; text: string; updateId?: number }): Promise<string> {
    let sessionId = await options.sessions.get(input.chatId)
    if (!sessionId) {
      const session = await options.client.createSession("Telegram chat")
      sessionId = session.id
      await options.sessions.set(input.chatId, sessionId)
    }

    const promptId = input.updateId === undefined ? undefined : `msg_tg_${input.updateId}`
    const existing = promptId === undefined ? undefined : await options.client.getMessage(sessionId, promptId)
    const admitted = existing ?? await options.client.sendPrompt(sessionId, input.text, promptId)
    const admittedId = messageId(admitted)
    if (!admittedId) throw new Error("Agent did not return an admitted message ID")
    const admittedAt = timestamp(admitted)

    const deadline = now() + timeoutMs
    while (now() < deadline) {
      const messages = await options.client.listMessages(sessionId, 200)
      const admittedIndex = messages.findIndex((message) => messageId(message) === admittedId)

      // Prefer timestamps so long tool-heavy runs still complete if the admitted message
      // has fallen outside the newest page. Fall back to IDs when timestamps are absent.
      const idle = Number.isFinite(admittedAt)
        ? messages.find((message) => {
            const created = timestamp(message)
            return messageType(message) === "idle" && Number.isFinite(created) && created >= admittedAt
          })
        : admittedIndex >= 0
          ? messages.slice(0, admittedIndex).find((message) => messageType(message) === "idle")
          : undefined

      if (idle) {
        const idleAt = timestamp(idle)
        const newer = Number.isFinite(admittedAt) && Number.isFinite(idleAt)
          ? messages.filter((message) => {
              const created = timestamp(message)
              return messageType(message) === "assistant" && Number.isFinite(created) && created >= admittedAt && created <= idleAt
            })
          : admittedIndex >= 0
            ? messages.slice(0, admittedIndex).filter((message) => messageType(message) === "assistant")
            : []

        const outcome = idleOutcome(idle)
        if (outcome !== "succeeded") {
          // Log only bounded operational metadata; never log prompt or agent response text.
          console.error("[nally-telegram] agent turn ended unsuccessfully", {
            updateId: input.updateId,
            outcome: outcome ?? "missing",
          })
          if (outcome === "interrupted") return "The agent run was interrupted."
          return "The agent couldn't complete that request. Please try again."
        }

        const answer = newer.reverse().map(renderPlainText).filter(Boolean).join("\n\n").trim()
        return answer || "The agent finished, but returned no text response."
      }

      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())))
    }

    throw new Error("Timed out waiting for the agent session to finish")
  }

  // Serialize turns for a chat within this process so their idle markers and replies
  // cannot be mixed. Multi-instance deployments still need a database-backed chat lock.
  const queues = new Map<number, Promise<void>>()
  return async function runTurn(input: { chatId: number; text: string; updateId?: number }): Promise<string> {
    const previous = queues.get(input.chatId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    queues.set(input.chatId, tail)
    await previous
    try {
      return await executeTurn(input)
    } finally {
      release()
      if (queues.get(input.chatId) === tail) queues.delete(input.chatId)
    }
  }
}
