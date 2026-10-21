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
}

type MessageList = {
  data?: MessageLike[]
}

export type CompletedAssistantMessages = {
  messages: MessageLike[]
  userIndex: number
}

export async function waitForAssistantMessage(
  getMessages: () => Promise<MessageList | undefined>,
  userMessageID: string,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<CompletedAssistantMessages> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs

  while (true) {
    const result = await getMessages()
    const messages = Array.isArray(result?.data) ? result.data : []
    const userIndex = messages.findIndex((message) => message.id === userMessageID)

    if (userIndex >= 0) {
      // Messages are fetched newest-first. Only inspect assistant messages newer than
      // the exact user message admitted by this Telegram update.
      const candidates = messages.slice(0, userIndex)
      const assistant = candidates.find((message) => message.type === "assistant")
      if (assistant && (assistant.time?.completed || assistant.error || assistant.finish)) {
        return { messages, userIndex }
      }
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new Error("Timed out waiting for a completed assistant message")
    }
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}
