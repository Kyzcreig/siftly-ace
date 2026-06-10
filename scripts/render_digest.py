#!/usr/bin/env python3
"""
render_digest.py — deterministic, source-aware renderer for the morning-digest post.

WHY THIS EXISTS
---------------
The morning-digest cron used to ask the model to WRITE prose per item, which let
a lazy/weak model (a) duplicate a headline into its own summary slot (the
"<headline> — <headline re-truncated>" echo) and (b) invent off-template formats
("@handle flags <headline>"). x-feed-brief never drifts because it pastes tweet
text VERBATIM. This renderer takes composition away from the model entirely and
makes the two content shapes match how Ace actually wants to read them:

  • X / tweets  → rendered like x-feed: author meta line + the VERBATIM tweet
                   text, cut at a natural boundary (sentence end / newline) when
                   long. No synthesis, so no drift.
  • stories     → a clean headline + ONE additional summary line that must add
    (HN, smol.ai,  info beyond the headline (echo-summaries are dropped).
     Latent Space,
     Perplexity)

The model emits structured JSON; THIS script escapes Discord markdown, computes
grades + source suffixes, truncates tweets naturally, drops echo summaries, and
posts via notify.py (which chunks). Model owns scoring/selection; Python owns
format. Render variance becomes impossible.

INPUT  (default ~/.hermes/state/cron/morning-digest/_render_input.json):
{
  "date_label": "Wednesday, June 10",        # optional; derived from ts if absent
  "ts": "2026-06-10T11:55:43-07:00",          # optional, for date derivation
  "selected": [                                # Top Stories (0..5)
    # --- a TWEET (source X) — verbatim, x-feed style ---
    { "source": "X", "authorHandle": "karpathy", "tweet_text": "<FULL verbatim tweet text>",
      "likes": 22800, "retweets": 1060, "score": 92, "url": "https://x.com/.../status/123" },
    # --- a STORY (HN / smol.ai / Latent Space / Perplexity) — headline + summary ---
    { "source": "HN", "title": "<headline>", "summary": "<distinct extra line>",
      "hn_points": 210, "hn_comments": 88, "score": 90, "url": "https://..." }
  ],
  "also": [ { ...same shapes... } ],          # Also Noted (0..N) — compact one-liners
  "footer": "147 scanned (...) · caps applied",
  "empty_note": null                           # set to render the no-stories husk
}

Backward-compatible: legacy items using a single `line` field, or `title`+`summary`
for X, still render sanely.

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

# Tweets render verbatim but are cut at a natural boundary past this length so a
# 2,000-char thread can't dominate the digest. Ace wants MORE than the old ~280.
MAX_TWEET_CHARS = 600
MAX_ALSO_CHARS = 200  # Also Noted is a compact secondary section

# ── Grade table (score -> emoji + letter). Mirrors prompt.md "Grades". ──
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
_MD_ESCAPE_RE = re.compile(r"([\\*_~|`>])")
def esc(text):
    """Backslash-escape Discord markdown metacharacters in untrusted text.
    Operates per-line so leading list/header/quote markers are caught on EVERY
    line (verbatim tweets are multi-line)."""
    if text is None:
        return ""
    def _esc_line(ln):
        ln = _MD_ESCAPE_RE.sub(r"\\\1", ln)
        ln = re.sub(r"^(\s*)([#-])", r"\1\\\2", ln)
        ln = re.sub(r"^(\s*)(\d+)\.(\s)", r"\1\2\\.\3", ln)
        return ln
    return "\n".join(_esc_line(l) for l in str(text).split("\n"))

# ── Natural truncation for verbatim tweets ───────────────────────────────────
_SENT_END_RE = re.compile(r"[.!?](?:\s|$)")
def natural_truncate(text, limit=MAX_TWEET_CHARS):
    """Cut `text` at a natural boundary (sentence end, else newline, else word)
    once it exceeds `limit`. Returns (text, truncated_bool). Never cuts mid-word."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text, False
    window = text[:limit]
    floor = int(limit * 0.5)  # don't cut so early we lose the point
    # latest sentence end within the window
    sent = -1
    for m in _SENT_END_RE.finditer(window):
        sent = m.end()
    nl = window.rfind("\n")
    candidates = [c for c in (sent, nl) if c >= floor]
    if candidates:
        return text[:max(candidates)].rstrip() + " …", True
    sp = window.rfind(" ")
    if sp >= floor:
        return text[:sp].rstrip() + " …", True
    return window.rstrip() + " …", True

# ── Echo gate (drop a story summary that just reprints its headline) ──────────
_WORD_RE = re.compile(r"[a-z0-9]+")
def _norm_words(s):
    return _WORD_RE.findall((s or "").lower())

def summary_echoes_headline(title, summary, overlap_threshold=0.40):
    """True if `summary` is effectively a reprint of `title` and should be dropped."""
    if not summary or not str(summary).strip():
        return True
    t_words = _norm_words(title)
    s_words = _norm_words(summary)
    if not s_words:
        return True
    t_norm = " ".join(t_words)
    s_norm = " ".join(s_words)
    if not t_norm or not s_norm:
        return False
    if s_norm in t_norm or t_norm in s_norm:
        return True
    t_set = set(t_words); s_set = set(s_words)
    contained = sum(1 for w in s_set if w in t_set)
    overlap = contained / len(s_set)
    if len(s_set) <= 4 and contained == len(s_set):
        return True
    return overlap > overlap_threshold

# ── Source helpers ───────────────────────────────────────────────────────────
def is_tweet(item):
    return (item.get("source") or "").strip().lower() in ("x", "twitter")

def _fmt_count(n):
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return None

def source_suffix(item):
    """Suffix for STORY items (tweets carry their own author meta line)."""
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
    if src.lower() in ("x", "twitter"):
        handle = (item.get("authorHandle") or "").lstrip("@")
        return f"· X @{esc(handle)}" if handle else "· X"
    if src == "Perplexity":
        return ""
    return f"· {esc(src)}" if src else ""

def wrap_url(url):
    u = (url or "").strip()
    return f"<{u}>" if u else ""

def _tweet_text(item):
    return item.get("tweet_text") or item.get("text") or item.get("line") or item.get("title") or ""

def _story_title(item):
    return item.get("title") or item.get("headline") or item.get("line") or ""

# ── Per-item block renderers ─────────────────────────────────────────────────
def render_top_block(item, index):
    """Return (lines, dropped_echo) for ONE Top Stories entry."""
    emoji, letter, s = grade_for(item.get("score"))
    url = wrap_url(item.get("url"))

    if is_tweet(item):
        # x-feed style: meta line, blank, verbatim tweet (natural cutoff), url
        handle = (item.get("authorHandle") or "").lstrip("@")
        meta = [f"@{esc(handle)}"] if handle else []
        for field, label in (("likes", "likes"), ("retweets", "reposts")):
            c = _fmt_count(item.get(field))
            if c is not None:
                meta.append(f"{c} {label}")
        meta.append(f"{emoji} {letter} ({s})")
        lines = [f"**{index}.** " + " · ".join(meta), ""]
        body, _ = natural_truncate(str(_tweet_text(item)))
        lines.append(esc(body))
        if url:
            lines.append(url)
        return lines, False

    # story: headline line, optional distinct summary line, url
    title = _story_title(item)
    head = f"**{index}.** {esc(str(title).strip())} {source_suffix(item)} {emoji} {letter} ({s})"
    head = re.sub(r"[ \t]+", " ", head).strip()
    lines = [head]
    summary = item.get("summary")
    dropped = False
    if summary and not summary_echoes_headline(title, summary):
        lines.append(esc(str(summary).strip()))
    elif summary and str(summary).strip():
        dropped = True  # had a summary but it echoed the headline
    if url:
        lines.append(url)
    return lines, dropped

def render_also_line(item):
    """One compact line for an Also Noted entry (tweet or story)."""
    emoji, letter, s = grade_for(item.get("score"))
    url = wrap_url(item.get("url"))
    if is_tweet(item):
        handle = (item.get("authorHandle") or "").lstrip("@")
        snippet, _ = natural_truncate(str(_tweet_text(item)), MAX_ALSO_CHARS)
        prefix = f"@{esc(handle)}: " if handle else ""
        display = prefix + esc(snippet)
        suffix = f"{emoji} {letter} ({s})"
    else:
        display = esc(str(_story_title(item)).strip())
        suffix = f"{source_suffix(item)} {emoji} {letter} ({s})"
    line = f"• {display} {suffix} — {url}"
    return re.sub(r"[ \t]+", " ", line).strip()

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

    if empty_note or (not selected and not also):
        note = empty_note or "🤷 Nothing cleared the bar today — slow news day."
        lines.append(note if str(note).startswith(("🤷", "⚠️")) else esc(note))
        if footer:
            lines += ["", "---", footer]
        return "\n".join(lines).rstrip() + "\n", 0

    dropped_summaries = 0
    if selected:
        lines.append("🔥 **Top Stories**")
        lines.append("")
        for i, item in enumerate(selected, 1):
            block, dropped = render_top_block(item, i)
            if dropped:
                dropped_summaries += 1
            lines.extend(block)
            lines.append("")

    if also:
        if lines and lines[-1] != "":
            lines.append("")
        lines.append("📊 **Also Noted**")
        for item in also:
            lines.append(render_also_line(item))
        lines.append("")

    if footer:
        lines.append("---")
        lines.append(footer)

    return "\n".join(lines).rstrip() + "\n", dropped_summaries

def render(data):
    return render_body(data)

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

    # echo detection (story summaries)
    ok("identical echo", summary_echoes_headline("Foo launches Bar today", "Foo launches Bar today"))
    ok("retruncated echo", summary_echoes_headline(
        "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in",
        "Datadog veterans launch AI coding startup Niteshift on a bet against Big AI lock-in. AI."))
    ok("empty summary", summary_echoes_headline("Foo ships Bar", ""))
    ok("distinct kept", not summary_echoes_headline(
        "Grok 4 lands July 10 via xAI livestream",
        "Musk claims it beats Opus on long-context retrieval and ships with a 2M token window."))

    # escaping (now per-line)
    ok("underscore handle escaped", esc("@alexalbert__") == "@alexalbert\\_\\_")
    ok("asterisks escaped", esc("**Codex**") == "\\*\\*Codex\\*\\*")
    ok("leading dash escaped each line", esc("ok\n- item").split("\n")[1].startswith("\\-"))
    ok("backtick escaped", "\\`" in esc("`code`"))

    # grade mapping
    ok("grade A", grade_for(100) == ("🔥", "A", 100))
    ok("grade D", grade_for(50)[0] == "⬜")

    # natural truncation
    long_tweet = "First sentence here. " + ("filler word " * 80) + "End."
    trunc, was = natural_truncate(long_tweet, 200)
    ok("trunc happened", was and trunc.endswith("…"))
    ok("trunc no midword", " ".join(trunc.split()) == trunc and "fille…" not in trunc)
    short_tweet = "Short and sweet."
    st, sw = natural_truncate(short_tweet, 200)
    ok("short not truncated", st == short_tweet and not sw)
    sent = "This is sentence one. This is sentence two that runs on and on and on " + ("x "*100)
    s2, _ = natural_truncate(sent, 60)
    ok("trunc at sentence end", s2.startswith("This is sentence one.") and s2.endswith("…"))

    # TWEET rendering (verbatim, x-feed style)
    tdata = {
        "date_label": "Wednesday, June 10",
        "selected": [{
            "source": "X", "authorHandle": "karpathy", "likes": 22800, "retweets": 1060,
            "score": 92,
            "tweet_text": "This is a super exciting release - same model, added safeguards.\nSecond line here.",
            "url": "https://x.com/karpathy/status/1",
        }],
        "footer": "5 scanned · caps applied",
    }
    tbody, tdrop = render(tdata)
    ok("tweet verbatim present", "This is a super exciting release" in tbody)
    ok("tweet 2nd line kept", "Second line here." in tbody)
    ok("tweet meta likes", "22,800 likes" in tbody and "1,060 reposts" in tbody)
    ok("tweet handle in meta", "@karpathy" in tbody)
    ok("tweet grade", "✅ A- (92)" in tbody)
    ok("tweet no drop", tdrop == 0)

    # tweet with markdown-bleed handle + chars
    bdata = {"date_label": "X", "selected": [{
        "source": "X", "authorHandle": "alexalbert__", "score": 86,
        "tweet_text": "Use **xhigh** effort and _ambitious_ tasks for @alexalbert__ tips.",
        "url": "https://x.com/alexalbert__/status/1"}], "footer": "f"}
    bbody, _ = render(bdata)
    ok("tweet handle escaped", "@alexalbert\\_\\_" in bbody)
    ok("tweet body escaped", "\\*\\*xhigh\\*\\*" in bbody and "\\_ambitious\\_" in bbody)

    # STORY rendering (headline + distinct summary)
    sdata = {
        "date_label": "Wednesday, June 10",
        "selected": [{
            "source": "HN", "title": "Anthropic ships Claude Fable 5",
            "summary": "First Mythos-class model with public safeguards; SOTA on every benchmark by a margin.",
            "hn_points": 210, "hn_comments": 88, "score": 90,
            "url": "https://news.ycombinator.com/item?id=1",
        }],
        "footer": "5 scanned · caps applied",
    }
    sbody, sdrop = render(sdata)
    ok("story headline present", "Anthropic ships Claude Fable 5" in sbody)
    ok("story summary present", "First Mythos-class model" in sbody)
    ok("story HN suffix", "· HN 210 pts / 88 comments" in sbody)
    ok("story grade", "✅ A- (90)" in sbody)
    ok("story no drop", sdrop == 0)

    # STORY echo summary dropped, headline kept
    edata = {"date_label": "X", "selected": [{
        "source": "HN", "title": "Foo launches Bar today", "summary": "Foo launches Bar today.",
        "hn_points": 1, "hn_comments": 1, "score": 84, "url": "https://h/1"}], "footer": "f"}
    ebody, edrop = render(edata)
    ok("story echo dropped", edrop == 1 and "Foo launches Bar today." not in ebody
       and "Foo launches Bar today" in ebody)

    # Also Noted: tweet snippet + story title
    adata = {"date_label": "X",
             "selected": [{"source": "HN", "title": "T", "score": 84, "url": "https://h/1"}],
             "also": [
                 {"source": "X", "authorHandle": "ollama", "score": 78,
                  "tweet_text": "Ollama v0.18.2 cuts Claude API latency 40% via local prompt-cache parallelism. " + ("extra "*60),
                  "url": "https://x.com/ollama/status/2"},
                 {"source": "HN", "title": "Cursor 3.7 ships Canvas Design Mode", "score": 77,
                  "hn_points": 90, "hn_comments": 12, "url": "https://h/2"},
             ], "footer": "f"}
    abody, _ = render(adata)
    ok("also tweet snippet", "@ollama:" in abody and "Ollama v0.18.2 cuts" in abody)
    ok("also tweet truncated", "…" in abody.split("Also Noted")[1])
    ok("also story title", "Cursor 3.7 ships Canvas Design Mode" in abody)
    ok("also story suffix", "· HN 90 pts / 12 comments" in abody)

    # legacy compat: bare `line`, and title+summary for X
    ldata = {"date_label": "X", "selected": [{
        "line": "Legacy one-liner about a thing.", "source": "X", "authorHandle": "x",
        "score": 88, "url": "https://x/1"}], "footer": "f"}
    lbody, _ = render(ldata)
    ok("legacy line renders", "Legacy one-liner about a thing." in lbody)

    # empty husk
    hbody, _ = render({"date_label": "Thu, June 11", "selected": [], "also": [],
                       "empty_note": "🤷 Nothing cleared the bar today — 30 scanned, none ≥77.",
                       "footer": "30 scanned · caps applied"})
    ok("husk note", "Nothing cleared the bar" in hbody)
    ok("husk no top stories", "Top Stories" not in hbody)

    # header + footer integrity
    ok("header present", tbody.startswith("☀️ **Morning Digest** — Wednesday, June 10"))
    ok("footer wrapped", tbody.rstrip().endswith("caps applied*"))

    passed = sum(1 for _, c in checks if c)
    total = len(checks)
    for name, c in checks:
        print(f"  {'✓' if c else '✗ FAIL'}  {name}")
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(main())
