import { expect, test } from "bun:test"
import { escapeHtml, renderPlainText } from "../src/render"

test("escapes untrusted text and preserves ordinary characters", () => {
  expect(escapeHtml("& <hello> >")).toBe("&amp; &lt;hello&gt; &gt;")
  expect(renderPlainText("Hello <b>world</b>")).toEqual(["Hello &lt;b&gt;world&lt;/b&gt;"])
})

test("normalizes line endings and removes zero-width and control characters", () => {
  expect(renderPlainText("a\r\nb\u200Bc\u0007")).toEqual(["a\nbc"])
})

test("chunks escaped output within the requested limit without splitting entities", () => {
  const chunks = renderPlainText("a&b<c>d".repeat(8), 12)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true)
  expect(chunks.join("")).toBe(escapeHtml("a&b<c>d".repeat(8)))
  expect(chunks.every((chunk) => !chunk.endsWith("&") && !/&(amp|lt|gt)$/.test(chunk))).toBe(true)
})

test("rejects invalid chunk limits and returns one empty chunk for empty text", () => {
  expect(() => renderPlainText("text", 0)).toThrow(RangeError)
  expect(renderPlainText("")).toEqual([""])
})
