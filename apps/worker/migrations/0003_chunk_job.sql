-- Fencing token for the chunking job: the ID of the one job allowed to write this
-- document's chunks. Each upload that converts a document gives it a new job ID; every write
-- by the chunking Workflow checks it, so a slow, replaced job can no longer change anything
-- (same idea as a JPA @Version column). NULL while no job owns the document.
ALTER TABLE documents ADD COLUMN chunk_job TEXT;
