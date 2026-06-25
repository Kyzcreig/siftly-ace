#!/usr/bin/env python3
"""footer_build.py — the SINGLE source of truth for the Discord/report footer of
BOTH briefs (morning-digest + x-feed-brief). Ace's ask (2026-06-24): both briefs
should list their sources the same prettified way, and stop drifting apart.

The drift existed because each brief hand-composed its footer as free-text. This
script owns the FORMAT deterministically; each brief feeds it only real numbers.

Format (Ace picked "Candidate A", 2026-06-24) — three lines:

    📡 274 scanned · 202 new · 72 filtered
    📥 X 115 · Reddit 100 · HN 29 · GitHub 16 · Perplexity 10 · Latent Space 3 · smol.ai 1
    ⚙️ deterministic scoring · personal-fit ✓

The 📥 source line lists whatever sources THAT brief drew from, sorted by volume
desc, zero-count sources omitted, thousands-separated. X-feed (X-only: timeline +
search channels) renders `📥 Timeline 1,626 · Search 60`.

Input: a counts JSON (file via --in, or stdin). Shape:
    {
      "scanned": 274, "new": 202, "filtered": 72,   # funnel (any may be null → omitted)
      "sources": [["X",115],["Reddit",100], ...],    # ordered or unordered; sorted here
      "pf_ok": true                                   # personal-fit merged cleanly
    }
Output: the 3-line block on stdout (no trailing newline). FAIL-SAFE: a missing or
malformed field degrades that ONE segment gracefully (never raises for the caller);
a totally empty/invalid input prints nothing and exits 0 so the brief still posts.
"""
import argparse
import json
import sys


def _fmt_int(n):
    """Thousands-separated integer, or None if not a real number."""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return None


def _funnel_line(counts):
    """📡 <scanned> scanned · <new> new · <filtered> filtered — omit missing parts."""
    parts = []
    s = _fmt_int(counts.get("scanned"))
    if s is not None:
        parts.append(f"{s} scanned")
    n = _fmt_int(counts.get("new"))
    if n is not None:
        parts.append(f"{n} new")
    f = _fmt_int(counts.get("filtered"))
    if f is not None:
        parts.append(f"{f} filtered")
    return "📡 " + " · ".join(parts) if parts else None


def _sources_line(counts):
    """📥 <Name> <count> · ... — nonzero only, sorted by count desc, then name."""
    raw = counts.get("sources") or []
    pairs = []
    for entry in raw:
        try:
            name, cnt = entry[0], int(entry[1])
        except (TypeError, ValueError, IndexError):
            continue
        if cnt > 0 and str(name).strip():
            pairs.append((str(name).strip(), cnt))
    if not pairs:
        return None
    pairs.sort(key=lambda x: (-x[1], x[0].lower()))
    return "📥 " + " · ".join(f"{n} {c:,}" for n, c in pairs)


def _scoring_line(counts):
    """⚙️ deterministic scoring · personal-fit ✓/—."""
    pf = counts.get("pf_ok")
    if pf is True:
        return "⚙️ deterministic scoring · personal-fit ✓"
    if pf is False:
        return "⚙️ deterministic scoring · personal-fit —"
    return "⚙️ deterministic scoring"


def build_footer(counts):
    """Compose the 3-line footer from a counts dict. Returns a string (may be empty)."""
    if not isinstance(counts, dict):
        return ""
    lines = [ln for ln in (_funnel_line(counts), _sources_line(counts),
                           _scoring_line(counts)) if ln]
    return "\n".join(lines)


def _selftest():
    fails = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    # Morning (multi-source): all three lines, sources sorted desc, thousands-sep.
    m = build_footer({
        "scanned": 274, "new": 202, "filtered": 72, "pf_ok": True,
        "sources": [["Perplexity", 10], ["HN", 29], ["smol.ai", 1],
                    ["Latent Space", 3], ["X", 1150], ["Reddit", 100], ["GitHub", 16]],
    })
    ml = m.split("\n")
    check(len(ml) == 3, f"morning not 3 lines: {ml!r}")
    check(ml[0] == "📡 274 scanned · 202 new · 72 filtered", f"funnel wrong: {ml[0]!r}")
    check(ml[1].startswith("📥 X 1,150 · Reddit 100 · HN 29 · GitHub 16 · Perplexity 10"),
          f"sources not sorted/sep: {ml[1]!r}")
    check("smol.ai 1" in ml[1], "lowest source dropped")
    check(ml[2] == "⚙️ deterministic scoring · personal-fit ✓", f"scoring wrong: {ml[2]!r}")

    # X-feed (X-only channels): same grammar, two channels.
    x = build_footer({
        "scanned": 1686, "new": 1683, "filtered": None, "pf_ok": True,
        "sources": [["Timeline", 1626], ["Search", 60]],
    })
    xl = x.split("\n")
    check(xl[0] == "📡 1,686 scanned · 1,683 new", f"x funnel wrong (filtered omitted): {xl[0]!r}")
    check(xl[1] == "📥 Timeline 1,626 · Search 60", f"x sources wrong: {xl[1]!r}")

    # Zero-count sources omitted.
    z = build_footer({"scanned": 5, "sources": [["X", 5], ["Reddit", 0]], "pf_ok": False})
    check("Reddit" not in z, "zero-count source not omitted")
    check("personal-fit —" in z, "pf_ok False not rendered")

    # Fail-safe: empty / malformed → empty string, no raise.
    check(build_footer({}) == "⚙️ deterministic scoring", "empty dict should still give scoring line")
    check(build_footer(None) == "", "None should give empty string")
    check(build_footer({"sources": "garbage", "scanned": "x"}) == "⚙️ deterministic scoring",
          "malformed fields should degrade gracefully")

    if fails:
        print("FOOTER SELFTEST FAILED:")
        for f in fails:
            print("  -", f)
        return 1
    print("footer_build selftest OK")
    print("  morning:\n" + "\n".join("    " + l for l in ml))
    print("  x-feed:\n" + "\n".join("    " + l for l in xl))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Deterministic shared footer builder for both briefs.")
    ap.add_argument("--in", dest="inp", default=None, help="counts JSON file (default: stdin)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(_selftest())

    try:
        raw = open(args.inp).read() if args.inp else sys.stdin.read()
        counts = json.loads(raw) if raw.strip() else {}
    except Exception:
        # Fail-safe: unreadable input → print nothing, exit 0 (brief still posts).
        sys.exit(0)

    sys.stdout.write(build_footer(counts))


if __name__ == "__main__":
    main()
