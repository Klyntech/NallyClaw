const MAX_HTML_CHARS = 3500
const TICK = String.fromCharCode(96)
const TOKEN_START = "\uE000"
const TOKEN_END = "\uE001"

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function reserve(tokens: string[], html: string) {
  const index = tokens.push(html) - 1
  return TOKEN_START + index + TOKEN_END
}

function inlineMarkdown(source: string): string {
  const tokens: string[] = []
  let value = source
  const codePattern = new RegExp(TICK + "([^" + TICK + "\\n]+)" + TICK, "g")
  value = value.replace(codePattern, (_match, code: string) => reserve(tokens, "<code>" + escapeHtml(code) + "</code>"))
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label: string, rawURL: string) => {
    try {
      const url = new URL(rawURL)
      if (url.protocol !== "https:" && url.protocol !== "http:") return label
      return reserve(tokens, '<a href="' + escapeHtml(url.toString()) + '">' + inlineMarkdown(label) + "</a>")
    } catch {
      return match
    }
  })

  value = escapeHtml(value)
  value = value.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  value = value.replace(/__(.+?)__/g, "<b>$1</b>")
  value = value.replace(/~~(.+?)~~/g, "<s>$1</s>")
  value = value.replace(/(^|[^\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
  value = value.replace(/(^|[^\w])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>")

  return value.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => tokens[Number(index)] ?? "")
}

function splitLongText(value: string, limit: number): string[] {
  const output: string[] = []
  let remaining = value
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf(" ", limit)
    if (end < Math.floor(limit * 0.6)) end = limit
    output.push(remaining.slice(0, end))
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) output.push(remaining)
  return output
}

function displayWidth(value: string) {
  return Array.from(value).length
}

function fitCell(value: string, width: number) {
  const chars = Array.from(value.replace(/\s+/g, " ").trim())
  if (chars.length > width) return chars.slice(0, Math.max(1, width - 1)).join("") + "…"
  return chars.join("") + " ".repeat(Math.max(0, width - chars.length))
}

function splitTableLine(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

function isTableSeparator(line: string) {
  const cells = splitTableLine(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
}

function renderTableBlocks(tableRows: string[][]): string[] {
  if (tableRows.length === 0) return []
  const count = Math.max(...tableRows.map((row) => row.length))
  const rows = tableRows.map((row) => Array.from({ length: count }, (_, index) => row[index] ?? ""))
  const headers = rows[0] ?? []
  const body = rows.slice(1)
  const widths = headers.map((_header, col) => {
    const widest = Math.max(3, ...rows.map((row) => displayWidth(row[col] ?? "")))
    return Math.min(18, widest)
  })
  const totalWidth = widths.reduce((sum, width) => sum + width + 2, 0) + count + 1

  if (count > 4 || totalWidth > 62) {
    if (body.length === 0) return ["<b>" + headers.map((header) => inlineMarkdown(header)).join(" · ") + "</b>"]
    return body.map((row, rowIndex) => {
      const title = (row[0] || "Row " + (rowIndex + 1)).trim()
      const details = headers.slice(1).map((header, index) => {
        const value = row[index + 1]?.trim()
        return value ? "<b>" + inlineMarkdown(header) + ":</b> " + inlineMarkdown(value) : ""
      }).filter(Boolean)
      return "<b>" + inlineMarkdown(title) + "</b>" + (details.length ? "\n" + details.join("\n") : "")
    })
  }

  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right
  const rowLine = (row: string[]) =>
    "│" + widths.map((width, index) => " " + fitCell(row[index] ?? "", width) + " ").join("│") + "│"
  const top = border("┌", "┬", "┐")
  const separator = border("├", "┼", "┤")
  const bottom = border("└", "┴", "┘")
  const headerLine = rowLine(headers)

  const blocks: string[] = []
  let lines = [top, headerLine, separator]
  for (const row of body) {
    const line = rowLine(row)
    if (lines.length > 3 && lines.join("\n").length + line.length + bottom.length > 3000) {
      lines.push(bottom)
      blocks.push("<pre>" + escapeHtml(lines.join("\n")) + "</pre>")
      lines = [top, headerLine, separator]
    }
    lines.push(line)
  }
  lines.push(bottom)
  blocks.push("<pre>" + escapeHtml(lines.join("\n")) + "</pre>")
  return blocks
}

function packBlocks(blocks: string[]): string[] {
  const output: string[] = []
  let current = ""
  for (const block of blocks) {
    if (!block.trim()) continue
    if (block.length > MAX_HTML_CHARS) {
      if (current) output.push(current)
      current = ""
      output.push(block)
      continue
    }
    const candidate = current ? current + "\n\n" + block : block
    if (candidate.length > MAX_HTML_CHARS && current) {
      output.push(current)
      current = block
    } else {
      current = candidate
    }
  }
  if (current) output.push(current)
  return output
}

/**
 * Convert common assistant Markdown into Telegram-supported HTML.
 * Telegram has no native table element, so compact tables use aligned preformatted grids;
 * wide tables become labeled rows that remain readable on a phone.
 */
export function renderTelegramMarkdown(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: string[] = []
  let paragraph: string[] = []
  let index = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    let current = ""
    for (const line of paragraph) {
      for (const piece of splitLongText(line, 2200)) {
        const html = inlineMarkdown(piece)
        const candidate = current ? current + "\n" + html : html
        if (candidate.length > MAX_HTML_CHARS && current) {
          blocks.push(current)
          current = html
        } else {
          current = candidate
        }
      }
    }
    if (current) blocks.push(current)
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index] ?? ""
    const trimmedLine = line.trimStart()
    const tickFence = TICK.repeat(3)
    const isFence = trimmedLine.startsWith(tickFence) || trimmedLine.startsWith("~~~")
    const marker = trimmedLine.startsWith(tickFence) ? tickFence : "~~~"
    if (isFence) {
      flushParagraph()
      const code: string[] = []
      index++
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(marker)) {
        code.push(lines[index] ?? "")
        index++
      }
      const rawCode = code.join("\n")
      const codeChunks = splitLongText(rawCode, 2800)
      for (const chunk of codeChunks) blocks.push("<pre><code>" + escapeHtml(chunk) + "</code></pre>")
      if (rawCode.length === 0) blocks.push("<pre><code></code></pre>")
      index++
      continue
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      flushParagraph()
      const tableRows = [splitTableLine(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        tableRows.push(splitTableLine(lines[index] ?? ""))
        index++
      }
      blocks.push(...renderTableBlocks(tableRows))
      continue
    }

    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/)
    if (heading) {
      flushParagraph()
      blocks.push("<b>" + inlineMarkdown(heading[2] ?? "") + "</b>")
      index++
      continue
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      blocks.push("<i>────────</i>")
      index++
      continue
    }

    if (/^\s*>/.test(line)) {
      flushParagraph()
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quote.push(inlineMarkdown((lines[index] ?? "").replace(/^\s*>\s?/, "")))
        index++
      }
      blocks.push("<blockquote>" + quote.join("\n") + "</blockquote>")
      continue
    }

    const list = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (list) {
      flushParagraph()
      const items: string[] = []
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
        if (!item) break
        const original = lines[index] ?? ""
        const ordered = original.match(/^\s*(\d+)[.)]\s+/)
        items.push((ordered ? ordered[1] + "." : "•") + " " + inlineMarkdown(item[1] ?? ""))
        index++
      }
      blocks.push(...items)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      index++
      continue
    }

    paragraph.push(line)
    index++
  }

  flushParagraph()
  return packBlocks(blocks)
}
