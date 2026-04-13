-- ============================================================
-- STEP 1: Run this ENTIRE script in your Supabase SQL Editor
-- Go to: https://supabase.com → Your Project → SQL Editor
-- ============================================================

-- Enable pgvector extension (required for vector storage)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Create the documents table (where all knowledge is stored)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id            bigserial PRIMARY KEY,
  content       text,                        -- The text chunk
  metadata      jsonb DEFAULT '{}',          -- Source, page number, etc.
  embedding     vector(1536),               -- OpenAI text-embedding-3-small
  content_hash  text                         -- MD5 hash for deduplication
);

-- Index for fast vector search (VERY important for performance)
CREATE INDEX IF NOT EXISTS documents_embedding_idx
  ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index on content_hash for fast duplicate checks
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_content_hash
  ON documents (content_hash)
  WHERE content_hash IS NOT NULL;

-- ============================================================
-- Deduplication: auto-set content_hash and skip duplicate inserts
-- ============================================================
CREATE OR REPLACE FUNCTION prevent_duplicate_documents()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Compute MD5 hash of the incoming content
  NEW.content_hash := md5(NEW.content);

  -- If this hash already exists, silently cancel the insert
  IF EXISTS (
    SELECT 1 FROM documents WHERE content_hash = NEW.content_hash
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to documents table
DROP TRIGGER IF EXISTS tr_dedup_documents ON documents;
CREATE TRIGGER tr_dedup_documents
  BEFORE INSERT ON documents
  FOR EACH ROW
  EXECUTE FUNCTION prevent_duplicate_documents();

-- ============================================================
-- Create match function for COSINE similarity (DEFAULT - best)
-- ============================================================
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_count     int     DEFAULT 6,
  match_threshold float   DEFAULT 0.0
)
RETURNS TABLE (
  id         bigint,
  content    text,
  metadata   jsonb,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT
    id,
    content,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ============================================================
-- BONUS: Similarity test functions (for Python benchmark)
-- ============================================================
CREATE OR REPLACE FUNCTION match_cosine(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count     int   DEFAULT 6
)
RETURNS TABLE (id bigint, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT id, content, metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_euclidean(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count     int   DEFAULT 6
)
RETURNS TABLE (id bigint, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT id, content, metadata,
    1 / (1 + (embedding <-> query_embedding)) AS similarity
  FROM documents
  ORDER BY embedding <-> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_dot_product(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.0,
  match_count     int   DEFAULT 6
)
RETURNS TABLE (id bigint, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT id, content, metadata,
    (embedding <#> query_embedding) * -1 AS similarity
  FROM documents
  ORDER BY embedding <#> query_embedding
  LIMIT match_count;
$$;

-- ============================================================
-- Chat memory table (for conversation history)
-- n8n PostgreSQL Chat Memory node uses this automatically
-- ============================================================
CREATE TABLE IF NOT EXISTS n8n_chat_histories (
  id           bigserial PRIMARY KEY,
  session_id   text NOT NULL,
  message      jsonb NOT NULL,
  created_at   timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_histories_session
  ON n8n_chat_histories (session_id);

-- ============================================================
-- Verify everything is set up correctly
-- ============================================================
SELECT 'Setup complete! Tables, functions, and dedup trigger created.' AS status;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('documents', 'n8n_chat_histories');
