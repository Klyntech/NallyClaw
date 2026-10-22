# Nally memory and RAG

Nally's long-term memory and document retrieval use the existing Neon PostgreSQL database. The runtime's primary session/history database has **not** been migrated to PostgreSQL by this feature; it remains on the runtime's existing SQLite backend. Neon stores Telegram-user/session mappings, Nally memories, indexed knowledge documents, chunks, and optional embedding vectors.

## Render environment variables

Set these in the NallyClaw Render service's environment settings. Never commit secrets or paste the Neon connection string in chat.

- `NALLY_DATABASE_URL`: recommended, explicit Neon PostgreSQL connection string for Nally's memory. The accepted names, in lookup priority, are `NALLY_DATABASE_URL`, then `DATABASE_URL`, then `NEON_DATABASE_URL`. Use the dedicated variable to avoid accidentally pointing memory at a different application's database.
- `NVIDIA_API_KEY`: NVIDIA API key. The same variable may be used by the configured chat model and the embeddings API.
- `NVIDIA_EMBED_MODEL`: `nvidia/llama-nemotron-embed-vl-1b-v2` (preferred model variable; falls back to `NALLY_EMBEDDING_MODEL` if unset).
- `NVIDIA_EMBED_DIM`: `2048` (expected output size; Nally checks returned vectors against this value).
- `NALLY_EMBEDDING_MODEL`: legacy/fallback name for the embedding model.
- `NALLY_EMBEDDING_BASE_URL`: optional API base URL; defaults to `https://integrate.api.nvidia.com/v1`.

Embedding calls use the OpenAI-compatible `POST /embeddings` endpoint, with `input_type: "query"` for retrieval queries and `input_type: "passage"` for stored memories/document chunks. Nally checks that returned vectors match `NVIDIA_EMBED_DIM`; confirm the selected model supports this request format and returns 2048 dimensions. If no embedding model is configured or embedding calls fail, saved text still works and retrieval falls back to lexical matching.

## Memory tools

Tools appear in the agent as namespaced tools:

- `memory_remember`: store a durable fact, preference, goal, project detail, decision, or procedure.
- `memory_recall`: retrieve memories using hybrid semantic + PostgreSQL full-text/substring search, fused by reciprocal rank.
- `memory_search`: literal keyword/tag search.
- `memory_list`: list saved memories, optionally filtered by category.
- `memory_update`: update a memory's text, category, importance, or tags.
- `memory_forget`: forget a specific memory.

For the personal deployment, Telegram and browser voice resolve to the same canonical owner when exactly one Telegram user ID is allowlisted, preserving existing `telegram:<id>` memories. Do not configure multiple Telegram users for a shared personal owner. The system should retain useful information selectively, not every turn, and must never store access tokens or passwords as memories. The agent prompt now explicitly directs Nally to save stable facts and explicit corrections, reuse relevant retrieved context, update stale facts, and never claim a save succeeded unless the memory tool confirms it.

## RAG / knowledge tools

- `knowledge_add`: index text supplied by the user or text extracted from a document; it does not fetch arbitrary URLs.
- `knowledge_search`: retrieve relevant document chunks, including title and source metadata.
- `knowledge_list`: list indexed documents.
- `knowledge_forget`: exclude a document from future retrieval.

Documents are split into bounded overlapping chunks and exact duplicate content is skipped per user. Automatic context retrieval adds a small number of relevant memories and document passages to context before the model responds. Retrieved material is labeled as reference data, not privileged instructions.

## Database behavior

Tables are created idempotently when the first memory/session-storage request is made. The Telegram session mapping no longer falls back to an in-process map: reads and writes require Neon, and a session mapping is reported saved only after Neon confirms it. A partial knowledge-document ingestion is cleaned up if any chunk insert fails. `GET /readyz` checks agent liveness and performs a read-only `SELECT 1` against Neon; it returns 503 when the memory database is missing or unreachable, without exposing credentials or raw database errors. Neon may support the `vector` extension; the implementation attempts to enable it and use vector similarity. Retrieval now runs semantic and PostgreSQL full-text/keyword search together, then merges ranked candidates with reciprocal-rank fusion instead of returning only whichever search path ran first. Weak semantic-only matches are filtered, exact lexical matches remain eligible, and a vector query error falls back to lexical results. If the vector extension cannot be enabled, stored JSON embeddings use bounded cosine ranking before fusion. Temporary embedding outages no longer erase an existing embedding when a duplicate memory is re-saved or only its metadata is edited. Automatic retrieval failures are logged without logging the user's message or memory contents. Existing runtime SQLite data is not automatically imported into these new tables. SQLite remains the upstream runtime's session/history store; this change makes the Nally long-term memory and Telegram-to-agent-session mapping explicitly Neon-backed, but does not claim the entire OpenCode runtime has been migrated from SQLite.

## Verification status

A successful Docker build and a live Telegram test are required before treating this feature as production-verified. Test at least: remembering and recalling a fact, a second message after a service restart, one user's memory isolation from another user, indexing/searching a text note, forgetting it, and behavior when the embedding model is unset.


## Retrieval evaluation checklist

Run the unit tests for the hybrid rank fusion helper and the system-prompt memory guidance. Before calling memory production-stable, also run end-to-end checks on the deployed service:

1. Save a named preference in Telegram, then ask a paraphrased question about it during browser voice.
2. Save a project detail with an exact identifier, then ask using the identifier and using a paraphrase.
3. Correct a previously saved fact and verify the latest correction wins rather than both versions being presented as current.
4. Restart/redeploy the service and repeat recall.
5. Disable embeddings temporarily and verify lexical recall still works.
6. Query for an unrelated topic and verify unrelated memories are not injected.
7. Verify a forgotten memory is absent from later automatic recall.
8. Confirm memory failures produce a safe log category and do not break the agent response.

The semantic threshold is an initial conservative default, not a proven universal value. Tune it only against a labeled set of Nally-specific recall questions; track Recall@k, irrelevant-context rate, correction freshness, and latency. A code change or green unit test alone does not prove production retrieval quality.
