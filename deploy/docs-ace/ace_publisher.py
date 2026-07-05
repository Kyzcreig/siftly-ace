#!/usr/bin/env python3
"""ace_publisher.py — the `ace` publisher driver for docs.ace (PRD v1.3, Phase 1).

Writes a finished static HTML doc into the docs-host webroot under a DETERMINISTIC slug
(D-11: slug = words(hash(doc_identity_key || salt)), salt-escalated on cross-identity
collision), embeds a per-publish content marker (docs-ace-id), self-verifies the minted
URL returns 200 + that marker (I3), and prints ONLY the URL on stdout (diagnostics → stderr).

Contract (I7): publish(html, title, date, type) -> prints <slug>.docs.ace URL.
CLI:
  ace_publisher.py --in <file.html> --type briefs --doc-id "morning-digest|2026-07-02" [--title T]
Exit non-zero + empty stdout on any failure (so callers fall through to their fallback, I3).

The (doc_identity_key -> slug, salt) binding is persisted in a small JSON index
(DOCS_INDEX_JSON, default ~/.hermes/var/docs-portal/bindings.json) so a retry re-derives the
exact prior slug across restarts, and a cross-identity collision salt-escalates without
overwrite (D-11 / D-12 durability).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("DOCS_ROOT", os.path.expanduser("~/.hermes/var/docs-portal/docroot")))
BINDINGS = Path(os.environ.get("DOCS_INDEX_JSON", os.path.expanduser("~/.hermes/var/docs-portal/bindings.json")))
HOST_IP = os.environ.get("DOCS_HOST_IP", "192.168.1.18")

# here.now-style two-word slug vocabulary (adjectives + nouns).
ADJ = ["ancient","amber","azure","bold","bright","calm","cobalt","coral","crimson","dusky",
       "eager","ember","fable","faded","gilded","golden","hidden","hollow","ivory","jade",
       "keen","lunar","marine","mellow","misty","noble","olive","opal","pale","quartz",
       "quiet","rapid","russet","sable","scarlet","silent","solar","stellar","stormy","teal",
       "umber","velvet","vivid","warm","wild","zephyr","frosted","hazel","indigo","lilac"]
NOUN = ["arbor","bamboo","birch","brook","canyon","cedar","cinder","comet","cove","crest",
        "delta","dune","ember","fern","flame","fjord","glade","grove","harbor","haven",
        "heron","inlet","isle","lagoon","larch","linden","meadow","monsoon","moss","oasis",
        "petal","pine","plover","quartz","reef","ridge","river","scroll","spark","tangle",
        "thicket","tide","trellis","vale","warden","willow","wren","zephyr","aspen","maple"]


def _err(*a):
    print(*a, file=sys.stderr)


def load_bindings() -> dict:
    if BINDINGS.is_file():
        try:
            return json.loads(BINDINGS.read_text())
        except Exception:
            return {}
    return {}


def save_bindings(b: dict):
    BINDINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = BINDINGS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(b, indent=2, sort_keys=True))
    os.replace(tmp, BINDINGS)  # atomic


def slug_for(doc_id: str, salt: int) -> str:
    h = hashlib.sha256(f"{doc_id}\x00{salt}".encode()).digest()
    a = ADJ[h[0] % len(ADJ)]
    n = NOUN[h[1] % len(NOUN)]
    tag = h[2:4].hex()  # 4 hex chars, like here.now, widens the namespace
    return f"{a}-{n}-{tag}"


def resolve_slug(doc_id: str, bindings: dict) -> str:
    """Deterministic per doc_id; salt-escalate only on a genuine cross-identity dir collision."""
    if doc_id in bindings:
        return bindings[doc_id]["slug"]
    # find a free slug (or one already owned by this doc_id — can't happen here since not in bindings)
    salt = 0
    taken_slugs = {v["slug"]: k for k, v in bindings.items()}
    while True:
        s = slug_for(doc_id, salt)
        owner = taken_slugs.get(s)
        d_exists = any((t / s).is_dir() for t in ROOT.iterdir()) if ROOT.is_dir() else False
        if owner is None and not d_exists:
            return s
        if owner == doc_id:
            return s
        salt += 1  # cross-identity collision → escalate


DOC_ID_META = '<meta name="docs-ace-id" content="{}">'


def inject_marker(html: str, marker: str) -> str:
    """Embed the docs-ace-id marker into <head> (or prepend if no head). Idempotent-ish.

    NB: the 'already present' check must match a REAL <meta ...> tag, not the bare attribute
    string — a doc whose PROSE documents the marker system (e.g. this system's own PRD renders
    an escaped `&lt;meta name="docs-ace-id" ...&gt;` code span) contains `name="docs-ace-id"`
    without a real tag, and a loose `in html` check would (a) think the marker exists and (b)
    fail to replace it → publish a markerless page that fails self-verify. Anchor on `<meta `.
    """
    tag = DOC_ID_META.format(marker)
    if re.search(r'<meta\s+name="docs-ace-id"\s+content="[^"]*"\s*/?>', html):
        return re.sub(r'<meta\s+name="docs-ace-id"\s+content="[^"]*"\s*/?>', tag, html, count=1)
    if "<head>" in html:
        return html.replace("<head>", "<head>" + tag, 1)
    if re.search(r"<head[^>]*>", html):
        return re.sub(r"(<head[^>]*>)", r"\1" + tag, html, count=1)
    # no head — prepend
    return tag + html


def publish(html: str, doc_id: str, type_: str, title: str | None) -> str:
    bindings = load_bindings()
    slug = resolve_slug(doc_id, bindings)
    marker = hashlib.sha256(doc_id.encode()).hexdigest()[:16]

    out_dir = ROOT / type_ / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    final_html = inject_marker(html, marker)
    # Phase 3: inject like/bookmark buttons into X items (SERVED copy only; Share strips them).
    try:
        import inject_x_buttons
        final_html, _nbtn = inject_x_buttons.inject(final_html)
    except Exception as e:
        _err(f"button injection skipped: {e}")
    # atomic-ish write
    tmp = out_dir / "index.html.tmp"
    tmp.write_text(final_html, encoding="utf-8")
    os.replace(tmp, out_dir / "index.html")

    # record binding (durable, D-12)
    bindings[doc_id] = {"slug": slug, "type": type_, "marker": marker,
                        "title": title or "", "updated": int(time.time())}
    save_bindings(bindings)

    # index for the portal + FTS search (D-12/D-13). Index the PRE-button HTML body
    # (buttons are UI, not content). Fail-safe: indexing never blocks a publish.
    try:
        import docs_index
        docs_index.upsert(doc_id, slug, type_, title or "", marker, html, kind="html")
    except Exception as e:
        _err(f"index upsert skipped: {e}")

    url = f"https://{slug}.docs.ace/"
    # I3 self-verify: 200 + the content marker (catches mint-but-404 AND mint-but-wrong-content).
    if not self_verify(slug, marker):
        raise RuntimeError(f"self-verify failed for {url} (not 200 or marker missing)")
    return url


def self_verify(slug: str, marker: str, timeout: float = 8.0) -> bool:
    """Fetch the minted URL and confirm 200 + marker. Uses curl --resolve so SNI = the slug
    hostname (Caddy routes by SNI) while connecting to the host IP; --cacert trusts the Ace CA."""
    import subprocess
    host = f"{slug}.docs.ace"
    ca = os.path.expanduser("~/.hermes/var/skills-portal/public/Ace-Local-Root-CA.crt")
    cmd = ["curl", "-s", "--max-time", str(int(timeout)),
           "--resolve", f"{host}:443:{HOST_IP}",
           "-w", "\n__HTTP__%{http_code}"]
    if os.path.isfile(ca):
        cmd += ["--cacert", ca]
    else:
        cmd += ["-k"]
    cmd.append(f"https://{host}/")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 4)
        out = r.stdout
        code = ""
        if "__HTTP__" in out:
            out, code = out.rsplit("__HTTP__", 1)
            code = code.strip()
        if code != "200":
            _err(f"self-verify: HTTP {code or '(none)'}")
            return False
        if marker not in out:
            _err("self-verify: 200 but content marker missing (stale/wrong doc served)")
            return False
        return True
    except Exception as e:
        _err(f"self-verify: request failed: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--type", default="docs")
    ap.add_argument("--doc-id", required=True, help="the doc_identity_key (D-11), e.g. 'morning-digest|2026-07-02'")
    ap.add_argument("--title", default=None)
    ap.add_argument("--no-verify", action="store_true", help="skip self-verify (host not running yet)")
    a = ap.parse_args()
    try:
        html = Path(a.infile).read_text(encoding="utf-8")
    except Exception as e:
        _err(f"cannot read {a.infile}: {e}"); return 2
    try:
        if a.no_verify:
            global self_verify
            self_verify = lambda *args, **kw: True  # noqa: E731
        url = publish(html, a.doc_id, a.type, a.title)
    except Exception as e:
        _err(f"publish failed: {e}"); return 1
    print(url)  # ONLY the URL on stdout
    return 0


if __name__ == "__main__":
    sys.exit(main())
