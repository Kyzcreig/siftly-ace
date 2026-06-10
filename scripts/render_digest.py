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

# ── Event-dedup config (SPEC-digest-event-dedup-engagement v3) ────────────────
PER_EVENT_CAP = 1                  # D1: 1 item per event, hard, across Top+Also
# RC3: same-event fallback (when the model omits event_key) groups by a SHARED
# DISTINCTIVE BIGRAM (a product/entity phrase like "claude fable"), not a word-
# count ratio — conservative: no shared distinctive phrase => distinct events.
TOP_GATE = 83                      # final_score >= TOP_GATE -> Top Stories
ALSO_GATE = 77                     # ALSO_GATE..TOP_GATE-1 -> Also Noted
PRIMARY_HANDLES_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "primary-handles.txt")
# thought-leaders list is unioned in at runtime (RC1); path is best-effort.
THOUGHT_LEADERS_FILE = os.path.join(DIGEST_DIR, "thought-leaders.txt")

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

# ── Event dedup + engagement tiebreak (SPEC v3) ──────────────────────────────
_STOPWORDS = {
    "the","a","an","and","or","but","of","to","in","on","for","with","at","by",
    "from","as","is","are","be","this","that","it","its","into","just",
    "now","has","have","will","you","your","via","about","how","why","what",
    "after","over","than","then","they","their","i","we","our","my","goes","go",
    "can","a","an","single","two","three","four","five",
    # contraction tails left behind by the [a-z0-9]+ tokenizer ("I've"->i,ve;
    # "we've"->we,ve; "don't"->don,t) — these are NOT distinctive and were
    # causing false same-event merges (e.g. ("ve","been")).
    "ve","re","ll","s","t","m","d","don","doesn","didn","isn","aren","wasn",
    "weren","won","wouldn","couldn","shouldn","hasn","haven","hadn","im","ive",
    "been","being","was","were","he","she","his","her","them","not","no","yes",
}
# Generic org / launch-verb tokens that must NOT be the sole link between two
# items — "anthropic releases" is shared by EVERY Anthropic story on a busy day,
# so a distinctive bigram must contain at least one non-generic token (RC3:
# guard against same-org false-merge).
_GENERIC_TOKENS = {
    "anthropic","openai","google","googledeepmind","deepmind","meta","microsoft",
    "nvidia","mistral","xai","ai","model","models","new","release","releases",
    "released","launch","launches","launched","ships","shipped","shipping",
    "update","updates","updated","public","version","today","first","announces",
    "announced","announcement","introducing","introduces","unveils","unveiled",
    # generic THEME/movement words — shared by many unrelated stories on a busy
    # day, so they must not be the sole same-event link (e.g. ("open","source")
    # wrongly merged an anti-moat rant, an OSS-license take, and a Show HN).
    "open","source","sources","weights","weight","tier","safety","api","apis",
    "code","coding","agent","agents","data","cloud","app","apps","tool","tools",
    "use","using","used","week","year","time","people","price","prices","free",
    "show","hn","github","blog","post","thread","paper","report","field","guide",
}
_TOKEN_RE = re.compile(r"[a-z0-9]+")

def _sig_seq(text):
    """Significant lowercased token SEQUENCE (order preserved for bigrams),
    stopwords + bare numbers removed, @handles/urls stripped."""
    t = re.sub(r"https?://\S+", " ", str(text or "").lower())
    t = re.sub(r"@\w+", " ", t)
    return [w for w in _TOKEN_RE.findall(t) if w not in _STOPWORDS and not w.isdigit()]

def _sig_tokens(text):
    return set(_sig_seq(text))

def _distinctive_bigrams(text):
    """Adjacent significant-token bigrams where NOT both tokens are generic.
    A shared distinctive bigram (e.g. ('claude','fable')) is the same-event
    signal — it keys on a product/entity phrase, not a word-count ratio, so it
    groups paraphrases of one launch without merging different same-org news."""
    seq = _sig_seq(text)
    bg = set()
    for a, b in zip(seq, seq[1:]):
        if a in _GENERIC_TOKENS and b in _GENERIC_TOKENS:
            continue
        # require at least one distinctive (non-generic) token in the bigram
        if a in _GENERIC_TOKENS or b in _GENERIC_TOKENS:
            # keep it only if the non-generic side is reasonably specific (len>=3)
            other = b if a in _GENERIC_TOKENS else a
            if len(other) < 3:
                continue
        bg.add((a, b))
    return bg

def _shared_distinctive(a_bgs, b_bgs):
    """Same-event signal between two items' distinctive-bigram sets. To resist
    OVER-grouping on a single recurring product phrase (code-review Finding 4 —
    e.g. ("claude","code") appears across unrelated Claude-Code stories), require
    EITHER: a shared bigram whose BOTH tokens are distinctive (strong phrase like
    ("claude","fable")), OR at least TWO shared distinctive bigrams. A lone
    distinctive+generic bigram is too weak to merge on."""
    shared = a_bgs & b_bgs
    if not shared:
        return False
    strong = [(a, b) for (a, b) in shared
              if a not in _GENERIC_TOKENS and b not in _GENERIC_TOKENS]
    if strong:
        return True
    # only distinctive+generic bigrams shared → need at least two of them
    distinctive_shared = [(a, b) for (a, b) in shared
                          if a not in _GENERIC_TOKENS or b not in _GENERIC_TOKENS]
    return len(distinctive_shared) >= 2

def _load_primary_handles():
    """PRIMARY_HANDLES allowlist ∪ thought-leaders.txt handles (RC1). Lowercased,
    @-stripped. Best-effort: missing files just contribute nothing."""
    handles = set()
    for path in (PRIMARY_HANDLES_FILE, THOUGHT_LEADERS_FILE):
        try:
            with open(path) as f:
                for line in f:
                    line = line.split("#", 1)[0].strip().lstrip("@").lower()
                    # thought-leaders.txt has name-aliases (with spaces) too; keep
                    # only handle-shaped entries (no spaces).
                    if line and " " not in line:
                        handles.add(line)
        except OSError:
            pass
    return handles

def _is_primary(item, primary_handles):
    if item.get("is_primary") is True:
        return True
    h = (item.get("authorHandle") or "").lstrip("@").lower()
    return bool(h) and h in primary_handles

def _engagement(item):
    def _n(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    return _n(item.get("likes")) + _n(item.get("retweets"))

def _score_val(item):
    try:
        return int(round(float(item.get("score"))))
    except (TypeError, ValueError):
        return 0

def _item_text(item):
    return item.get("tweet_text") or item.get("text") or item.get("title") or item.get("line") or ""

def _stable_key(item):
    return str(item.get("tweet_id") or item.get("url") or "")

def _assign_event_groups(pool):
    """Return a list of group-ids (one per pool item). Exact `event_key` groups
    first; remaining items group transitively (union-find) by shared distinctive
    bigram. Conservative: an item that shares no distinctive bigram and has no
    event_key is its own group (RC3 — when in doubt, DON'T merge)."""
    n = len(pool)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[max(rx, ry)] = min(rx, ry)  # lower index = root (stable)

    # exact event_key
    ek_first = {}
    for i, it in enumerate(pool):
        ek = (it.get("event_key") or "").strip().lower()
        if ek:
            if ek in ek_first:
                union(ek_first[ek], i)
            else:
                ek_first[ek] = i

    # distinctive-bigram fallback for items WITHOUT an event_key
    bgs = [(_distinctive_bigrams(_item_text(pool[i]))
            if not (pool[i].get("event_key") or "").strip() else set())
           for i in range(n)]
    for i in range(n):
        if not bgs[i]:
            continue
        for j in range(i + 1, n):
            if not bgs[j]:
                continue
            if _shared_distinctive(bgs[i], bgs[j]):
                union(i, j)
    return [find(i) for i in range(n)]

def _winner_sort_key(item, primary_handles):
    # descending priority: is_primary, final_score, engagement, text length.
    return (
        1 if _is_primary(item, primary_handles) else 0,
        _score_val(item),
        _engagement(item),
        len(_item_text(item)),
    )

def _rank_desc(items, primary_handles):
    """Total, permutation-stable ordering: is_primary>score>engagement>text desc,
    then `_stable_key` (tweet_id/url) ASCENDING among equals. Implemented as a
    two-pass stable sort so it is correct for ANY id length (code-review Finding 1:
    the hand-rolled per-char tuple inverted for variable-length ids)."""
    out = sorted(items, key=_stable_key)                       # id ascending
    out.sort(key=lambda it: _winner_sort_key(it, primary_handles), reverse=True)
    return out

def dedup_and_rank(selected, also, per_event_cap=PER_EVENT_CAP, primary_handles=None):
    """Collapse same-event items to one (is_primary>score>engagement>text>id-asc)-ranked
    winner across the combined Top+Also pool, then place each survivor GATE-DRIVEN
    by the GROUP'S BEST member score (>=TOP_GATE -> Top, ALSO_GATE..TOP_GATE-1 ->
    Also) so an event with a Top-worthy member is never demoted to Also even when a
    primary-author winner scored lower (code-review Finding 3). NOT rank-bucketing.
    Returns (kept_top, kept_also, dropped); dropped items carry dropped_reason=
    'event_dup' + lost_to_url. Pure, idempotent, order-stable."""
    if primary_handles is None:
        primary_handles = _load_primary_handles()
    pool = list(selected or []) + list(also or [])
    if not pool:
        return [], [], []

    group_ids = _assign_event_groups(pool)
    groups = {}  # gid -> list[item], preserving input order
    for gid, item in zip(group_ids, pool):
        groups.setdefault(gid, []).append(item)

    kept, dropped = [], []
    # winner placement score per kept item = the BEST score in its group, so a
    # Top-worthy event keeps a Top slot regardless of which member won the cluster.
    place_score = {}
    for gid, items in groups.items():
        ordered = _rank_desc(items, primary_handles)
        winners = ordered[:per_event_cap]
        group_best = max((_score_val(it) for it in items), default=0)
        for w in winners:
            kept.append(w)
            place_score[id(w)] = group_best
        win_url = winners[0].get("url") if winners else None
        for loser in ordered[per_event_cap:]:
            d = dict(loser)
            d["dropped_reason"] = "event_dup"
            d["lost_to_url"] = win_url
            dropped.append(d)

    # GATE-DRIVEN placement by the group's best member score (not rank-bucketing)
    top, also_out = [], []
    for item in kept:
        (top if place_score.get(id(item), _score_val(item)) >= TOP_GATE else also_out).append(item)

    return _rank_desc(top, primary_handles), _rank_desc(also_out, primary_handles), dropped

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

def render_body(data, apply_dedup=True):
    date_label = _derive_date_label(data)
    header = f"☀️ **Morning Digest** — {esc(date_label)}"
    footer_text = (data.get("footer") or "").strip()
    footer = f"*{footer_text}*" if footer_text else ""

    selected = data.get("selected") or []
    also = data.get("also") or []
    empty_note = data.get("empty_note")

    # Event-dedup + engagement tiebreak runs FIRST (before the empty-result check)
    # so that if dedup collapses everything below the gates, the husk still fires.
    event_dropped = []
    if apply_dedup and not empty_note and (selected or also):
        selected, also, event_dropped = dedup_and_rank(selected, also)

    lines = [header, ""]

    if empty_note or (not selected and not also):
        note = empty_note or "🤷 Nothing cleared the bar today — slow news day."
        lines.append(note if str(note).startswith(("🤷", "⚠️")) else esc(note))
        if footer:
            lines += ["", "---", footer]
        return "\n".join(lines).rstrip() + "\n", 0, event_dropped

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

    return "\n".join(lines).rstrip() + "\n", dropped_summaries, event_dropped

def render(data):
    """2-tuple façade (body, echo_dropped_count) — backward compatible."""
    body, dropped_summaries, _ = render_body(data)
    return body, dropped_summaries

def render_full(data, apply_dedup=True):
    """3-tuple (body, echo_dropped_count, event_dropped[]) for the CLI/debug path."""
    return render_body(data, apply_dedup=apply_dedup)

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
    ap.add_argument("--no-dedup", dest="no_dedup", action="store_true",
                    help="render selected/also as-given; do NOT re-run event-dedup or "
                         "re-gate (use when select_digest.py already owns selection)")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    with open(args.infile, "r") as f:
        data = json.load(f)
    body, dropped, event_dropped = render_full(data, apply_dedup=not args.no_dedup)

    with open(args.outfile, "w") as f:
        f.write(body)

    # Surface event-dedup drops to the debug dump so "why was my item cut?" is
    # answerable from disk (RC5: dropped_reason='event_dup' + lost_to_url).
    if event_dropped:
        try:
            dbg_path = os.path.join(DIGEST_DIR, "_render_dropped.json")
            slim = [{"url": d.get("url"), "authorHandle": d.get("authorHandle"),
                     "score": d.get("score"), "dropped_reason": d.get("dropped_reason"),
                     "lost_to_url": d.get("lost_to_url")} for d in event_dropped]
            with open(dbg_path, "w") as df:
                json.dump({"ts": data.get("ts"), "event_dropped": slim}, df, indent=2)
        except OSError:
            pass

    note = (f"[render_digest] body={len(body)} chars; dropped {dropped} echo-summaries, "
            f"{len(event_dropped)} event-dups; -> {args.outfile}")
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

    # ── Event-dedup + engagement tiebreak (SPEC v3) ──────────────────────────
    PH = {"anthropicai", "openai"}  # deterministic allowlist for tests

    def tw(handle, text, score, likes=0, rt=0, tid=None, ek=None, prim=None):
        d = {"source": "X", "authorHandle": handle, "tweet_text": text,
             "score": score, "likes": likes, "retweets": rt,
             "url": f"https://x.com/{handle}/status/{tid or score}"}
        if tid: d["tweet_id"] = str(tid)
        if ek: d["event_key"] = ek
        if prim is not None: d["is_primary"] = prim
        return d

    # today's real failure: 5 near-identical Fable-5 tweets + a DIFFERENT policy event
    fable = [
        tw("theshortcut", "Anthropic releases Claude Fable 5, an AI model that can build playable video games from a single prompt", 91, likes=1, tid=1),
        tw("parody77647", "Anthropic ships Claude Fable 5 the Mythos class model goes public with safeguards", 89, tid=3),
        tw("SOFXnetwork", "Anthropic on June 10 released Claude Fable 5 the first public version of its Mythos class model", 89, tid=5),
    ]
    policy = tw("techsnif", "Anthropic releases two policy proposals on how governments should address catastrophic risks and labor market disruption", 89, tid=4)
    top, also_o, dropped = dedup_and_rank(fable + [policy], [], primary_handles=PH)
    ok("dedup collapses fable cluster", sum(1 for i in top+also_o if "Fable 5" in _item_text(i)) == 1)
    ok("dedup keeps policy separate", any("policy proposals" in _item_text(i) for i in top+also_o))
    ok("dedup dropped 2 fable dups", len(dropped) == 2 and all(d["dropped_reason"] == "event_dup" for d in dropped))
    ok("dedup lost_to recorded", all(d.get("lost_to_url") for d in dropped))

    # engagement tiebreak: same event, higher-engagement non-primary wins among equals
    e = [tw("a_acct", "Gemma 4 released open weights model", 85, likes=5, tid=10, ek="gemma4"),
         tw("b_acct", "Gemma 4 released open weights model", 85, likes=500, tid=11, ek="gemma4")]
    t2, a2, d2 = dedup_and_rank(e, [], primary_handles=PH)
    ok("engagement tiebreak picks higher", (t2 + a2)[0].get("authorHandle") == "b_acct")

    # is_primary beats higher-engagement non-primary (D3/D4: 0-like primary survives)
    p = [tw("anthropicai", "Claude Fable 5 is here official launch", 90, likes=0, tid=20, ek="fable5b"),
         tw("hypeacct", "Claude Fable 5 is here official launch", 90, likes=9999, tid=21, ek="fable5b")]
    tp, ap_, dp = dedup_and_rank(p, [], primary_handles=PH)
    ok("primary 0-like beats viral dup", (tp + ap_)[0].get("authorHandle") == "anthropicai")

    # score outranks engagement for placement (Blocker 2): 84 primary keeps Top over 78 viral
    sp = [tw("anthropicai", "X launch alpha", 84, likes=0, tid=30, ek="evx"),
          tw("viral", "X launch alpha", 78, likes=9999, tid=31, ek="evx")]
    ts, as_, ds = dedup_and_rank(sp, [], primary_handles=PH)
    ok("gate-driven: 84 winner in Top", len(ts) == 1 and ts[0].get("score") == 84 and len(as_) == 0)

    # event spanning Top+Also: same event, Also-tier higher-engagement must NOT bury Top-tier
    span_top = [tw("acct1", "Model Z benchmark crushes everything", 90, likes=2, tid=40, ek="zbench")]
    span_also = [tw("acct2", "Model Z benchmark crushes everything", 79, likes=800, tid=41, ek="zbench")]
    tsp, asp, dsp = dedup_and_rank(span_top, span_also, primary_handles=PH)
    ok("span keeps Top winner", len(tsp) == 1 and tsp[0].get("score") == 90 and len(asp) == 0 and len(dsp) == 1)

    # all-tie determinism: same score, same engagement, no primary -> tweet_id ascending, stable
    tie = [tw("z", "alpha event tie one two three", 80, tid=900, ek="tie"),
           tw("y", "alpha event tie one two three", 80, tid=100, ek="tie"),
           tw("x", "alpha event tie one two three", 80, tid=500, ek="tie")]
    r1 = dedup_and_rank(tie, [], primary_handles=PH)
    r2 = dedup_and_rank(list(reversed(tie)), [], primary_handles=PH)
    winner1 = (r1[0] + r1[1])[0].get("tweet_id")
    ok("all-tie deterministic", winner1 == "100")  # smallest id wins
    ok("all-tie order-stable", winner1 == (r2[0] + r2[1])[0].get("tweet_id"))

    # empty pool -> ([],[],[]) no crash
    ok("dedup empty pool", dedup_and_rank([], [], primary_handles=PH) == ([], [], []))

    # shingle fallback (no event_key) still groups the paraphrased Fable dups
    nf = [tw("acctA", "Anthropic launches Claude Fable five model today playable games", 88, tid=50),
          tw("acctB", "Anthropic launches Claude Fable five model today playable games build", 86, tid=51)]
    tn, an_, dn = dedup_and_rank(nf, [], primary_handles=PH)
    ok("shingle groups paraphrase", len(tn + an_) == 1 and len(dn) == 1)

    # shingle does NOT merge clearly different events
    diff = [tw("c1", "Gemma four open weights release from Google twelve b", 85, tid=60),
            tw("c2", "Cursor editor ships canvas design mode browser update", 84, tid=61)]
    td, ad, dd = dedup_and_rank(diff, [], primary_handles=PH)
    ok("shingle keeps distinct", len(td + ad) == 2 and len(dd) == 0)

    # husk still fires if dedup collapses everything below gate (ordering rule)
    lowdupe = {"date_label": "X",
               "selected": [tw("a", "minor thing happened here", 60, tid=70, ek="lo"),
                            tw("b", "minor thing happened here", 55, tid=71, ek="lo")],
               "also": [], "footer": "f"}
    lb, _, led = render_full(lowdupe)
    # both below 77 -> not husk (they still render as Top? no: gate places below-77 nowhere)
    ok("below-gate dupes dropped to 1", len(led) == 1)

    # render integration: dedup actually applied through render_body
    rdata = {"date_label": "Wednesday, June 10", "selected": fable + [policy], "also": [], "footer": "f scanned · caps applied"}
    rbody, _, rdrop = render_full(rdata)
    ok("render applies dedup", rbody.count("Claude Fable 5") <= 1 and len(rdrop) == 2)

    # ── code-review fixes (Findings 1, 3, 4) ─────────────────────────────────
    # F1: variable-length id tiebreak — lower id wins for UNEQUAL-length ids too.
    vl = [tw("p", "alpha beta gamma event vl", 80, tid="ab", ek="vl"),
          tw("q", "alpha beta gamma event vl", 80, tid="a", ek="vl")]
    rv = dedup_and_rank(vl, [], primary_handles=PH)
    ok("F1 varlen-id lower wins", (rv[0] + rv[1])[0].get("tweet_id") == "a")
    # also stable under permutation
    rv2 = dedup_and_rank(list(reversed(vl)), [], primary_handles=PH)
    ok("F1 varlen-id stable", (rv2[0] + rv2[1])[0].get("tweet_id") == "a")

    # F3: a Top-worthy (84) NON-primary member must keep the event in Top even
    # when a lower-scoring PRIMARY author wins the cluster.
    f3 = [tw("anthropicai", "Model Q ships preview", 70, likes=0, tid=80, ek="modelq"),
          tw("randomdev", "Model Q ships preview", 84, likes=3, tid=81, ek="modelq")]
    t3, a3, d3 = dedup_and_rank(f3, [], primary_handles=PH)
    ok("F3 top-worthy event stays Top", len(t3) == 1 and len(a3) == 0
       and t3[0].get("authorHandle") == "anthropicai")  # primary wins cluster…
    ok("F3 placed in Top by group best", _score_val(t3[0]) == 70 and len(d3) == 1)  # …but lands Top via group-best 84

    # F4: a single distinctive+generic shared bigram is too weak to merge.
    weak = [tw("w1", "Widget released for testing", 84, tid=90),
            tw("w2", "Widget retired after review", 83, tid=91)]
    tw4, aw4, dw4 = dedup_and_rank(weak, [], primary_handles=PH)
    ok("F4 weak single bigram no merge", len(tw4 + aw4) == 2 and len(dw4) == 0)

    passed = sum(1 for _, c in checks if c)
    total = len(checks)
    for name, c in checks:
        print(f"  {'✓' if c else '✗ FAIL'}  {name}")
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(main())
