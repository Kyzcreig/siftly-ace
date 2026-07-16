#!/usr/bin/env python3
"""check-csp-invariant.py — static contract test for the docs.ace strict-CSP media-src invariant.

WHY THIS EXISTS: brief pages carry the `.strict` marker (X like/bookmark buttons force strict
CSP), so their embedded X videos (`video.twimg.com`) only play if the strict CSP grants a
`media-src` for that host. Without it the browser silently blocks the clip (falls back to
`default-src 'none'`) and the video shows "Unable to play media" — poster only, dead player.
This regressed on 2026-07-15 because the fix lived in the COMMITTED docs_host.py but the LIVE
file had drifted (revert/skipped deploy). This test guards BOTH failure modes:

  1. SOURCE:  the committed docs_host.py strict CSP constant must contain
              `media-src ... video.twimg.com`  → a `git revert` of the fix fails here.
  2. DRIFT:   the LIVE docs_host.py must byte-match the committed strict-CSP line → a live-only
              revert / skipped deploy fails here (the exact 2026-07-15 failure).

Run after touching docs_host.py's CSP, or as a pre-deploy gate. Exit 0 = pass, 1 = fail.
The RUNTIME counterpart (asserts the actually-SERVED header every 30m) is
`docs-ace-canary.py::check_brief_media_csp`. Belt (source) + suspenders (served).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COMMITTED = os.path.join(HERE, "docs_host.py")
LIVE = os.path.expanduser("~/.hermes/var/docs-portal/docs_host.py")

# The strict CSP block is the CSP=(...) assignment BEFORE the INTERACTIVE_CSP assignment.
_CSP_RE = re.compile(r"^CSP\s*=\s*\((.*?)\)", re.DOTALL | re.MULTILINE)


def _strict_csp_text(path):
    src = open(path).read()
    # take the CSP=(...) that comes before INTERACTIVE_CSP
    head = src.split("INTERACTIVE_CSP")[0]
    m = _CSP_RE.search(head)
    return m.group(1) if m else ""


def main():
    fails = []

    # (1) SOURCE invariant on the committed copy
    if not os.path.isfile(COMMITTED):
        fails.append(f"committed docs_host.py not found: {COMMITTED}")
    else:
        csp = _strict_csp_text(COMMITTED).lower()
        if "media-src" not in csp or "video.twimg.com" not in csp:
            fails.append("committed docs_host.py strict CSP is MISSING "
                         "`media-src ... video.twimg.com` — X brief videos will not play "
                         "(fix was reverted?)")

    # (2) DRIFT: live strict-CSP block must equal committed (the 2026-07-15 failure)
    if os.path.isfile(LIVE) and os.path.isfile(COMMITTED):
        live_csp = _strict_csp_text(LIVE).strip()
        comm_csp = _strict_csp_text(COMMITTED).strip()
        if live_csp != comm_csp:
            fails.append("LIVE docs_host.py strict CSP has DRIFTED from the committed copy — "
                         "redeploy the committed docs_host.py + restart ai.hermes.docs-host "
                         "(this is the exact 2026-07-15 regression).")
    elif not os.path.isfile(LIVE):
        print(f"note: live docs_host.py not present ({LIVE}); source check only.", file=sys.stderr)

    if fails:
        print("FAIL: docs.ace strict-CSP media-src invariant\n" +
              "\n".join(f"  • {f}" for f in fails))
        return 1
    print("PASS: docs.ace strict CSP grants media-src for video.twimg.com "
          "(committed + live in sync)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
