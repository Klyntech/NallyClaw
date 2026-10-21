# Nally memory and RAG

Nally's long-term memory and document retrieval use the existing Neon PostgreSQL database. The runtime's primary session/history database has **not** been migrated to PostgreSQL by this feature; it remains on the runtime's existing SQLite backend. Neon stores Telegram-user/session mappings, Nally memories, indexed knowledge documents, chunks, and optional embedding vectors.

## Render environment variables

Set these in the NallyClaw Render service's environment settings. Never commit secrets or paste the Neon connection string in chat.

- `DATABASE_URL`: recommended Neon PostgreSQL connection string. `NALLY_DATABASE_URL` and `NEON_DATABASE_URL` are also accepted and take precedence if set.
- `NVIDIA_API_KEY`: NVIDIA API key. The same variable may be used by the configured chat model and the embeddings API.
- `NALLY_EMBEDDING_MODEL`: leave unset until the desired NVIDIA embedding model is selected.
- `NALLY_EMBEDDING_BASE_URL`: optional API base URL; defaults to `https://integrate.api.nvidia.com/v1`.

Embedding calls use the OpenAI-compatible `POST /embeddings` endpoint, and send `input_type: "query"` for retrieval queries and `input_type: "passage"` for stored memories/document chunks. Verify the chosen NVIDIA model supports this request format before enabling it. If no embedding model is configured or embedding calls fail, saved text still works and retrieval falls back to lexical matching.

## Memory tools

Tools appear in the agent as namespaced tools:

- `memory_remember`: store a durable fact, preference, goal, project detail, decision, or procedure.
- `memory_recall`: retrieve memories relevant to a query using embeddings when available, otherwise lexical matching.
- `memory_search`: literal keyword/tag search.
- `memory_list`: list saved memories, optionally filtered by category.
- `memory_update`: update a memory's text, category, importance, or tags.
- `memory_forget`: forget a specific memory.

Memories are scoped to the Telegram user associated with the current session. They are not shared between different Telegram users. The system should retain useful information selectively, not every turn, and must never store access tokens or passwords as memories.

## RAG / knowledge tools

- `knowledge_add`: index text supplied by the user or text extracted from a document; it does not fetch arbitrary URLs.
- `knowledge_search`: retrieve relevant document chunks, including title and source metadata.
- `knowledge_list`: list indexed documents.
- `knowledge_forget`: exclude a document from future retrieval.

Documents are split into bounded overlapping chunks and exact duplicate content is skipped per user. Automatic context retrieval adds a small number of relevant memories and document passages to context before the model responds. Retrieved material is labeled as reference data, not privileged instructions.

## Database behavior

Tables are created idempotently when the first memory/session-storage request is made. Neon may support the `vector` extension; the implementation attempts to enable it and use vector similarity. If the extension cannot be enabled, it stores vectors as JSON and uses bounded in-process cosine ranking, then lexical search as a fallback. Existing runtime SQLite data is not automatically imported into these new tables.

## Verification status

A successful Docker build and a live Telegram test are required before treating this feature as production-verified. Test at least: remembering and recalling a fact, a second message after a service restart, one user's memory isolation from another user, indexing/searching a text note, forgetting it, and behavior when the embedding model is unset.
