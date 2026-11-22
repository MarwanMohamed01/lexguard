-- When a document last changed status. Lets an upload reclaim a document stuck in
-- 'converting' (its request died mid-way, e.g. killed or timed out) instead of the same file
-- being blocked forever by UNIQUE (tenant_id, sha256). NULL means "never changed since
-- created_at".
ALTER TABLE documents ADD COLUMN updated_at TEXT;
