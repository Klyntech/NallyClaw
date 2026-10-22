import { describe, expect, test } from "bun:test"
import { buildConversationContext, fuseMemoryCandidates } from "../src/nally-memory/retrieval.js"

describe("fuseMemoryCandidates", () => {
  test("promotes a memory found by both semantic and lexical retrieval", () => {
    const semantic = [
      { id: "semantic-only", similarity: 0.82, importance: 5 },
      { id: "shared", similarity: 0.72, importance: 2 },
    ]
    const lexical = [
      { id: "shared", importance: 2 },
      { id: "lexical-only", importance: 5 },
    ]

    expect(fuseMemoryCandidates(semantic, lexical, 3).map((item) => item.id)).toEqual([
      "shared",
      "semantic-only",
      "lexical-only",
    ])
  })

  test("keeps exact lexical matches even when semantic similarity is weak", () => {
    const semantic = [{ id: "weak", similarity: 0.12 }]
    const lexical = [{ id: "exact-keyword" }, { id: "weak" }]

    expect(fuseMemoryCandidates(semantic, lexical, 5).map((item) => item.id)).toEqual([
      "exact-keyword",
      "weak",
    ])
  })

  test("drops weak semantic-only candidates to reduce irrelevant memory injection", () => {
    const semantic = [
      { id: "unrelated", similarity: 0.18 },
      { id: "relevant", similarity: 0.66 },
    ]

    expect(fuseMemoryCandidates(semantic, [], 5).map((item) => item.id)).toEqual(["relevant"])
  })

  test("is deterministic for ties and respects the requested limit", () => {
    const lexical = [{ id: "b" }, { id: "a" }, { id: "c" }]
    expect(fuseMemoryCandidates([], lexical, 2).map((item) => item.id)).toEqual(["b", "a"])
  })
})


describe("buildConversationContext", () => {
  const turn = (user_text: string, assistant_text: string) => ({
    user_text,
    assistant_text,
    created_at: "2026-10-22T00:00:00Z",
  })

  test("combines relevant older turns with recent turns and deduplicates overlap", () => {
    const older = turn("What was the NallyClaw branch?", "nally/voice-first-web")
    const recent = turn("What did we change today?", "Conversation turns are saved in Neon.")
    const result = buildConversationContext(
      [older, recent],
      [older],
      "Continue the implementation",
    )
    expect(result.match(/What was the NallyClaw branch\?/g)).toHaveLength(1)
    expect(result).toContain("Conversation turns are saved in Neon.")
    expect(result).toContain("Current user message:\nContinue the implementation")
  })

  test("returns the current request unchanged when no saved turns exist", () => {
    expect(buildConversationContext([], [], "Hello Nally")).toBe("Hello Nally")
  })

  test("bounds recovered context and each individual exchange", () => {
    const turns = Array.from({ length: 14 }, (_, index) =>
      turn(`question ${index} ${"x".repeat(2500)}`, `answer ${index} ${"y".repeat(3000)}`),
    )
    const result = buildConversationContext(turns, [], "Current request")
    expect(result).toContain("Current request")
    expect(result.length).toBeLessThan(19_000)
  })
})
