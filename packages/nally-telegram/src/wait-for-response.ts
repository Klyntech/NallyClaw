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
}

type MessageList = {
  data?: MessageLike[]
}

export type CompletedAssistantMessages = {
  messages: MessageLike[]
  userIndex: number
}

function humanizeToolName(value: string) {
  const leaf = value.split(/[.:/]/).filter(Boolean).pop() ?? value
  const cleaned = leaf.replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim()
  return cleaned ? cleaned.replace(/\\b\\w/g, (char) => char.toUpperCase()) : "Unknown"
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
  return "🤔 Thinking…"
}

function isToolCallIteration(message: MessageLike | undefined) {
  return String(message?.finish ?? "").toLowerCase() === "tool-calls"
}

function isCompletedAssistantIteration(message: MessageLike | undefined) {
  return !!message && message.type === "assistant" &&
    !!(message.time?.completed || message.error || message.finish)
}

export async function waitForAssistantMessage(
  getMessages: () => Promise<MessageList | undefined>,
  userMessageID: string,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    onProgress?: (status: string) => void | Promise<void>
  } = {},
): Promise<CompletedAssistantMessages> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let lastProgress = ""

  while (true) {
    const result = await getMessages()
    const messages = Array.isArray(result?.data) ? result.data : []
    const userIndex = messages.findIndex((message) => message.id === userMessageID)

    if (userIndex >= 0) {
      // Messages are fetched newest-first. Only inspect assistant messages newer than
      // the exact user message admitted by this Telegram update.
      const candidates = messages.slice(0, userIndex)
      const assistant = candidates.find((message) => message.type === "assistant")
      // An assistant iteration ending with "tool-calls" is not the final answer:
      // the runtime still has to execute the tool and continue the same turn.
      if (isCompletedAssistantIteration(assistant) && !isToolCallIteration(assistant)) {
        return { messages, userIndex }
      }

      const progress = activeToolProgress(assistant)
      if (progress !== lastProgress) {
        lastProgress = progress
        await options.onProgress?.(progress)
      }
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new Error("Timed out waiting for a completed assistant message")
    }
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}
