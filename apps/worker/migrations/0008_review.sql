-- M5 review (docs/DECISIONS.md D52). Same pattern as extraction (0007): a state kept apart
-- from `status`, with a fencing ticket.
--
--   review_status   NULL (never) | 'reviewing' | 'reviewed' | 'failed'
--   review_job      ticket of the review job that owns the claims (fencing, D20)
--   review_version  model + checker prompt + verifier version the claims were made with
--   review_error    why the review failed, e.g. 'daily_budget'
--   review_scope    the rules of the current review and their policy, as requested and
--                   validated: JSON [{"ruleId": "gdpr:28(3)(a)", "policy": "require"}, ...]
ALTER TABLE documents ADD COLUMN review_status TEXT
  CHECK (review_status IN ('reviewing', 'reviewed', 'failed'));
ALTER TABLE documents ADD COLUMN review_job TEXT;
ALTER TABLE documents ADD COLUMN review_version TEXT;
ALTER TABLE documents ADD COLUMN review_error TEXT;
ALTER TABLE documents ADD COLUMN review_scope TEXT;

-- One row per rule of the review: what the checker said and what the verifier decided.
-- Evidence text is NOT stored: it is the chunk's text at the offsets (as for clauses, 0007),
-- so a stored claim can only ever point at text the document really has.
--   outcome   'verified' | 'rejected' (by the verifier, see problems) | the model's answer
--             could not be used: 'not_json' | 'schema' | 'too_large'
--   evidence  JSON [{"chunk": idx, "start": doc offset, "end": doc offset}]
--   rule_quote JSON {"start", "end"} in the rule's text, or NULL
--   reason    the checker's one-sentence note: written by a model that read the contract,
--             untrusted, shown as an unverified note only (T1)
--   refs      JSON section references in the evidence, resolved by the verifier (D50)
CREATE TABLE review_claims (
  tenant_id   TEXT    NOT NULL,
  document_id TEXT    NOT NULL,
  rule_id     TEXT    NOT NULL,
  outcome     TEXT    NOT NULL
              CHECK (outcome IN ('verified', 'rejected', 'not_json', 'schema', 'too_large')),
  verdict     TEXT    CHECK (verdict IN ('agrees', 'conflicts', 'silent')),
  claimed     TEXT    CHECK (claimed IN ('agrees', 'conflicts', 'silent')),
  evidence    TEXT    NOT NULL,
  rule_quote  TEXT,
  reason      TEXT,
  refs        TEXT    NOT NULL,
  problems    TEXT    NOT NULL,
  passages    INTEGER NOT NULL CHECK (passages >= 0),
  neurons     REAL    NOT NULL CHECK (neurons >= 0),
  PRIMARY KEY (tenant_id, document_id, rule_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
