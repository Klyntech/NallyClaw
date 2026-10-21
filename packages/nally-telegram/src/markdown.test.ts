import { describe, expect, test } from "bun:test"
import { renderTelegramMarkdown, splitTelegramRichMarkdown } from "./markdown"

describe("renderTelegramMarkdown", () => {
  test("renders Markdown headings and emphasis as Telegram HTML", () => {
    const tick = String.fromCharCode(96)
    const rendered = renderTelegramMarkdown("# Overview\n\n**Bold text** and " + tick + "inline" + tick + " code.").join("\n")
    expect(rendered).toContain("<b>Overview</b>")
    expect(rendered).toContain("<b>Bold text</b>")
    expect(rendered).toContain("<code>inline</code>")
    expect(rendered).not.toContain("##")
    expect(rendered).not.toContain("**")
  })

  test("renders compact Markdown tables as aligned grids", () => {
    const rendered = renderTelegramMarkdown("| Name | Status |\n| --- | --- |\n| API | Live |").join("\n")
    expect(rendered).toContain("<pre>")
    expect(rendered).toContain("Name")
    expect(rendered).toContain("Status")
    expect(rendered).toContain("Live")
    expect(rendered).toContain("┌")
  })

  test("turns wide tables into readable labeled rows", () => {
    const rendered = renderTelegramMarkdown(
      "| Service | Region | Plan | Status | URL |\n| --- | --- | --- | --- | --- |\n| NallyClaw | Virginia | Free | Live | https://example.com |",
    ).join("\n")
    expect(rendered).toContain("<b>NallyClaw</b>")
    expect(rendered).toContain("<b>Region:</b> Virginia")
    expect(rendered).not.toContain("<pre>")
  })

  test("escapes raw HTML and code-block content", () => {
    const tick = String.fromCharCode(96)
    const source = "# <script>alert(1)</script>\n\n" + tick.repeat(3) + "html\n<b>not bold</b>\n" + tick.repeat(3)
    const rendered = renderTelegramMarkdown(source).join("\n")
    expect(rendered).toContain("&lt;script&gt;")
    expect(rendered).toContain("&lt;b&gt;not bold&lt;/b&gt;")
    expect(rendered).not.toContain("<script>")
    expect(rendered).not.toContain("<b>not bold</b>")
  })

  test("preserves Markdown for Telegram native Rich Messages", () => {
    const source = "# Status\n\n| Service | State |\n| --- | --- |\n| Nally | Live |\n\n**Bold**"
    const chunks = splitTelegramRichMarkdown(source)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("# Status")
    expect(chunks[0]).toContain("| Service | State |")
    expect(chunks[0]).toContain("**Bold**")
  })

  test("splits rich replies without exceeding the message limit", () => {
    const chunks = splitTelegramRichMarkdown("x".repeat(70_000))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 30_000)).toBe(true)
  })

  test("splits long replies into Telegram-sized messages", () => {
    const rendered = renderTelegramMarkdown("x".repeat(9000))
    expect(rendered.length).toBeGreaterThan(1)
    expect(rendered.every((chunk) => chunk.length <= 3500)).toBe(true)
  })
})
