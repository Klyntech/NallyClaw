import { describe, expect, test } from "bun:test"
import { fuseMemoryCandidates } from "../src/nally-memory/retrieval.js"

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
