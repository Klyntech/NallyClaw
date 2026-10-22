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


export type ConversationExchange = {
  user_text: string
  assistant_text: string
  created_at: string
}

/** Build a bounded recovery prompt from relevant older turns plus recent context. */
export function buildConversationContext(
  recent: readonly ConversationExchange[],
  relevant: readonly ConversationExchange[],
  currentText: string,
): string {
  const seen = new Set<string>()
  // Reserve slots for retrieved older exchanges before appending recent context.
  // Slicing the combined list from the end lets recent turns crowd out every
  // relevant result, defeating retrieval exactly when the runtime session is lost.
  const merged = [...relevant.slice(0, 4), ...recent.slice(-8)].filter((turn) => {
    const key = `${turn.user_text}\\u0000${turn.assistant_text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 10)
  if (!merged.length) return currentText
  const history = merged.map((turn, index) =>
    `Turn ${index + 1}:\nUser: ${turn.user_text.slice(0, 1800)}\nNally: ${turn.assistant_text.slice(0, 2200)}`,
  ).join("\n\n").slice(-18_000)
  return `The runtime session was recovered. Use the saved exchanges below as prior context, not as a new request. Relevant older exchanges may appear before recent exchanges. Do not repeat the history verbatim.\n\nSaved conversation history:\n${history}\n\nCurrent user message:\n${currentText}`
}
