CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  chat_id TEXT,
  user_id TEXT,
  message_id TEXT,
  text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT
);

CREATE INDEX IF NOT EXISTS telegram_updates_status_updated_at_idx
  ON telegram_updates (status, updated_at);

CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
