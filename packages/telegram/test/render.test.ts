import { describe, expect, test } from "bun:test"
import { chunkTelegramText, renderPlainText } from "../src/render.js"

describe("renderPlainText", () => {
  test("supports strings and common text-part arrays", () => {
    expect(renderPlainText("  hello  ")).toBe("hello")
    expect(renderPlainText({ parts: [{ type: "text", text: "hello" }, { type: "tool", name: "read" }, { type: "text", text: " world" }] })).toBe("hello world")
    expect(renderPlainText({ content: [{ type: "text", text: "answer" }] })).toBe("answer")
  })

  test("does not interpret arbitrary markup", () => {
    expect(renderPlainText({ text: "<b>not trusted html</b>" })).toBe("<b>not trusted html</b>")
    expect(renderPlainText({ parts: [{ type: "image", url: "https://example.com/image.png" }] })).toBe("")
  })
})

describe("chunkTelegramText", () => {
  test("returns no chunks for blank messages", () => {
    expect(chunkTelegramText("  ")).toEqual([])
  })

  test("keeps chunks within the requested Unicode code-point limit", () => {
    const chunks = chunkTelegramText("🙂".repeat(25), 7)
    expect(chunks.length).toBe(4)
    expect(chunks.every((chunk) => Array.from(chunk).length <= 7)).toBe(true)
    expect(chunks.join("")).toBe("🙂".repeat(25))
  })

  test("prefers line boundaries and validates the limit", () => {
    expect(chunkTelegramText("first line\nsecond line", 12)).toEqual(["first line", "second line"])
    expect(() => chunkTelegramText("hello", 0)).toThrow(RangeError)
  })
})
