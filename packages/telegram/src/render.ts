const DEFAULT_CHUNK_LIMIT = 3900

/** Escape plain text for Telegram's HTML parse mode. Escape ampersands first. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
}

/**
 * Render untrusted model text as escaped Telegram HTML and split it into
 * bounded chunks. This first scaffold deliberately emits no model-authored
 * markup; Markdown conversion and tag-aware rich rendering come later.
 */
export function renderPlainText(text: string, maxLength = DEFAULT_CHUNK_LIMIT): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer")
  }

  const normalized = normalizeText(text)
  if (!normalized) return [""]

  // Tokenize HTML entities as indivisible units so chunk boundaries never
  // produce malformed entities such as "&am" + "p;".
  const tokens = escapeHtml(normalized).match(/&(?:amp|lt|gt);|[\s\S]/g) ?? []
  const chunks: string[] = []
  let current = ""

  for (const token of tokens) {
    if (current.length + token.length > maxLength && current.length > 0) {
      chunks.push(current)
      current = ""
    }
    // An entity is at most five characters, so it cannot exceed the normal
    // 3900-character budget. For tiny test budgets, keep the entity intact.
    current += token
  }

  if (current) chunks.push(current)
  return chunks
}
