import { renderPlainText } from "./render.js"
import type { OpenCodeClient, OpenCodeMessage } from "./opencode.js"

export interface TelegramSessionMap {
  /** Return the existing agent session for this Telegram chat, if any. */
  get(chatId: number): Promise<string | undefined>
  /** Persist the chat-to-session mapping before accepting later messages. */
  set(chatId: number, sessionId: string): Promise<void>
}

export type AgentTurnRunnerOptions = {
  client: Pick<OpenCodeClient, "createSession" | "sendPrompt" | "listMessages">
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

  return async function runTurn(input: { chatId: number; text: string }): Promise<string> {
    let sessionId = await options.sessions.get(input.chatId)
    if (!sessionId) {
      const session = await options.client.createSession("Telegram chat")
      sessionId = session.id
      await options.sessions.set(input.chatId, sessionId)
    }

    const admitted = await options.client.sendPrompt(sessionId, input.text)
    const admittedId = messageId(admitted)
    if (!admittedId) throw new Error("Agent did not return an admitted message ID")

    const deadline = now() + timeoutMs
    while (now() < deadline) {
      const messages = await options.client.listMessages(sessionId, 100)
      const admittedIndex = messages.findIndex((message) => messageId(message) === admittedId)

      // The API defaults to newest-first. Wait until this prompt has an idle marker
      // newer than the admitted message before assembling the response.
      if (admittedIndex >= 0) {
        const newer = messages.slice(0, admittedIndex)
        const idle = newer.find((message) => messageType(message) === "idle")
        if (idle) {
          const outcome = idleOutcome(idle)
          if (outcome !== "succeeded") {
            if (outcome === "interrupted") return "The agent run was interrupted."
            return "The agent couldn't complete that request. Please try again."
          }

          const answer = newer
            .filter((message) => messageType(message) === "assistant")
            .reverse()
            .map(renderPlainText)
            .filter(Boolean)
            .join("\n\n")
            .trim()

          return answer || "The agent finished, but returned no text response."
        }
      }

      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())))
    }

    throw new Error("Timed out waiting for the agent session to finish")
  }
}
