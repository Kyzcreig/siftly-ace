CREATE TABLE IF NOT EXISTS cross_brief_seen (
  pt_day TEXT NOT NULL,
  url_canon_hash TEXT NOT NULL,
  title_minhash TEXT NOT NULL,
  brief TEXT NOT NULL,
  surfaced_at TEXT NOT NULL,
  PRIMARY KEY (pt_day, url_canon_hash)
);

CREATE INDEX IF NOT EXISTS idx_cross_brief_seen_pt_day
  ON cross_brief_seen(pt_day);
