-- Where each PDF page starts in the stored text: a JSON array of offsets (index 0 = page 1),
-- or NULL when the converter's output had no recognisable page markers (src/pages.ts). Lets a
-- citation's offset be shown as a page number.
ALTER TABLE documents ADD COLUMN page_starts TEXT;
