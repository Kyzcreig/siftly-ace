#!/usr/bin/env python3
"""
render_digest.py — deterministic renderer for the morning-digest Discord post.

WHY THIS EXISTS
---------------
The morning-digest cron asks the model to WRITE two distinct fields per story
(a <headline> and a distinct <1-sentence why-it-matters>). Unlike x-feed-brief
(which pastes tweet text VERBATIM and therefore can't drift), this dual-synthesis
task lets a lazy/weak model fill both slots with the same source text — producing
the "<headline> — <headline re-truncated>" echo bug, and sometimes inventing its
own off-template format ("@handle flags <headline> — ...").

Fix: take RENDERING away from the model. The model still owns scoring/selection
and emits a small structured JSON manifest. THIS script deterministically:
  1. drops any summary that just repeats its headline (substring-equal or
     >40% word overlap) — the model can no longer ship the echo,
  2. Discord-markdown-escapes every model/source-derived string,
  3. computes grade emoji + source suffix from the data (not the model's prose),
  4. assembles the exact body and (optionally) posts it via notify.py.

Model owns judgement; Python owns format. Render variance becomes impossible.

INPUT  (default ~/.hermes/state/cron/morning-digest/_render_input.json):
{
  "date_label": "Wednesday, June 10",      # optional; derived from ts if absent
  "ts": "2026-06-10T11:55:43-07:00",        # optional, for date derivation
  "selected": [                              # Top Stories (0..5)
    {
      "title":   "<headline>",               # required
      "summary": "<why it matters>",         # optional; dropped if it echoes title
      "source":  "X",                        # X|HN|smol.ai|Latent Space|Perplexity
      "score":   100,                         # required int 0..100 -> grade emoji
      "url":     "https://...",               # required
      "authorHandle": "NothingDevo",          # for X suffix
      "hn_points": 120, "hn_comments": 34     # for HN suffix
    }, ...
  ],
  "also": [ {same shape} ],                  # Also Noted (0..N)
  "footer": "147 scanned (...) · caps applied",  # stats line text (no surrounding *)
  "empty_note": null                          # if set, render the no-stories husk line
}

USAGE
-----
  render_digest.py --in PATH --out PATH            # compose, write body, print it
  render_digest.py --post --target <channel_id>    # also post via notify.py
  render_digest.py --selftest                       # run built-in checks
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys, datetime

DIGEST_DIR = os.path.expanduser("~/.hermes/state/cron/morning-digest")
DEFAULT_IN = os.path.join(DIGEST_DIR, "_render_input.json")
DEFAULT_OUT = os.path.join(DIGEST_DIR, "_render_output.txt")
NOTIFY = os.path.expanduser("~/.hermes/scripts/notify.py")
DEFAULT_TARGET = "1480539453117305023"  # Discord #daily

# ── Grade table (score -> emoji + letter). Mirrors prompt.md Step "Grades". ──
_GRADES = [
    (93, "🔥", "A"), (90, "✅", "A-"), (87, "👍", "B+"), (83, "👍", "B"),
    (80, "📋", "B-"), (77, "📋", "C+"), (73, "📋", "C"), (70, "🔹", "C-"),
]
def grade_for(score):
    try:
        s = int(round(float(score)))
    except (TypeError, ValueError):
        return "⬜", "D", 0
    for lo, emoji, letter in _GRADES:
        if s >= lo:
            return emoji, letter, s
    return "⬜", "D", s

# ── Discord markdown escaping ────────────────────────────────────────────────
# Escape every char that can open/close formatting so UNTRUSTED text (handles,
# titles, summaries) can never bleed. Leading line markers handled separately.
_MD_CHARS = r"\\*_~|`>"
_MD_ESCAPE_RE = re.compile(r"([\\*_~|`>])")
def esc(text):
    """Backslash-escape Discord markdown metacharacters in untrusted text."""
    if text is None:
        return ""
    out = _MD_ESCAPE_RE.sub(r"\\\1", str(text))
    # Neutralize a leading '#' or '-' that would start a header/list at line start.
    out = re.sub(r"^(\s*)([#-])", r"\1\\\2", out)
    # Neutralize a leading "N." that Discord renders as an ordered list.
    out = re.sub(r"^(\s*)(\d+)\.(\s)", r"\1\2\\.\3", out)
    return out

# ── Distinctness gate (the approved 1b guard) ────────────────────────────────
_WORD_RE = re.compile(r"[a-z0-9]+")
def _norm_words(s):
    return _WORD_RE.findall((s or "").lower())

def summary_echoes_headline(title, summary, overlap_threshold=0.40):
    """
    True if `summary` is effectively a reprint of `title` and should be dropped.
    Triggers on: empty summary, substring containment either direction (on the
    normalized text), or >threshold of the summary's words also appearing in the
    headline. Short summaries (<=4 distinct words) that are fully contained in
    the headline are always echoes.
    """
    if not summary or not summary.strip():
        return True
    t_words = _norm_words(title)
    s_words = _norm_words(summary)
    if not s_words:
        return True
    t_norm = " ".join(t_words)
    s_norm = " ".join(s_words)
    if not t_norm or not s_norm:
        return False
    # Substring containment in either direction = echo.
    if s_norm in t_norm or t_norm in s_norm:
        return True
    t_set = set(t_words)
    s_set = set(s_words)
    contained = sum(1 for w in s_set if w in t_set)
    overlap = contained / len(s_set)
    # Tiny summaries fully inside the headline are echoes regardless of ratio.
    if len(s_set) <= 4 and contained == len(s_set):
        return True
    return overlap > overlap_threshold

# ── Single display line (canonical one-field schema + legacy fallback) ───────
def item_display_line(item):
    """
    Return (escaped_line, dropped_echo) — the ONE rendered sentence for a story.

    Canonical schema: the model emits one field `line` (what happened + why it
    matters). Single-field-by-design makes the headline/summary echo bug
    structurally impossible — there is no second slot to fill wrong. We keep a
    legacy fallback (title [+ distinct summary]) so older debug dumps and any
    transitional run still render sanely instead of blank.
    """
    line = item.get("line")
    if line and str(line).strip():
        return esc(str(line).strip()), False
    title = item.get("title")
    summary = item.get("summary")
    if summary and not summary_echoes_headline(title, summary):
        return esc(f"{str(title).strip()} — {str(summary).strip()}"), False
    dropped = bool(summary and str(summary).strip())  # had a summary but it echoed
    return esc(str(title or "").strip()), dropped

# ── Source suffix (deterministic, from data not prose) ───────────────────────
def source_suffix(item):
    src = (item.get("source") or "").strip()
    if src == "HN":
        pts = item.get("hn_points"); cm = item.get("hn_comments")
        if pts is not None and cm is not None:
            return f"· HN {pts} pts / {cm} comments"
        return "· HN"
    if src == "smol.ai":
        return "· smol.ai"
    if src in ("Latent Space", "LatentSpace"):
        return "· Latent Space"
    if src == "X":
        handle = (item.get("authorHandle") or "").lstrip("@")
        return f"· X @{esc(handle)}" if handle else "· X"
    if src == "Perplexity":
        return ""
    # Unknown source: render it escaped so we never silently lose provenance.
    return f"· {esc(src)}" if src else ""

# ── URL handling: angle-bracket wrap, do NOT escape inside (esc would corrupt) ─
def wrap_url(url):
    u = (url or "").strip()
    if not u:
        return ""
    return f"<{u}>"

# ── Body assembly ────────────────────────────────────────────────────────────
def _derive_date_label(data):
    if data.get("date_label"):
        return data["date_label"]
    ts = data.get("ts")
    dt = None
    if ts:
        try:
            dt = datetime.datetime.fromisoformat(ts)
        except ValueError:
            dt = None
    if dt is None:
        dt = datetime.datetime.now()
    return dt.strftime("%A, %B ") + str(dt.day)

def render_body(data):
    date_label = _derive_date_label(data)
    header = f"☀️ **Morning Digest** — {esc(date_label)}"
    footer_text = (data.get("footer") or "").strip()
    footer = f"*{footer_text}*" if footer_text else ""

    selected = data.get("selected") or []
    also = data.get("also") or []
    empty_note = data.get("empty_note")

    lines = [header, ""]

    # No-stories husk (Empty-result rule). Triggered when the model passes an
    # explicit empty_note OR there is genuinely nothing to show.
    if empty_note or (not selected and not also):
        note = empty_note or "🤷 Nothing cleared the bar today — slow news day."
        lines.append(esc(note) if not str(note).startswith(("🤷", "⚠️")) else note)
        if footer:
            lines += ["", "---", footer]
        return "\n".join(lines).rstrip() + "\n"

    dropped_summaries = 0
    if selected:
        lines.append("🔥 **Top Stories**")
        lines.append("")
        for i, item in enumerate(selected, 1):
            emoji, letter, s = grade_for(item.get("score"))
            suffix = source_suffix(item)
            display, dropped = item_display_line(item)
            if dropped:
                dropped_summaries += 1
            head = f"**{i}.** {display} {suffix} {emoji} {letter} ({s})"
            head = re.sub(r"[ \t]+", " ", head).strip()
            lines.append(head)
            url = wrap_url(item.get("url"))
            if url:
                lines.append(url)
            lines.append("")

    if also:
        if lines and lines[-1] != "":
            lines.append("")
        lines.append("📊 **Also Noted**")
        for item in also:
            emoji, letter, s = grade_for(item.get("score"))
            suffix = source_suffix(item)
            display, _ = item_display_line(item)
            url = wrap_url(item.get("url"))
            line = f"• {display} {suffix} {emoji} {letter} ({s}) — {url}"
            line = re.sub(r"[ \t]+", " ", line).strip()
            lines.append(line)
        lines.append("")

    if footer:
        lines.append("---")
        lines.append(footer)

    body = "\n".join(lines).rstrip() + "\n"
    return body, dropped_summaries

def render(data):
    out = render_body(data)
    if isinstance(out, tuple):
        return out
    return out, 0

# ── Posting via notify.py (list args -> no shell -> no redaction mangling) ────
def post_body(body, target):
    cmd = ["python3", NOTIFY, "--send", body, "--channel", "discord", "--target", target]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr

# ── CLI ──────────────────────────────────────────────────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(description="Deterministic morning-digest renderer")
    ap.add_argument("--in", dest="infile", default=DEFAULT_IN)
    ap.add_argument("--out", dest="outfile", default=DEFAULT_OUT)
    ap.add_argument("--post", action="store_true", help="post the body via notify.py")
    ap.add_argument("--target", default=DEFAULT_TARGET, help="Discord channel id")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    with open(args.infile, "r") as f:
        data = json.load(f)
    body, dropped = render(data)

    with open(args.outfile, "w") as f:
        f.write(body)

    note = f"[render_digest] body={len(body)} chars; dropped {dropped} echo-summaries; -> {args.outfile}"
    if args.post:
        rc, so, se = post_body(body, args.target)
        if rc != 0:
            print(note + f"\n[render_digest] POST FAILED rc={rc}: {se.strip() or so.strip()}", file=sys.stderr)
            return 1
        print(note + f"\n[render_digest] posted OK -> #daily ({args.target})")
        return 0
    print(note)
    print("----- BODY -----")
    print(body)
    return 0

# ── Built-in self-test ───────────────────────────────────────────────────────
def _selftest():
    checks = []
    def ok(name, cond):
        checks.append((name, bool(cond)))

    # echo detection
    ok("identical echo", summary_echoes_headline("Foo launches Bar today", "Foo launches Bar today"))
    ok("retruncated echo", summary_echoes_headline(
        "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in",
        "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in. AI."))
    ok("empty summary", summary_echoes_headline("Foo ships Bar", ""))
    ok("tiny contained", summary_echoes_headline("Anthropic ships Claude Fable 5 model", "Claude Fable 5"))
    ok("distinct kept", not summary_echoes_headline(
        "Grok 4 lands July 10 via xAI livestream",
        "Musk claims it beats Opus on long-context retrieval and ships with a 2M token window."))
    ok("partial-overlap kept", not summary_echoes_headline(
        "Ollama v0.18.2 released",
        "Cuts Claude API roundtrip latency 40% by parallelizing local prompt-cache hits."))

    # escaping
    ok("underscore handle escaped", esc("@alexalbert__") == "@alexalbert\\_\\_")
    ok("asterisks escaped", esc("**Codex**") == "\\*\\*Codex\\*\\*")
    ok("leading dash escaped", esc("- item").startswith("\\-"))
    ok("backtick escaped", "\\`" in esc("`code`"))

    # grade mapping
    ok("grade A", grade_for(100) == ("🔥", "A", 100))
    ok("grade B", grade_for(85)[1] == "B")
    ok("grade D", grade_for(50)[0] == "⬜")

    # suffix
    ok("X suffix", source_suffix({"source": "X", "authorHandle": "@foo_bar"}) == "· X @foo\\_bar")
    ok("HN suffix", source_suffix({"source": "HN", "hn_points": 120, "hn_comments": 34}) == "· HN 120 pts / 34 comments")

    # full render: the echo summary must NOT appear; headline must
    data = {
        "date_label": "Wednesday, June 10",
        "selected": [{
            "title": "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in",
            "summary": "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in. AI.",
            "source": "X", "authorHandle": "NothingDevo", "score": 100,
            "url": "https://x.com/NothingDevo/status/2064780035962061109",
        }, {
            "title": "Grok 4 lands July 10 via xAI livestream",
            "summary": "Musk claims it beats Opus on long-context retrieval with a 2M token window.",
            "source": "X", "authorHandle": "elon_musk__", "score": 92,
            "url": "https://x.com/elonmusk/status/1",
        }],
        "also": [{
            "title": "Anthropic drops Claude Fable 5",
            "source": "HN", "hn_points": 210, "hn_comments": 88, "score": 90,
            "url": "https://news.ycombinator.com/item?id=1",
        }],
        "footer": "146 scanned (0 Perplexity + 27 HN + 0 smol.ai + 2 Latent Space + 117 X) · 69 new · caps applied",
    }
    body, dropped = render(data)
    ok("echo dropped count", dropped == 1)
    ok("echo text absent", "lock-in. AI." not in body)
    ok("headline present", "Big AI lock-in" in body)
    ok("distinct summary present", "long-context retrieval" in body)
    ok("handle escaped in body", "@elon\\_musk\\_\\_" in body and "@elon_musk__" not in body)
    ok("also-noted present", "Also Noted" in body and "210 pts" in body)
    ok("footer wrapped", body.rstrip().endswith("caps applied*"))
    ok("header present", body.startswith("☀️ **Morning Digest** — Wednesday, June 10"))

    # empty husk
    ebody, _ = render({"date_label": "Thu, June 11", "selected": [], "also": [],
                        "empty_note": "🤷 Nothing cleared the bar today — 30 scanned, none ≥77.",
                        "footer": "30 scanned · caps applied"})
    ok("husk note", "Nothing cleared the bar" in ebody)
    ok("husk no top stories", "Top Stories" not in ebody)

    # canonical single-field `line` schema (the structural fix)
    ldata = {
        "date_label": "Wednesday, June 10",
        "selected": [{
            "line": "Anthropic ships Claude Fable 5 — first Mythos-class model with public safeguards, SOTA on every benchmark by a margin.",
            "source": "X", "authorHandle": "alexalbert__", "score": 96,
            "url": "https://x.com/alexalbert__/status/1",
        }],
        "footer": "5 scanned · caps applied",
    }
    lbody, ldrop = render(ldata)
    ok("line schema renders", "first Mythos-class model" in lbody)
    ok("line schema no drop", ldrop == 0)
    ok("line schema escapes handle", "@alexalbert\\_\\_" in lbody)
    ok("line schema single line", lbody.count("**1.**") == 1)
    # exactly one content line between the **1.** head and its url (no echo line)
    seg = lbody.split("**1.**", 1)[1]
    head_line = seg.splitlines()[0]
    ok("line schema head has grade", "🔥 A (96)" in head_line)

    # legacy fallback: distinct summary still merges onto one line
    legbody, legdrop = render({"date_label": "X", "selected": [{
        "title": "Grok 4 ships", "summary": "Beats Opus on long-context retrieval per xAI.",
        "source": "X", "authorHandle": "x", "score": 90, "url": "https://x.com/x/1"}],
        "footer": "f"})
    ok("legacy merges distinct", "Grok 4 ships — Beats Opus" in legbody)
    ok("legacy no drop", legdrop == 0)
    # legacy echo summary still dropped, title kept
    legbody2, legdrop2 = render({"date_label": "X", "selected": [{
        "title": "Foo launches Bar today", "summary": "Foo launches Bar today.",
        "source": "HN", "hn_points": 1, "hn_comments": 1, "score": 84, "url": "https://h/1"}],
        "footer": "f"})
    ok("legacy echo dropped", legdrop2 == 1 and "Foo launches Bar today." not in legbody2
       and "Foo launches Bar today" in legbody2)

    passed = sum(1 for _, c in checks if c)
    total = len(checks)
    for name, c in checks:
        print(f"  {'✓' if c else '✗ FAIL'}  {name}")
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(main())
