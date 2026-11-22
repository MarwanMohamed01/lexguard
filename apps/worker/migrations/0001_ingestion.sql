-- M2 ingestion schema. Applied once by `wrangler d1 migrations apply`; never edit an applied
-- migration, add a new numbered file instead.
--
-- Isolation rule: every table starts its primary key with tenant_id, and child tables point
-- at documents through (tenant_id, document_id), so the database itself refuses a row that
-- links one tenant's data to another tenant's document.

CREATE TABLE documents (
  tenant_id            TEXT    NOT NULL,
  id                   TEXT    NOT NULL,              -- random UUID
  sha256               TEXT    NOT NULL,              -- fingerprint of the uploaded file
  filename             TEXT    NOT NULL,
  mime_type            TEXT    NOT NULL,
  size_bytes           INTEGER NOT NULL CHECK (size_bytes > 0),
  status               TEXT    NOT NULL
                       CHECK (status IN ('converting', 'chunking', 'ready', 'failed')),
  markdown             TEXT,                          -- sanitized text; chunk offsets point here
  chars                INTEGER,                       -- markdown.length (UTF-16 code units)
  hidden_chars_removed INTEGER,                       -- count removed by sanitize (warning sign)
  error                TEXT,
  created_at           TEXT    NOT NULL,              -- ISO 8601, UTC
  PRIMARY KEY (tenant_id, id),
  -- Same file uploaded twice by the same tenant -> same document. Per tenant on purpose: a
  -- global UNIQUE (sha256) would tell tenant B that tenant A already uploaded that file.
  UNIQUE (tenant_id, sha256)
);

CREATE TABLE chunks (
  tenant_id    TEXT    NOT NULL,
  document_id  TEXT    NOT NULL,
  idx          INTEGER NOT NULL CHECK (idx >= 0),     -- position in the document
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset   INTEGER NOT NULL CHECK (end_offset > start_offset),
  text         TEXT    NOT NULL,                      -- = markdown[start_offset:end_offset]
  section_path TEXT    NOT NULL,                      -- JSON array of heading labels
  heading      TEXT,
  PRIMARY KEY (tenant_id, document_id, idx),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE definitions (
  tenant_id    TEXT    NOT NULL,
  document_id  TEXT    NOT NULL,
  idx          INTEGER NOT NULL CHECK (idx >= 0),
  term         TEXT    NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  PRIMARY KEY (tenant_id, document_id, idx),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
