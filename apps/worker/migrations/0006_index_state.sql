-- M3 indexing state (docs/DECISIONS.md D29). Kept apart from `status`, which stays the
-- ingestion state (converting -> chunking -> ready): a ready document is indexed afterwards,
-- may be re-indexed with a new model, and a failed index does not make the text unusable.
--
--   index_status    NULL (never indexed) | 'indexing' | 'indexed' | 'failed'
--   index_job       ticket of the indexing job that owns the index (fencing, as chunk_job, D20)
--   index_version   embedding model + input variant the vectors were made with (versioning)
--   indexed_chunks  vectors written for this document: the IDs to delete when re-indexing
--                   (Vectorize deletes by ID only) and the count behind the space guard (D25)
--   index_error     why indexing failed, e.g. 'index_full'
ALTER TABLE documents ADD COLUMN index_status TEXT
  CHECK (index_status IN ('indexing', 'indexed', 'failed'));
ALTER TABLE documents ADD COLUMN index_job TEXT;
ALTER TABLE documents ADD COLUMN index_version TEXT;
ALTER TABLE documents ADD COLUMN indexed_chunks INTEGER NOT NULL DEFAULT 0
  CHECK (indexed_chunks >= 0);
ALTER TABLE documents ADD COLUMN index_error TEXT;
