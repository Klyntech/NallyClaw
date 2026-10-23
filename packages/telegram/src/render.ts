/**
 * Telegram text messages are limited to 4096 characters. Keep a little headroom so
 * future formatting/entity support does not push messages over the API limit.
 */
export const TELEGRAM_MESSAGE_LIMIT = 3900

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textFromPart(value: unknown): string {
  if (typeof value === "string") return value
  if (!isRecord(value)) return ""
  if (value.type === "text" && typeof value.text === "string") return value.text
  // Do not forward reasoning, tool calls, or other non-text content to Telegram.
  if (typeof value.type === "string") return ""
  if (typeof value.text === "string") return value.text
  return ""
}

/** Convert projected OpenCode messages to plain text, excluding reasoning and tool content. */
export function renderPlainText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (!isRecord(value)) return ""

  if (value.type === "reasoning" || value.type === "tool") return ""
  const direct = typeof value.text === "string" ? value.text : undefined
  if (direct !== undefined) return direct.trim()

  const content = Array.isArray(value.content) ? value.content : undefined
  const parts = Array.isArray(value.parts) ? value.parts : content
  if (!parts) return ""

  return parts.map(textFromPart).filter(Boolean).join("").trim()
}

/** Split by Unicode code point, preferring a newline or whitespace boundary when available. */
export function chunkTelegramText(input: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer")
  const remaining = input.trim()
  if (!remaining) return []

  const chars = Array.from(remaining)
  const chunks: string[] = []
  let offset = 0

  while (offset < chars.length) {
    const end = Math.min(offset + limit, chars.length)
    let boundary = end

    if (end < chars.length) {
      const minBoundary = offset + Math.floor(limit * 0.65)
      for (let i = end - 1; i >= minBoundary; i--) {
        if (chars[i] === "\n") {
          boundary = i + 1
          break
        }
      }
      if (boundary === end) {
        for (let i = end - 1; i >= minBoundary; i--) {
          if (/\s/u.test(chars[i])) {
            boundary = i
            break
          }
        }
      }
    }

    const chunk = chars.slice(offset, boundary).join("").trim()
    if (chunk) chunks.push(chunk)
    offset = boundary
    while (offset < chars.length && /\s/u.test(chars[offset])) offset++
  }

  return chunks
}
