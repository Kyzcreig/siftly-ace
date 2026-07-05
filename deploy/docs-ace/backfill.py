#!/usr/bin/env python3
"""backfill.py — curated backfill of durable local docs into docs.ace (PRD v1.3 Phase 2).

Takes a human-approved allow-list MANIFEST (JSON) and publishes each entry into docs.ace via
ace_publisher.py. Dry-run by default. Idempotent (same source → same slug, D-2). Reversible
(soft-delete via /api/doc/delete). Cross-path collision check before publishing.

Manifest shape:
  [
    {"path": "docs/plans/PRD-foo.md", "type": "prd", "title": "PRD — Foo", "doc_id": "<optional override>"},
    ...
  ]
Paths are resolved relative to --base (default: cwd). type ∈ prd|report|overview|doc.

Usage:
  backfill.py --manifest approved.json [--base <dir>] [--apply]     # default = dry-run
  backfill.py --scan <dir> --type prd --out proposed.json           # emit a proposed manifest to trim

The identity key (D-2) is the SAME logical rule doc-share's docs-ace backend uses (repo-relative →
vault-relative → realpath), so a doc backfilled here and later re-shared live gets the SAME slug.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERMES = os.path.expanduser("~/.hermes")
ACE_PUB = f"{HERMES}/var/docs-portal/ace_publisher.py"
RENDER = f"{HERMES}/skills-shared/general/doc-share/scripts/render-pretty-doc.sh"
PY = "/opt/homebrew/bin/python3"
VAULT = os.path.expanduser("~/Obsidian")


def logical_id(path: str) -> str:
    """The D-2 identity: repo-relative → vault-relative → realpath. Matches docs-ace.sh."""
    rp = os.path.realpath(path)
    try:
        top = subprocess.run(["git", "-C", os.path.dirname(rp), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=5)
        if top.returncode == 0 and top.stdout.strip():
            root = os.path.realpath(top.stdout.strip())
            return "repo:" + os.path.relpath(rp, root)
    except Exception:
        pass
    vr = os.path.realpath(VAULT)
    if rp.startswith(vr.rstrip("/") + "/"):
        return "vault:" + os.path.relpath(rp, vr)
    return "path:" + rp


def doc_id_for(path: str, override: str | None) -> str:
    if override:
        return override
    return "docshare|" + hashlib.sha1(logical_id(path).encode()).hexdigest()[:12]


def render_md(src: str) -> str:
    """Render a markdown file → HTML via the shared renderer; return the HTML path."""
    fd, out = tempfile.mkstemp(suffix=".html", prefix="backfill-")
    os.close(fd)
    title = os.path.basename(src)
    r = subprocess.run(["bash", RENDER, src, out, title], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise RuntimeError(f"render failed for {src}: {(r.stderr or r.stdout)[-200:]}")
    return out


def publish(html: str, doc_type: str, doc_id: str, title: str) -> str:
    args = [PY, ACE_PUB, "--in", html, "--type", doc_type, "--doc-id", doc_id, "--title", title]
    r = subprocess.run(args, capture_output=True, text=True, timeout=60)
    url = (r.stdout or "").strip().splitlines()[-1] if r.stdout.strip() else ""
    if not url.startswith("https://"):
        raise RuntimeError(f"publish failed for {doc_id}: {(r.stderr or r.stdout)[-200:]}")
    return url


def cmd_scan(args) -> int:
    base = os.path.abspath(args.base)
    scan_dir = os.path.join(base, args.scan) if not os.path.isabs(args.scan) else args.scan
    rows = []
    for root, _dirs, files in os.walk(scan_dir):
        for f in sorted(files):
            if not f.endswith(".md"):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, base)
            # one-line summary = first non-empty heading or line
            title = f[:-3]
            try:
                for line in open(p, encoding="utf-8", errors="replace"):
                    s = line.strip()
                    if s.startswith("# "):
                        title = s[2:].strip()
                        break
            except Exception:
                pass
            rows.append({"path": rel, "type": args.type, "title": title})
    out = args.out or "proposed-manifest.json"
    json.dump(rows, open(out, "w"), indent=2, ensure_ascii=False)
    print(f"proposed manifest: {len(rows)} docs → {out}")
    print("Trim/approve, then: backfill.py --manifest <that> --base " + base + " --apply")
    return 0


def cmd_backfill(args) -> int:
    base = os.path.abspath(args.base)
    manifest = json.load(open(args.manifest))
    if not isinstance(manifest, list):
        print("manifest must be a JSON array", file=sys.stderr)
        return 2

    # cross-path collision check: no two manifest entries derive the same doc_id (D-2/INV-4)
    seen: dict[str, str] = {}
    resolved = []
    for e in manifest:
        src = e["path"] if os.path.isabs(e["path"]) else os.path.join(base, e["path"])
        if not os.path.isfile(src):
            print(f"  SKIP (missing): {e['path']}", file=sys.stderr)
            continue
        did = doc_id_for(src, e.get("doc_id"))
        if did in seen and seen[did] != src:
            print(f"  COLLISION: {e['path']} and {seen[did]} → same doc_id {did}. Fix the manifest.",
                  file=sys.stderr)
            return 3
        seen[did] = src
        resolved.append((e, src, did))

    print(f"{'APPLY' if args.apply else 'DRY-RUN'}: {len(resolved)} docs")
    published = 0
    for e, src, did in resolved:
        title = e.get("title") or os.path.basename(src)
        dtype = e.get("type", "doc")
        if not args.apply:
            print(f"  [dry] {dtype:8} {did}  ←  {os.path.relpath(src, base)}")
            continue
        try:
            html = render_md(src)
            url = publish(html, dtype, did, title)
            os.unlink(html)
            print(f"  ✓ {dtype:8} {url}  ←  {os.path.relpath(src, base)}")
            published += 1
        except Exception as ex:
            print(f"  ✗ {os.path.relpath(src, base)}: {ex}", file=sys.stderr)
    if args.apply:
        print(f"published {published}/{len(resolved)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", help="approved allow-list JSON")
    ap.add_argument("--base", default=os.getcwd(), help="base dir for relative paths (default cwd)")
    ap.add_argument("--apply", action="store_true", help="actually publish (default: dry-run)")
    ap.add_argument("--scan", help="scan a dir for .md → emit a proposed manifest")
    ap.add_argument("--type", default="doc", help="type for scanned docs (prd/report/overview/doc)")
    ap.add_argument("--out", help="proposed manifest output path (with --scan)")
    args = ap.parse_args()
    if args.scan:
        return cmd_scan(args)
    if args.manifest:
        return cmd_backfill(args)
    ap.error("need --manifest or --scan")


if __name__ == "__main__":
    sys.exit(main())
