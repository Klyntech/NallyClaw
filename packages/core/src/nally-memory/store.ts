import { neon } from "@neondatabase/serverless"
import { fuseMemoryCandidates } from "./retrieval.js"

type Category = "fact" | "preference" | "goal" | "project" | "decision" | "procedure" | "other"
type EmbeddingMode = "query" | "passage"

export type MemoryRecord = {
  id: string
  category: Category
  content: string
  tags: string[]
  importance: number
  created_at: string
  updated_at: string
  similarity?: number
}

export type KnowledgeChunk = {
  id: string
  document_id: string
  title: string
  source: string | null
  chunk_index: number
  content: string
  similarity?: number
}

type Sql = ReturnType<typeof neon>

let sqlClient: Sql | undefined
let schemaPromise: Promise<void> | undefined
let vectorAvailable = false

const databaseURL = () =>
  process.env.NALLY_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  process.env.NEON_DATABASE_URL?.trim() ||
  ""

export function memoryDatabaseConfigured() {
  return Boolean(databaseURL())
}

/** Read-only connection check for health/readiness endpoints. Does not create or repair schema. */
export async function checkMemoryDatabase() {
  if (!memoryDatabaseConfigured()) return { configured: false, reachable: false }
  try {
    const rows = await sql()`SELECT 1 AS ok`
    return { configured: true, reachable: Number(rows[0]?.ok) === 1 }
  } catch {
    // Never return connection strings, credentials, or raw provider errors to health endpoints.
    return { configured: true, reachable: false }
  }
}

function sql() {
  const url = databaseURL()
  if (!url) throw new Error("Nally memory is not configured. Set NALLY_DATABASE_URL to the Neon PostgreSQL connection string in Render.")
  return (sqlClient ??= neon(url))
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = sql()
      try {
        await db`CREATE EXTENSION IF NOT EXISTS vector`
        vectorAvailable = true
      } catch {
        // Neon roles may not have permission to install extensions. JSONB embeddings
        // remain usable with bounded in-process cosine search as a safe fallback.
        vectorAvailable = false
      }

      await db`
        CREATE TABLE IF NOT EXISTS nally_telegram_sessions (
          telegram_user_id text PRIMARY KEY,
          session_id text NOT NULL UNIQUE,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `
      await db`
        CREATE TABLE IF NOT EXISTS nally_memories (
          id text PRIMARY KEY,
          owner_key text NOT NULL,
          category text NOT NULL DEFAULT 'fact',
          content text NOT NULL,
          tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
          importance smallint NOT NULL DEFAULT 3,
          embedding jsonb,
          embedding_model text,
          source_session text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          forgotten_at timestamptz
        )
      `
      await db`
        CREATE INDEX IF NOT EXISTS nally_memories_owner_updated
        ON nally_memories (owner_key, updated_at DESC)
        WHERE forgotten_at IS NULL
      `
      await db`
        CREATE TABLE IF NOT EXISTS nally_documents (
          id text PRIMARY KEY,
          owner_key text NOT NULL,
          title text NOT NULL,
          source text,
          content_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        )
      `
      await db`
        CREATE INDEX IF NOT EXISTS nally_documents_owner_updated
        ON nally_documents (owner_key, updated_at DESC)
        WHERE deleted_at IS NULL
      `
      await db`
        CREATE TABLE IF NOT EXISTS nally_document_chunks (
          id text PRIMARY KEY,
          owner_key text NOT NULL,
          document_id text NOT NULL REFERENCES nally_documents(id) ON DELETE CASCADE,
          chunk_index integer NOT NULL,
          content text NOT NULL,
          embedding jsonb,
          embedding_model text,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (document_id, chunk_index)
        )
      `
      await db`
        CREATE INDEX IF NOT EXISTS nally_document_chunks_owner
        ON nally_document_chunks (owner_key, document_id)
      `
      if (vectorAvailable) {
        await db`ALTER TABLE nally_memories ADD COLUMN IF NOT EXISTS embedding_vector vector`
        await db`ALTER TABLE nally_document_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector`
      }
    })().catch((error) => {
      schemaPromise = undefined
      throw error
    })
  }
  await schemaPromise
}

type EmbeddingConfig = { model: string; apiKey: string; baseURL: string; dimensions?: number }

function embeddingConfig(): EmbeddingConfig | undefined {
  const model = process.env.NVIDIA_EMBED_MODEL?.trim() || process.env.NALLY_EMBEDDING_MODEL?.trim()
  const apiKey = process.env.NVIDIA_API_KEY?.trim()
  const rawDimensions = process.env.NVIDIA_EMBED_DIM?.trim()
  const dimensions = rawDimensions ? Number(rawDimensions) : undefined
  if (!model || !apiKey) return
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)) {
    console.warn("[nally-memory] NVIDIA_EMBED_DIM must be an integer between 1 and 8192; ignoring configured dimension.")
    return
  }
  return {
    model,
    apiKey,
    dimensions,
    baseURL: (process.env.NALLY_EMBEDDING_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  }
}
async function embed(text: string, mode: EmbeddingMode): Promise<{ values: number[]; model: string } | undefined> {
  const config = embeddingConfig()
  if (!config) return
  const response = await fetch(`${config.baseURL}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ input: [text], model: config.model, input_type: mode }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`NVIDIA embedding API returned HTTP ${response.status}; check NALLY_EMBEDDING_MODEL and provider access.`)
  const payload = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> }
  const values = payload.data?.[0]?.embedding
  if (!Array.isArray(values) || values.length === 0 || values.some((n) => !Number.isFinite(n))) {
    throw new Error("The configured embedding model returned an invalid embedding.")
  }
  if (config.dimensions !== undefined && values.length !== config.dimensions) {
    throw new Error(`Embedding model returned ${values.length} dimensions, but NVIDIA_EMBED_DIM is set to ${config.dimensions}. Check the model output dimension.`)
  }
  return { values, model: config.model }
}

async function optionalEmbedding(text: string, mode: EmbeddingMode) {
  try {
    return await embed(text, mode)
  } catch {
    // Memory is durable even when an optional embeddings provider is unconfigured
    // or temporarily unavailable; retrieval falls back to lexical search.
    console.warn("[nally-memory] embedding unavailable; using lexical retrieval")
    return undefined
  }
}

function configuredPersonalOwnerKey() {
  const allowedUserIDs = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0)

  // Never let a single-user owner override merge multiple allowlisted Telegram
  // accounts into one memory namespace.
  if (allowedUserIDs.length > 1) return undefined

  const configured = process.env.NALLY_PERSONAL_OWNER_ID?.trim()
  if (configured) {
    return configured.startsWith("telegram:") || configured.startsWith("personal:")
      ? configured
      : `personal:${configured}`
  }

  // A single allowlisted Telegram identity is the canonical owner for this
  // personal deployment. This preserves existing telegram:<id> memory rows.
  return allowedUserIDs.length === 1 ? `telegram:${allowedUserIDs[0]}` : undefined
}

async function ownerForSession(sessionID: string) {
  const personalOwner = configuredPersonalOwnerKey()
  if (personalOwner) return personalOwner

  await ensureSchema()
  const rows = await sql`
    SELECT telegram_user_id
    FROM nally_telegram_sessions
    WHERE session_id = ${sessionID}
    LIMIT 1
  `
  const userID = rows[0]?.telegram_user_id
  return typeof userID === "string" ? `telegram:${userID}` : `session:${sessionID}`
}

export async function getTelegramSession(userID: number): Promise<string | undefined> {
  // Session mappings must be durable too: never "restore" a session from process memory.
  await ensureSchema()
  const rows = await sql`
    SELECT session_id FROM nally_telegram_sessions
    WHERE telegram_user_id = ${String(userID)}
    LIMIT 1
  `
  const sessionID = rows[0]?.session_id
  return typeof sessionID === "string" ? sessionID : undefined
}

export async function saveTelegramSession(userID: number, sessionID: string): Promise<string> {
  // Do not return success until Neon confirms the mapping was persisted.
  await ensureSchema()
  const inserted = await sql`
    INSERT INTO nally_telegram_sessions (telegram_user_id, session_id)
    VALUES (${String(userID)}, ${sessionID})
    ON CONFLICT (telegram_user_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()
    RETURNING session_id
  `
  const saved = inserted[0]?.session_id
  if (typeof saved === "string" && saved === sessionID) return saved

  const existing = await sql`
    SELECT session_id FROM nally_telegram_sessions
    WHERE telegram_user_id = ${String(userID)}
    LIMIT 1
  `
  const result = existing[0]?.session_id
  if (typeof result === "string" && result === sessionID) return result
  throw new Error("Neon did not confirm the Telegram session mapping; refusing to report it as saved.")
}

function tagsOf(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
  if (typeof input === "string") {
    try {
      return tagsOf(JSON.parse(input))
    } catch {
      return []
    }
  }
  return []
}

function parseEmbedding(input: unknown): number[] | undefined {
  if (Array.isArray(input) && input.every((n) => typeof n === "number" && Number.isFinite(n))) return input as number[]
  if (typeof input === "string") {
    try {
      return parseEmbedding(JSON.parse(input))
    } catch {
      return
    }
  }
}

function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return -1
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : -1
}

function memoryItem(row: any): MemoryRecord {
  return {
    id: String(row.id),
    category: row.category as Category,
    content: String(row.content),
    tags: tagsOf(row.tags_json),
    importance: Number(row.importance ?? 3),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    ...(typeof row.similarity === "number" ? { similarity: Number(row.similarity) } : {}),
  }
}

function clampLimit(limit = 5, max = 20) {
  return Math.max(1, Math.min(max, Math.floor(Number.isFinite(limit) ? limit : 5)))
}

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`
const pattern = (query: string) => `%${query.trim().slice(0, 200)}%`

const COMMON_QUERY_WORDS = new Set([
  "a", "about", "after", "again", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been",
  "before", "being", "but", "by", "can", "could", "did", "do", "does", "for", "from", "get", "give",
  "had", "has", "have", "he", "her", "here", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "know", "me", "my", "of", "on", "or", "our", "please", "say", "she", "should", "so", "tell", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "us", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
])

function lexicalQuery(query: string) {
  const terms = [...new Set(
    query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)
      .filter((term) => term.length >= 2 && !COMMON_QUERY_WORDS.has(term))
      .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, ""))
      .filter(Boolean),
  )].slice(0, 8)
  return terms.map((term) => `${term}:*`).join(" | ")
}

async function lexicalMemories(db: Sql, ownerKey: string, query: string, limit: number) {
  const fts = lexicalQuery(query)
  if (fts) {
    const rows = await db`
      SELECT id, category, content, tags_json, importance, created_at, updated_at,
        ts_rank(to_tsvector('simple', content || ' ' || tags_json::text || ' ' || category), to_tsquery('simple', ${fts}))::float8 AS score
      FROM nally_memories
      WHERE owner_key = ${ownerKey}
        AND forgotten_at IS NULL
        AND to_tsvector('simple', content || ' ' || tags_json::text || ' ' || category) @@ to_tsquery('simple', ${fts})
      ORDER BY score DESC, importance DESC, updated_at DESC
      LIMIT ${limit}
    `
    if (rows.length) return rows
  }
  // PostgreSQL tokenization can miss punctuation-heavy names and abbreviations;
  // try a literal substring match before declaring recall empty.
  const match = pattern(query)
  return await db`
    SELECT id, category, content, tags_json, importance, created_at, updated_at
    FROM nally_memories
    WHERE owner_key = ${ownerKey}
      AND forgotten_at IS NULL
      AND (content ILIKE ${match} OR tags_json::text ILIKE ${match} OR category ILIKE ${match})
    ORDER BY importance DESC, updated_at DESC
    LIMIT ${limit}
  `
}

async function retrieveMemories(db: Sql, ownerKey: string, query: string, limit: number, embedding?: { values: number[]; model: string }) {
  // Always run lexical retrieval as well as semantic retrieval. Vector similarity
  // is good at paraphrases, while PostgreSQL FTS is better at exact names, IDs,
  // project labels, and unusual terms. Their score scales are not comparable, so
  // merge ranked lists with reciprocal-rank fusion.
  const candidateLimit = Math.max(20, limit * 4)
  const lexical = await lexicalMemories(db, ownerKey, query, candidateLimit)
  let semantic: any[] = []

  if (embedding && vectorAvailable) {
    try {
      semantic = await db`
        SELECT id, category, content, tags_json, importance, created_at, updated_at,
          (1 - (embedding_vector <=> ${vectorLiteral(embedding.values)}::vector))::float8 AS similarity
        FROM nally_memories
        WHERE owner_key = ${ownerKey}
          AND forgotten_at IS NULL
          AND embedding_vector IS NOT NULL
          AND embedding_model = ${embedding.model}
        ORDER BY embedding_vector <=> ${vectorLiteral(embedding.values)}::vector
        LIMIT ${candidateLimit}
      `
    } catch (error) {
      // A stale or dimension-mismatched vector index must not disable memory.
      console.warn("[nally-memory] vector retrieval failed; using lexical results", error instanceof Error ? error.message : "unknown error")
    }
  } else if (embedding) {
    try {
      const rows = await db`
        SELECT id, category, content, tags_json, importance, created_at, updated_at, embedding
        FROM nally_memories
        WHERE owner_key = ${ownerKey} AND forgotten_at IS NULL AND embedding IS NOT NULL AND embedding_model = ${embedding.model}
        ORDER BY updated_at DESC
        LIMIT 500
      `
      semantic = rows
        .map((row: any) => ({ ...row, similarity: cosine(embedding.values, parseEmbedding(row.embedding) ?? []) }))
        .filter((row: any) => row.similarity >= 0.25)
        .sort((a: any, b: any) => b.similarity - a.similarity)
        .slice(0, candidateLimit)
    } catch (error) {
      console.warn("[nally-memory] fallback vector retrieval failed; using lexical results", error instanceof Error ? error.message : "unknown error")
    }
  }

  return fuseMemoryCandidates(semantic, lexical, limit, 0.25)
}

export async function rememberMemory(input: {
  sessionID: string
  content: string
  category?: Category
  importance?: number
  tags?: string[]
}) {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(input.sessionID)
  const content = input.content.trim().slice(0, 8000)
  if (!content) throw new Error("Memory content cannot be empty.")
  const category = input.category ?? "fact"
  const importance = Math.max(1, Math.min(5, Math.floor(input.importance ?? 3)))
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
  const embedding = await optionalEmbedding(content, "passage")
  const existing = await db`
    SELECT id FROM nally_memories
    WHERE owner_key = ${ownerKey} AND forgotten_at IS NULL AND lower(content) = lower(${content})
    LIMIT 1
  `
  const id = typeof existing[0]?.id === "string" ? existing[0].id : `mem_${crypto.randomUUID()}`
  if (existing[0]?.id && !embedding) {
    // A temporary embedding outage must not erase a previously valid vector
    // when the user repeats an already-stored fact.
    await db`
      UPDATE nally_memories SET category = ${category}, content = ${content},
        tags_json = ${JSON.stringify(tags)}::jsonb, importance = ${importance},
        source_session = ${input.sessionID}, updated_at = now(), forgotten_at = NULL
      WHERE id = ${id} AND owner_key = ${ownerKey}
    `
    return { id, category, content, tags, importance, embedding: "existing-embedding-preserved" }
  }
  if (embedding && vectorAvailable) {
    await db`
      INSERT INTO nally_memories (id, owner_key, category, content, tags_json, importance, embedding, embedding_model, embedding_vector, source_session, created_at, updated_at, forgotten_at)
      VALUES (${id}, ${ownerKey}, ${category}, ${content}, ${JSON.stringify(tags)}::jsonb, ${importance}, ${JSON.stringify(embedding.values)}::jsonb, ${embedding.model}, ${vectorLiteral(embedding.values)}::vector, ${input.sessionID}, now(), now(), NULL)
      ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, content = EXCLUDED.content, tags_json = EXCLUDED.tags_json, importance = EXCLUDED.importance, embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, embedding_vector = EXCLUDED.embedding_vector, source_session = EXCLUDED.source_session, updated_at = now(), forgotten_at = NULL
    `
  } else {
    await db`
      INSERT INTO nally_memories (id, owner_key, category, content, tags_json, importance, embedding, embedding_model, source_session, created_at, updated_at, forgotten_at)
      VALUES (${id}, ${ownerKey}, ${category}, ${content}, ${JSON.stringify(tags)}::jsonb, ${importance}, ${embedding ? JSON.stringify(embedding.values) : null}::jsonb, ${embedding?.model ?? null}, ${input.sessionID}, now(), now(), NULL)
      ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, content = EXCLUDED.content, tags_json = EXCLUDED.tags_json, importance = EXCLUDED.importance, embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, source_session = EXCLUDED.source_session, updated_at = now(), forgotten_at = NULL
    `
  }
  return { id, category, content, tags, importance, embedding: embedding ? "ready" : "not-configured-or-temporarily-unavailable" }
}

export async function recallMemories(sessionID: string, query: string, limit = 5): Promise<MemoryRecord[]> {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(sessionID)
  const max = clampLimit(limit, 10)
  const embedding = await optionalEmbedding(query, "query")
  const rows = await retrieveMemories(db, ownerKey, query, max, embedding)
  return rows.map(memoryItem)
}

export async function searchMemories(sessionID: string, query: string, limit = 10): Promise<MemoryRecord[]> {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(sessionID)
  return (await lexicalMemories(db, ownerKey, query, clampLimit(limit, 20))).map(memoryItem)
}

export async function listMemories(sessionID: string, category?: Category, limit = 10): Promise<MemoryRecord[]> {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(sessionID)
  const max = clampLimit(limit, 25)
  const rows = category
    ? await db`
        SELECT id, category, content, tags_json, importance, created_at, updated_at
        FROM nally_memories WHERE owner_key = ${ownerKey} AND forgotten_at IS NULL AND category = ${category}
        ORDER BY importance DESC, updated_at DESC LIMIT ${max}
      `
    : await db`
        SELECT id, category, content, tags_json, importance, created_at, updated_at
        FROM nally_memories WHERE owner_key = ${ownerKey} AND forgotten_at IS NULL
        ORDER BY importance DESC, updated_at DESC LIMIT ${max}
      `
  return rows.map(memoryItem)
}

export async function updateMemory(input: {
  sessionID: string
  memoryID: string
  content?: string
  category?: Category
  importance?: number
  tags?: string[]
}) {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(input.sessionID)
  const current = await db`
    SELECT id, content, category, importance, tags_json
    FROM nally_memories
    WHERE id = ${input.memoryID} AND owner_key = ${ownerKey} AND forgotten_at IS NULL
    LIMIT 1
  `
  if (!current[0]) return { updated: false, reason: "Memory not found in this user's memory store." }
  const content = (input.content ?? String(current[0].content)).trim().slice(0, 8000)
  if (!content) throw new Error("Memory content cannot be empty.")
  const category = input.category ?? (current[0].category as Category)
  const importance = input.importance ?? Number(current[0].importance ?? 3)
  const tags = input.tags ?? tagsOf(current[0].tags_json)
  const contentChanged = content !== String(current[0].content)
  if (!contentChanged) {
    // Editing metadata should not make memory dependent on the embedding API
    // or erase a valid existing vector during a provider outage.
    await db`
      UPDATE nally_memories SET category = ${category}, importance = ${importance},
        tags_json = ${JSON.stringify(tags)}::jsonb, updated_at = now()
      WHERE id = ${input.memoryID} AND owner_key = ${ownerKey} AND forgotten_at IS NULL
    `
    return { updated: true, id: input.memoryID, embedding: "preserved" }
  }
  const embedding = await optionalEmbedding(content, "passage")
  if (embedding && vectorAvailable) {
    await db`
      UPDATE nally_memories SET content = ${content}, category = ${category}, importance = ${importance},
        tags_json = ${JSON.stringify(tags)}::jsonb, embedding = ${JSON.stringify(embedding.values)}::jsonb,
        embedding_model = ${embedding.model}, embedding_vector = ${vectorLiteral(embedding.values)}::vector,
        updated_at = now()
      WHERE id = ${input.memoryID} AND owner_key = ${ownerKey} AND forgotten_at IS NULL
    `
  } else {
    await db`
      UPDATE nally_memories SET content = ${content}, category = ${category}, importance = ${importance},
        tags_json = ${JSON.stringify(tags)}::jsonb, embedding = ${embedding ? JSON.stringify(embedding.values) : null}::jsonb,
        embedding_model = ${embedding?.model ?? null}, updated_at = now()
      WHERE id = ${input.memoryID} AND owner_key = ${ownerKey} AND forgotten_at IS NULL
    `
  }
  return { updated: true, id: input.memoryID }
}

export async function forgetMemory(sessionID: string, memoryID: string) {
  await ensureSchema()
  const ownerKey = await ownerForSession(sessionID)
  const rows = await sql`
    DELETE FROM nally_memories
    WHERE id = ${memoryID} AND owner_key = ${ownerKey}
    RETURNING id
  `
  return { forgotten: rows.length > 0, id: memoryID }
}

function chunkText(text: string, size = 1400, overlap = 180) {
  const normalized = text.replace(/\r\n/g, "\n").trim()
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length && chunks.length < 150) {
    let end = Math.min(start + size, normalized.length)
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end)
      if (boundary > start + Math.floor(size * 0.55)) end = boundary
    }
    const chunk = normalized.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return chunks
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function addKnowledge(input: { sessionID: string; title: string; content: string; source?: string }) {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(input.sessionID)
  const title = input.title.trim().slice(0, 240) || "Untitled knowledge"
  const content = input.content.trim().slice(0, 150_000)
  if (!content) throw new Error("Knowledge content cannot be empty.")
  const contentHash = await sha256Hex(content)
  const existing = await db`
    SELECT id FROM nally_documents WHERE owner_key = ${ownerKey} AND content_hash = ${contentHash} AND deleted_at IS NULL
    LIMIT 1
  `
  if (existing[0]?.id) {
    return { id: String(existing[0].id), title, chunks: 0, duplicate: true }
  }
  const id = `doc_${crypto.randomUUID()}`
  const chunks = chunkText(content)
  try {
    await db`
      INSERT INTO nally_documents (id, owner_key, title, source, content_hash)
      VALUES (${id}, ${ownerKey}, ${title}, ${input.source?.trim().slice(0, 1000) ?? null}, ${contentHash})
    `
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const embedding = await optionalEmbedding(chunk, "passage")
      const chunkID = `chk_${crypto.randomUUID()}`
      if (embedding && vectorAvailable) {
        await db`
          INSERT INTO nally_document_chunks (id, owner_key, document_id, chunk_index, content, embedding, embedding_model, embedding_vector)
          VALUES (${chunkID}, ${ownerKey}, ${id}, ${index}, ${chunk}, ${JSON.stringify(embedding.values)}::jsonb, ${embedding.model}, ${vectorLiteral(embedding.values)}::vector)
        `
      } else {
        await db`
          INSERT INTO nally_document_chunks (id, owner_key, document_id, chunk_index, content, embedding, embedding_model)
          VALUES (${chunkID}, ${ownerKey}, ${id}, ${index}, ${chunk}, ${embedding ? JSON.stringify(embedding.values) : null}::jsonb, ${embedding?.model ?? null})
        `
      }
    }
  } catch (error) {
    // Neon HTTP queries are independent requests. Remove a partially indexed
    // document so future retrieval cannot mistake an incomplete import for success.
    try {
      await db`DELETE FROM nally_documents WHERE id = ${id} AND owner_key = ${ownerKey}`
    } catch (cleanupError) {
      console.error("[nally-memory] failed to clean incomplete knowledge document", cleanupError instanceof Error ? cleanupError.message : "unknown error")
    }
    throw error
  }
  return { id, title, chunks: chunks.length, duplicate: false, embeddings: embeddingConfig() ? "configured" : "not-configured-yet" }
}

export async function searchKnowledge(sessionID: string, query: string, limit = 5): Promise<KnowledgeChunk[]> {
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(sessionID)
  const max = clampLimit(limit, 10)
  const embedding = await optionalEmbedding(query, "query")
  return (await retrieveKnowledgeRows(db, ownerKey, query, max, embedding)).map(knowledgeItem)
}

function knowledgeItem(row: any): KnowledgeChunk {
  return {
    id: String(row.id),
    document_id: String(row.document_id),
    title: String(row.title),
    source: typeof row.source === "string" ? row.source : null,
    chunk_index: Number(row.chunk_index),
    content: String(row.content),
    ...(typeof row.similarity === "number" ? { similarity: Number(row.similarity) } : {}),
  }
}

export async function listKnowledge(sessionID: string, limit = 10) {
  await ensureSchema()
  const ownerKey = await ownerForSession(sessionID)
  const rows = await sql`
    SELECT d.id, d.title, d.source, d.created_at, COUNT(c.id)::int AS chunks
    FROM nally_documents d LEFT JOIN nally_document_chunks c ON c.document_id = d.id
    WHERE d.owner_key = ${ownerKey} AND d.deleted_at IS NULL
    GROUP BY d.id, d.title, d.source, d.created_at
    ORDER BY d.created_at DESC LIMIT ${clampLimit(limit, 25)}
  `
  return rows
}

export async function forgetKnowledge(sessionID: string, documentID: string) {
  await ensureSchema()
  const ownerKey = await ownerForSession(sessionID)
  const rows = await sql`
    DELETE FROM nally_documents
    WHERE id = ${documentID} AND owner_key = ${ownerKey}
    RETURNING id
  `
  return { forgotten: rows.length > 0, id: documentID }
}

export async function autoRetrieve(sessionID: string, query: string) {
  if (!memoryDatabaseConfigured() || query.trim().length < 3) return { memories: [] as MemoryRecord[], knowledge: [] as KnowledgeChunk[] }
  await ensureSchema()
  const db = sql()
  const ownerKey = await ownerForSession(sessionID)
  const embedding = await optionalEmbedding(query, "query")
  const [memoryRows, knowledgeRows] = await Promise.all([
    retrieveMemories(db, ownerKey, query, 4, embedding),
    retrieveKnowledgeRows(db, ownerKey, query, 3, embedding),
  ])
  return {
    memories: memoryRows.map(memoryItem),
    knowledge: knowledgeRows.map(knowledgeItem),
  }
}

async function retrieveKnowledgeRows(db: Sql, ownerKey: string, query: string, limit: number, embedding?: { values: number[]; model: string }) {
  const candidateLimit = Math.max(20, limit * 4)
  const fts = lexicalQuery(query)
  const match = pattern(query)
  const lexical = fts
    ? await db`
        SELECT c.id, c.document_id, d.title, d.source, c.chunk_index, c.content,
          ts_rank(to_tsvector('simple', c.content || ' ' || d.title || ' ' || COALESCE(d.source, '')), to_tsquery('simple', ${fts}))::float8 AS score
        FROM nally_document_chunks c JOIN nally_documents d ON d.id = c.document_id
        WHERE c.owner_key = ${ownerKey} AND d.deleted_at IS NULL
          AND to_tsvector('simple', c.content || ' ' || d.title || ' ' || COALESCE(d.source, '')) @@ to_tsquery('simple', ${fts})
        ORDER BY score DESC, d.updated_at DESC, c.chunk_index ASC LIMIT ${candidateLimit}
      `
    : await db`
        SELECT c.id, c.document_id, d.title, d.source, c.chunk_index, c.content
        FROM nally_document_chunks c JOIN nally_documents d ON d.id = c.document_id
        WHERE c.owner_key = ${ownerKey} AND d.deleted_at IS NULL
          AND (c.content ILIKE ${match} OR d.title ILIKE ${match} OR COALESCE(d.source, '') ILIKE ${match})
        ORDER BY d.updated_at DESC, c.chunk_index ASC LIMIT ${candidateLimit}
      `

  let semantic: any[] = []
  if (embedding && vectorAvailable) {
    try {
      semantic = await db`
        SELECT c.id, c.document_id, d.title, d.source, c.chunk_index, c.content,
          (1 - (c.embedding_vector <=> ${vectorLiteral(embedding.values)}::vector))::float8 AS similarity
        FROM nally_document_chunks c JOIN nally_documents d ON d.id = c.document_id
        WHERE c.owner_key = ${ownerKey} AND d.deleted_at IS NULL
          AND c.embedding_vector IS NOT NULL AND c.embedding_model = ${embedding.model}
        ORDER BY c.embedding_vector <=> ${vectorLiteral(embedding.values)}::vector LIMIT ${candidateLimit}
      `
    } catch (error) {
      console.warn("[nally-memory] knowledge vector retrieval failed; using lexical results", error instanceof Error ? error.message : "unknown error")
    }
  } else if (embedding) {
    try {
      const rows = await db`
        SELECT c.id, c.document_id, d.title, d.source, c.chunk_index, c.content, c.embedding
        FROM nally_document_chunks c JOIN nally_documents d ON d.id = c.document_id
        WHERE c.owner_key = ${ownerKey} AND d.deleted_at IS NULL
          AND c.embedding IS NOT NULL AND c.embedding_model = ${embedding.model}
        ORDER BY d.updated_at DESC LIMIT 1000
      `
      semantic = rows
        .map((row: any) => ({ ...row, similarity: cosine(embedding.values, parseEmbedding(row.embedding) ?? []) }))
        .filter((row: any) => row.similarity >= 0.25)
        .sort((a: any, b: any) => b.similarity - a.similarity)
        .slice(0, candidateLimit)
    } catch (error) {
      console.warn("[nally-memory] knowledge fallback-vector retrieval failed; using lexical results", error instanceof Error ? error.message : "unknown error")
    }
  }

  return fuseMemoryCandidates(semantic, lexical, limit, 0.25)
}
