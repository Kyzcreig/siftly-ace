#!/usr/bin/env python3
"""docs_index.py — the durable docs.ace index (D-12) + FTS5 full-text search (D-13).

sqlite with an FTS5 virtual table over doc BODIES + a metadata table carrying the D-11
slug/salt binding and the I10 share->here.now mapping. Load-bearing (three invariants depend
on it), so it lives on local disk and is backed up. Body index lives ONLY here (I9), never in
a shared copy.

Schema:
  docs(doc_id PK, slug, type, title, marker, created, updated, herenow_slug, deleted)
  fts(slug, title, body)   -- FTS5, external-content-free (we store the searchable text)
"""
from __future__ import annotations

import os
import re
import sqlite3
import time

DB = os.environ.get("DOCS_INDEX_DB", os.path.expanduser("~/.hermes/var/docs-portal/index.db"))


def _conn():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE IF NOT EXISTS docs(
        doc_id TEXT PRIMARY KEY, slug TEXT UNIQUE, type TEXT, title TEXT,
        marker TEXT, created INTEGER, updated INTEGER,
        herenow_slug TEXT, deleted INTEGER DEFAULT 0, kind TEXT DEFAULT 'html')""")
    # migrate: add kind column if an older DB lacks it
    cols = [r[1] for r in c.execute("PRAGMA table_info(docs)").fetchall()]
    if "kind" not in cols:
        c.execute("ALTER TABLE docs ADD COLUMN kind TEXT DEFAULT 'html'")
    c.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(slug, title, body)")
    return c


def _text_of(html: str) -> str:
    """Strip tags/scripts/styles → searchable body text."""
    html = re.sub(r"<script.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<style.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    txt = re.sub(r"<[^>]+>", " ", html)
    txt = re.sub(r"&[a-z]+;", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


def upsert(doc_id: str, slug: str, type_: str, title: str, marker: str, body_html: str, kind: str = "html"):
    c = _conn()
    now = int(time.time())
    row = c.execute("SELECT created FROM docs WHERE doc_id=?", (doc_id,)).fetchone()
    created = row[0] if row else now
    c.execute("""INSERT INTO docs(doc_id,slug,type,title,marker,created,updated,deleted,kind)
                 VALUES(?,?,?,?,?,?,?,0,?)
                 ON CONFLICT(doc_id) DO UPDATE SET
                   slug=excluded.slug, type=excluded.type, title=excluded.title,
                   marker=excluded.marker, updated=excluded.updated, deleted=0, kind=excluded.kind""",
              (doc_id, slug, type_, title, marker, created, now, kind))
    c.execute("DELETE FROM fts WHERE slug=?", (slug,))
    c.execute("INSERT INTO fts(slug,title,body) VALUES(?,?,?)", (slug, title, _text_of(body_html)))
    c.commit(); c.close()


def set_herenow(doc_id: str, herenow_slug: str | None):
    c = _conn()
    c.execute("UPDATE docs SET herenow_slug=? WHERE doc_id=?", (herenow_slug, doc_id))
    c.commit(); c.close()


def soft_delete(slug: str) -> bool:
    c = _conn()
    r = c.execute("UPDATE docs SET deleted=1 WHERE slug=?", (slug,))
    c.execute("DELETE FROM fts WHERE slug=?", (slug,))
    c.commit(); n = r.rowcount; c.close()
    return n > 0


def get_by_slug(slug: str) -> dict | None:
    c = _conn()
    r = c.execute("SELECT doc_id,slug,type,title,marker,created,updated,herenow_slug,deleted,kind FROM docs WHERE slug=?",
                  (slug,)).fetchone()
    c.close()
    if not r:
        return None
    k = ["doc_id","slug","type","title","marker","created","updated","herenow_slug","deleted","kind"]
    return dict(zip(k, r))


def list_docs(include_deleted=False) -> list[dict]:
    c = _conn()
    q = "SELECT doc_id,slug,type,title,created,updated,herenow_slug,deleted,kind FROM docs"
    if not include_deleted:
        q += " WHERE deleted=0"
    q += " ORDER BY updated DESC"
    rows = c.execute(q).fetchall()
    c.close()
    k = ["doc_id","slug","type","title","created","updated","herenow_slug","deleted","kind"]
    return [dict(zip(k, r)) for r in rows]


def search(query: str, limit: int = 50) -> list[dict]:
    """FTS5 body search. Returns matching non-deleted doc cards."""
    q = (query or "").strip()
    if not q:
        return list_docs()[:limit]
    terms = re.findall(r"[A-Za-z0-9_]+", q)
    if not terms:
        return []
    match = " ".join(f'"{t}"*' for t in terms)
    c = _conn()
    try:
        rows = c.execute(
            """SELECT d.doc_id,d.slug,d.type,d.title,d.created,d.updated,d.herenow_slug,d.kind
               FROM fts JOIN docs d ON d.slug=fts.slug
               WHERE fts MATCH ? AND d.deleted=0
               ORDER BY rank LIMIT ?""", (match, limit)).fetchall()
    except sqlite3.OperationalError:
        rows = []
    c.close()
    k = ["doc_id","slug","type","title","created","updated","herenow_slug","kind"]
    return [dict(zip(k, r)) for r in rows]


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) >= 3 and sys.argv[1] == "search":
        print(json.dumps(search(sys.argv[2]), indent=2))
    else:
        print(json.dumps(list_docs(), indent=2))
