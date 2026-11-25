-- M4 extraction (docs/DECISIONS.md D37). Same pattern as indexing (0006): a state kept apart
-- from `status`, with a fencing ticket.
--
--   extract_status   NULL (never) | 'extracting' | 'extracted' | 'failed'
--   extract_job      ticket of the extraction job that owns the clauses (fencing, D20)
--   extract_version  model + prompt version the clauses were made with (versioning)
--   extract_error    why extraction failed, e.g. 'daily_budget', 'too_many_chunks'
ALTER TABLE documents ADD COLUMN extract_status TEXT
  CHECK (extract_status IN ('extracting', 'extracted', 'failed'));
ALTER TABLE documents ADD COLUMN extract_job TEXT;
ALTER TABLE documents ADD COLUMN extract_version TEXT;
ALTER TABLE documents ADD COLUMN extract_error TEXT;

-- One row per accepted clause. The quote is NOT stored: it is markdown[start_offset:end_offset]
-- of the document, so a stored clause can only ever point at text the document really has
-- (the extractor checked it verbatim, T3). details: JSON {parties, obligations, dates,
-- riskFlags}, written by the model from untrusted text: data, never instructions (T1).
CREATE TABLE clauses (
  tenant_id    TEXT    NOT NULL,
  document_id  TEXT    NOT NULL,
  chunk_idx    INTEGER NOT NULL CHECK (chunk_idx >= 0),
  n            INTEGER NOT NULL CHECK (n >= 0),          -- order within the chunk's answer
  clause_type  TEXT    NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset   INTEGER NOT NULL CHECK (end_offset > start_offset),
  details      TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, document_id, chunk_idx, n),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

-- What happened to each chunk (audit, T18): 'ok' or why the answer was unusable, how many
-- clauses were accepted and rejected (by reason), and the Neurons it cost.
CREATE TABLE extraction_chunks (
  tenant_id   TEXT    NOT NULL,
  document_id TEXT    NOT NULL,
  chunk_idx   INTEGER NOT NULL CHECK (chunk_idx >= 0),
  outcome     TEXT    NOT NULL CHECK (outcome IN ('ok', 'not_json', 'schema', 'too_large')),
  accepted    INTEGER NOT NULL CHECK (accepted >= 0),
  rejected    TEXT    NOT NULL,                          -- JSON counts by reason
  neurons     REAL    NOT NULL CHECK (neurons >= 0),
  PRIMARY KEY (tenant_id, document_id, chunk_idx),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

-- Workers AI Neurons reserved by extraction per UTC day, for the whole account: the free
-- 10,000 a day are shared by every tenant, so this is account data, not tenant data (the one
-- table whose key does not start with tenant_id). Reserved before each model call in one
-- conditional UPDATE, corrected with the real usage after it (T15).
CREATE TABLE neuron_budget (
  day     TEXT PRIMARY KEY,                               -- 'YYYY-MM-DD', UTC
  neurons REAL NOT NULL DEFAULT 0 CHECK (neurons >= 0)
);
