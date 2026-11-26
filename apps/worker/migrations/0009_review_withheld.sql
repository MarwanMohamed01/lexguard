-- M5 step 9 (docs/DECISIONS.md D53): contract sentences that read like instructions to an AI
-- are withheld from the checker; how many of a rule's top passages were withheld is recorded,
-- so a person can look at them (each may be an attack, or a false alarm such as a list item).
ALTER TABLE review_claims ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld >= 0);
