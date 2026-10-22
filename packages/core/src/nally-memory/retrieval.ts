export type RankedMemoryCandidate = {
  id: string
  similarity?: number
  importance?: number
  updated_at?: string
}

/**
 * Merge semantic and lexical result lists without comparing incompatible score
 * scales. Reciprocal-rank fusion rewards memories found by both paths and keeps
 * exact keyword matches discoverable even when embeddings rank them lower.
 */
export function fuseMemoryCandidates<T extends RankedMemoryCandidate>(
  semantic: readonly T[],
  lexical: readonly T[],
  limit: number,
  minimumSemanticSimilarity = 0.25,
): T[] {
  const fused = new Map<string, { item: T; score: number; semanticRank?: number; lexicalRank?: number }>()

  semantic.forEach((item, index) => {
    if (typeof item.similarity !== "number" || !Number.isFinite(item.similarity) || item.similarity < minimumSemanticSimilarity) return
    fused.set(item.id, {
      item,
      score: 1 / (60 + index + 1),
      semanticRank: index + 1,
    })
  })

  lexical.forEach((item, index) => {
    const rankScore = 1 / (60 + index + 1)
    const existing = fused.get(item.id)
    if (existing) {
      existing.score += rankScore
      existing.lexicalRank = index + 1
      // Keep the semantic row because it carries its similarity score.
    } else {
      fused.set(item.id, { item, score: rankScore, lexicalRank: index + 1 })
    }
  })

  return [...fused.values()]
    .sort((a, b) =>
      b.score - a.score ||
      (b.item.similarity ?? -1) - (a.item.similarity ?? -1) ||
      (b.item.importance ?? 0) - (a.item.importance ?? 0) ||
      String(b.item.updated_at ?? "").localeCompare(String(a.item.updated_at ?? "")) ||
      a.item.id.localeCompare(b.item.id),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ item }) => item)
}
