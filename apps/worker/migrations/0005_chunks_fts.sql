-- M3 keyword search (docs/DECISIONS.md D28): an FTS5 index over chunk text.
--
-- Columns, in this order (bm25() weights follow it: text 1.0, tenant 0.0, doc 0.0):
--   text    the chunk text, searched;
--   tenant  ftsScopeToken(tenant_id), doc  ftsScopeToken(document_id): one token each, used
--           only as filters inside MATCH, so a search never leaves its tenant and document
--           and FTS5 does not score the whole table first (D27);
--   idx     the chunk's position, not indexed: hits are read back from `chunks` by its
--           primary key (tenant_id, document_id, idx), never by FTS rowid alone.
--
-- 'porter unicode61': English stemming on top of the default tokenizer, so "governs" finds
-- "governed" (measured on CUAD, D26). detail=full (the default) keeps word positions; the
-- measured storage difference to detail=column was small, and detail=none cannot filter by
-- column at all.
--
-- Rows are written by the indexing job (M3 step 5), not by triggers: the chunking job uses
-- INSERT OR REPLACE, and a replace does not fire DELETE triggers in SQLite unless
-- recursive_triggers is on, which would leave stale entries. A virtual table also takes no
-- part in ON DELETE CASCADE, so deleting a document must delete its rows here explicitly.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  tenant,
  doc,
  idx UNINDEXED,
  tokenize = 'porter unicode61'
);
