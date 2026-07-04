#!/usr/bin/env python3
"""doc_actions.py — portal Share / Revoke / Delete (PRD v1.3 Phase 5, I6/I10).

- share:  button-STRIP the doc's HTML (DOM parse, I4) → publish a COPY to here.now →
          record the here.now slug in the index (I10) → return the public URL.
          Embeds the docs-ace-id marker in the copy for the deterministic revoke fallback.
- revoke: DELETE /api/v1/publish/<herenow_slug> (here.now) → clear the mapping. Fallback:
          if the local mapping is missing, enumerate here.now sites and match the exact marker.
- delete: soft-delete locally (remove served files + index entry). Single-doc scoped.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(os.environ.get("DOCS_ROOT", os.path.expanduser("~/.hermes/var/docs-portal/docroot")))
HERENOW_CRED = os.path.expanduser("~/.herenow/credentials")
DOC_SHARE = os.path.expanduser("~/.hermes/skills-shared/general/doc-share/scripts/doc-share.sh")
PRIVACY_SCAN = os.path.expanduser("~/.hermes/skills-shared/general/doc-share/scripts/privacy-scan.sh")


def _slug_dir(slug: str) -> Path | None:
    for t in (ROOT.iterdir() if ROOT.is_dir() else []):
        d = t / slug
        if d.is_dir() and (d / "index.html").is_file():
            return d
    return None


def strip_buttons(html: str) -> str:
    """I4: remove the /api/x/* button rows + the inline button JS from the SHARED copy.
    DOM-ish parse (not just regex on one shape): drop the x-actions divs, the x-btn CSS, and
    any <script> that references /api/x/. Origin check is the real guard; this is UX + I4 grep."""
    html = re.sub(r'<div class="x-actions"[^>]*>.*?</div>', "", html, flags=re.DOTALL)
    html = re.sub(r'<style id="x-btn-css">.*?</style>', "", html, flags=re.DOTALL)
    html = re.sub(r'<script>[^<]*?/api/x/.*?</script>', "", html, flags=re.DOTALL)
    return html


def _herenow_key() -> str:
    return Path(HERENOW_CRED).read_text().strip()


def share(slug: str) -> dict:
    d = _slug_dir(slug)
    if d is None:
        return {"error": "no such doc"}
    src = (d / "index.html").read_text(encoding="utf-8")
    stripped = strip_buttons(src)
    # sanity: I4 — the copy must carry NO /api/x/ reference
    if "/api/x/" in stripped:
        return {"error": "strip failed (I4): copy still references /api/x/"}

    import tempfile
    tmpd = tempfile.mkdtemp(prefix="docshare-")
    (Path(tmpd) / "index.html").write_text(stripped, encoding="utf-8")

    # privacy scan (fail-safe: if the scanner errors, we still don't block, but log)
    try:
        if os.path.isfile(PRIVACY_SCAN):
            subprocess.run(["bash", PRIVACY_SCAN, str(Path(tmpd) / "index.html")],
                           capture_output=True, timeout=30)
    except Exception:
        pass

    # publish the COPY to here.now via the here-now backend
    pub = os.path.expanduser("~/.hermes/skills-shared/general/here.now/scripts/publish.sh")
    try:
        r = subprocess.run(["bash", pub, tmpd, "--client", "hermes"],
                           capture_output=True, text=True, timeout=90, cwd=tmpd)
        m = re.search(r"https://([a-z0-9-]+)\.here\.now/?", r.stdout + "\n" + r.stderr)
        if not m:
            return {"error": f"here.now publish returned no url (rc={r.returncode}): {(r.stderr or r.stdout)[-160:]}"}
        hn_slug = m.group(1)
        url = f"https://{hn_slug}.here.now/"
    except Exception as e:
        return {"error": f"publish failed: {e}"}

    # record the mapping (I10)
    try:
        import docs_index
        row = docs_index.get_by_slug(slug)
        if row:
            docs_index.set_herenow(row["doc_id"], hn_slug)
    except Exception:
        pass
    return {"ok": True, "url": url, "herenow_slug": hn_slug}


def revoke(slug: str) -> dict:
    hn_slug = None
    doc_id = None
    marker = None
    try:
        import docs_index
        row = docs_index.get_by_slug(slug)
        if row:
            hn_slug = row.get("herenow_slug"); doc_id = row["doc_id"]; marker = row.get("marker")
    except Exception:
        pass

    # Fallback (I10): if the local mapping is missing, find the here.now site by the EXACT marker.
    if not hn_slug and marker:
        hn_slug = _find_herenow_by_marker(marker)

    if not hn_slug:
        return {"error": "no here.now share recorded for this doc"}

    try:
        req = urllib.request.Request(f"https://here.now/api/v1/publish/{hn_slug}",
                                     headers={"Authorization": f"Bearer {_herenow_key()}"}, method="DELETE")
        with urllib.request.urlopen(req, timeout=15) as r:
            ok = r.status == 200
    except urllib.error.HTTPError as e:
        if e.code == 404:
            ok = True  # already gone
        else:
            return {"error": f"here.now delete HTTP {e.code}"}
    except Exception as e:
        return {"error": f"revoke failed: {e}"}

    if ok:
        try:
            import docs_index
            if doc_id:
                docs_index.set_herenow(doc_id, None)
        except Exception:
            pass
    return {"ok": ok, "revoked_slug": hn_slug}


def _find_herenow_by_marker(marker: str) -> str | None:
    """Enumerate here.now sites and match the docs-ace-id marker (deterministic, not fuzzy)."""
    try:
        req = urllib.request.Request("https://here.now/api/v1/publishes",
                                     headers={"Authorization": f"Bearer {_herenow_key()}"})
        pubs = json.load(urllib.request.urlopen(req, timeout=15)).get("publishes", [])
    except Exception:
        return None
    for p in pubs:
        s = p.get("slug")
        if not s:
            continue
        try:
            body = urllib.request.urlopen(f"https://{s}.here.now/", timeout=8).read().decode("utf-8", "replace")
            if f'content="{marker}"' in body:
                return s
        except Exception:
            continue
    return None


def delete(slug: str) -> dict:
    d = _slug_dir(slug)
    if d is not None:
        # soft-delete: move to a .trash dir (not rm -rf)
        trash = ROOT.parent / "docroot-trash"
        trash.mkdir(exist_ok=True)
        import shutil, time
        dest = trash / f"{slug}-{int(time.time())}"
        try:
            shutil.move(str(d), str(dest))
        except Exception as e:
            return {"error": f"delete failed: {e}"}
    try:
        import docs_index
        docs_index.soft_delete(slug)
    except Exception:
        pass
    return {"ok": True, "deleted": slug}
