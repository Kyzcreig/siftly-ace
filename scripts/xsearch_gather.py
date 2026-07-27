#!/usr/bin/env python3
"""
xsearch_gather.py — Phase-1 adapter: grok/`x_search` (xAI server-side) -> pipeline candidate rows.

WHY THIS EXISTS
---------------
Both briefs gathered X content through the PAID `api.twitter.com` recent-search
endpoint (~19 reads/day ≈ $9.50/day ≈ $285/mo). Hermes ships an `x_search` tool
that runs server-side at xAI and bills to the grok subscription ($0 marginal on
`credential_source == "xai-oauth"`). This module is the seam between the two.

Spec: ~/.hermes/plans/2026-07-25_x-api-to-grok-xsearch-migration-SPEC.md (§0.5 FINAL PLAN)
Capability reference: Obsidian "X Data Sourcing — Paid API vs Grok x_search.md"

⭐ THE SOURCING CONTRACT (empirically derived, non-negotiable)
--------------------------------------------------------------
Query in RAW X SEARCH-OPERATOR SYNTAX, never prose:

    from:<handle> min_faves:100 since:<ISO> until:<ISO>

Prose phrasing caps at ~10 rows/handle over a ~3h window and MISSES the day's top
post. Operator syntax returned 50 rows over a full 2-day window and matched 4 of
the paid API's top 5. Same tool, same day — only the phrasing changed.

Rules encoded below:
  * handles appear in BOTH `allowed_x_handles` AND the query text. `allowed_x_handles`
    does not reach the prompt; a query that doesn't name them returns
    "the query does not list any handles".
  * `since:`/`until:` are always sent AND every row is re-filtered locally. grok's own
    date arithmetic is unreliable (a 48h query once returned "0 posts" while citing
    posts from inside the window).
  * `min_faves:N` is BOTH the engagement floor AND the lever that widens the reachable
    window — a cheaper result set lets the search reach further back.
  * GOAL SHAPE: "every post from every followed account clearing N likes" — a
    completeness sweep above a quality floor, NOT a per-handle top-N.

🔴 THE FIVE FAILURE MODES THIS MODULE EXISTS TO PREVENT
-------------------------------------------------------
B1. CANDIDATE SHAPE IS FATAL IF WRONG.
    `select_digest._item_text()` reads ONLY tweet_text|title|summary|line|text_snippet.
    A row emitting `text` yields '' -> `is_bare_fragment('')` is True -> the row is
    hard-discarded before scoring. 100% silent candidate loss.
    Separately: `select_digest._engagement` falls back to `public_metrics`, but
    `overview_digest._engagement` (overview_digest.py:271) and
    `render_digest._engagement` (render_digest.py:199) read ONLY flat `likes`/`retweets`
    and return 0 otherwise — the posted brief would render with no like counts and rank
    every author at 0.
    => every emitted row carries `tweet_text` AND flat `likes`/`retweets` AND
       `public_metrics:{like_count,retweet_count}`. All three. See `to_candidate`.

B2. SNOWFLAKE ID PRECISION / TYPE DRIFT.
    `tweet_id` arrives as a bare JSON number exceeding 2^53 in some responses
    (…857899 -> …857856, off by 43 after a float64 hop) and flips int/string between
    calls. Coerce to string at ingest, always; dedupe on the string. See `coerce_id`.
    NOTE (measured, see handoff): CPython's `json` has arbitrary-precision ints, so the
    corruption does NOT originate in this module's parse — it originates upstream (a JS
    `JSON.parse` hop or grok's own emission). Coercing here is still correct: it makes
    dedupe type-stable and prevents THIS module from introducing a float hop.

B3. TIMESTAMP FORMAT DRIFT.
    Same handle, two calls: `2026-07-24T20:04:54Z` and
    `Fri, 24 Jul 2026 20:04:54 GMT`. Both observed live. Parse both, normalize to UTC
    ISO8601. See `normalize_ts`.

B4. EMPTY POOL MUST FAIL LOUDLY.
    A successful x_search returning zero rows is HTTP 200 / success:true, so the
    brief's Step-1.5 guard does NOT fire; the legacy fallback then posts a thin brief
    and Step 7 touches the PT-day lock, blocking retry for the whole day.
    => `rows_after_window_filter == 0` exits non-zero with `empty_pool: true` in the
       report so the caller alerts #logs and does NOT touch the day lock.

B5. UNVERIFIED / SILENTLY-METERED RESULTS.
    The tool returns `citations` / `inline_citations` and a `degraded` flag for free.
    Every returned tweet_id must appear in the citation set; a chunk with
    `degraded == true` is rejected. And `credential_source` must be `xai-oauth` —
    `resolve_xai_http_credentials` silently falls back to a METERED `XAI_API_KEY`,
    which an X-developer-portal read counter cannot see.

USAGE
-----
  # live gather (drives the Hermes x_search tool via the runtime venv)
  xsearch_gather.py --handles-file ~/.hermes/digest/thought-leaders.txt \\
                    --since 2026-07-24T00:00:00Z --until 2026-07-26T00:00:00Z \\
                    --min-faves 100 --out /tmp/x-candidates.json

  # adapt an x_search response the CALLER already fetched (the cron agent has the
  # tool natively — this avoids a second billed call and is the preferred cron path)
  xsearch_gather.py --from-response resp.json --since ... --until ... --out ...

  xsearch_gather.py --selftest       # built-in checks, no I/O, no network
"""
from __future__ import annotations

import argparse
import datetime as _dt
import email.utils
import json
import os
import re
import subprocess
import sys

# ── Config ───────────────────────────────────────────────────────────────────
DEFAULT_MIN_FAVES = 100
DEFAULT_CHUNK_SIZE = 10          # allowed_x_handles hard cap at the tool
MAX_HANDLES_PER_CALL = 10        # tools/x_search_tool.py MAX_HANDLES

# TRUNCATION TRIPWIRE THRESHOLD.
#
# 🔴 SPEC CORRECTION (measured live 2026-07-25 — the spec says 50; that is NOT the
# universal ceiling). Operator syntax DID return 50 rows for @elonmusk with
# min_faves:5000, but on @emollick with min_faves:100:
#     2026-07-24 → 2026-07-26 (48h, one call)  => EXACTLY 10 rows
#     2026-07-24 → 2026-07-25 (24h, one call)  => EXACTLY 10 rows
#     2026-07-25 → 2026-07-26 (24h, one call)  => 4 rows
# i.e. splitting the same window in two yielded 14 rows where one call yielded 10.
# Ten is a REAL cap here, reached silently. Defaulting the tripwire to 50 would have
# let a 29% content loss pass unnoticed, so the default is 10: a handle returning a
# suspiciously round 10 (or more) is flagged for a solo re-query on a tighter window.
DEFAULT_TRUNCATION_CAP = 10
REQUIRED_CREDENTIAL_SOURCE = "xai-oauth"

HERMES_VENV_PY = os.path.expanduser("~/.hermes/runtime/hermes-agent/venv/bin/python")
HERMES_RUNTIME = os.path.expanduser("~/.hermes/runtime/hermes-agent")

THOUGHT_LEADERS_FILE = os.path.expanduser("~/.hermes/digest/thought-leaders.txt")

# Extract a status id out of any x.com/twitter.com permalink shape, including the
# `x.com/i/status/<id>` form the inline citations use.
_STATUS_RE = re.compile(r"(?:x\.com|twitter\.com)/(?:[A-Za-z0-9_]+|i)/status(?:es)?/(\d+)", re.I)
_ID_RE = re.compile(r"\b(\d{6,25})\b")
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


# ── B2: id coercion ──────────────────────────────────────────────────────────
def coerce_id(value) -> str:
    """Coerce a tweet id to a stable string. NEVER let it touch a float.

    Guards B2: ids arrive as bare JSON numbers > 2^53 in some responses and flip
    int/string between calls, so `str(int)` vs `str` inconsistency defeats dedupe.
    A float input is rendered without exponent/`.0` so a corrupted-but-parsed id is
    at least *stable* rather than sometimes `1.23e+18`.
    """
    if value is None:
        return ""
    if isinstance(value, bool):        # bool is an int subclass; never a valid id
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value))
    s = str(value).strip()
    if not s:
        return ""
    m = _STATUS_RE.search(s)
    if m:
        return m.group(1)
    return s


def id_from_url(url) -> str:
    m = _STATUS_RE.search(str(url or ""))
    return m.group(1) if m else ""


# ── B3: timestamp normalisation ──────────────────────────────────────────────
def normalize_ts(value) -> str:
    """Parse ISO8601 *or* RFC-1123 and return UTC ISO8601 (`...Z`). '' when unparseable.

    Both formats verified live from the same tool on the same day:
      "2026-07-24T20:04:54Z"           (ISO8601)
      "Fri, 24 Jul 2026 20:04:54 GMT"  (RFC-1123)
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    dt = _parse_dt(raw)
    if dt is None:
        return ""
    return dt.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_dt(raw):
    """Return an aware datetime, or None. Naive inputs are assumed UTC."""
    s = str(raw or "").strip()
    if not s:
        return None
    iso = s[:-1] + "+00:00" if s.endswith("Z") else s
    try:
        dt = _dt.datetime.fromisoformat(iso)
    except ValueError:
        try:
            dt = email.utils.parsedate_to_datetime(s)
        except (TypeError, ValueError, IndexError):
            return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt


# ── Query construction (the operator-syntax contract) ────────────────────────
def build_query(handles, since, until, min_faves=DEFAULT_MIN_FAVES,
                include_retweets=False) -> str:
    """Raw X search-operator syntax + a strict JSON-shape instruction.

    Handles are written into the QUERY TEXT as well as `allowed_x_handles` — the
    param does not reach the prompt, and a query that doesn't name them returns
    "the query does not list any handles".

    `min_faves:` is deliberately inside the operator string: it is both the
    engagement floor and the lever that widens the reachable time window.
    Retweets are excluded by construction — every retweet row carries likes:0, so
    any `min_faves:` floor removes them anyway; pass include_retweets=True (with
    min_faves=0) only if you want raw amplification signal as a separate lane.
    """
    hs = [str(h or "").strip().lstrip("@") for h in (handles or [])]
    hs = [h for h in hs if h]
    if not hs:
        raise ValueError("build_query requires at least one handle")
    if len(hs) > MAX_HANDLES_PER_CALL:
        raise ValueError(f"at most {MAX_HANDLES_PER_CALL} handles per call (got {len(hs)})")

    since_d = _date_only(since)
    until_d = _date_only(until)
    faves = f" min_faves:{int(min_faves)}" if int(min_faves) > 0 else ""
    rts = " include:nativeretweets" if include_retweets else ""

    # QUERY FORM IS LOAD-BEARING (measured 2026-07-27, 6x recall difference).
    # This used to repeat the full filter set per handle:
    #     from:A min_faves:N since:S until:U OR from:B min_faves:N since:S until:U OR ...
    # On 10 handles @ min_faves:20000 that form returned ONE row and MISSED the
    # day's #1 post (@RepThomasMassie, 132,744 likes) — while the grouped form
    # below, same handles/floor/window, returned SIX including it. The long
    # per-handle repetition appears to be truncated or mis-parsed upstream, and
    # it fails SILENTLY: a short result looks like "nobody posted", not a bug.
    #
    # Group the handles into ONE disjunction and apply each filter ONCE:
    #     (from:A OR from:B OR … OR from:J) min_faves:N since:S until:U
    # Shorter, unambiguous, and it is how X's own search syntax is documented.
    # A single handle needs no parentheses.
    if len(hs) == 1:
        operators = f"from:{hs[0]}{faves} since:{since_d} until:{until_d}{rts}"
    else:
        group = " OR ".join(f"from:{h}" for h in hs)
        operators = f"({group}){faves} since:{since_d} until:{until_d}{rts}"

    return (
        f"{operators}\n\n"
        "Return ONLY a JSON array — no prose, no commentary, no code fences. One object "
        "per post. Keys exactly: handle, tweet_id, tweet_text, url, likes, retweets, "
        "replies, views, created_at.\n"
        "tweet_id MUST be a STRING (quoted), not a number. created_at MUST be exact "
        "ISO8601 UTC. Integers as integers; use null when a value is unknown. "
        "Return EVERY matching post, not a sample."
    )


def _date_only(value) -> str:
    dt = _parse_dt(value)
    if dt is None:
        raise ValueError(f"unparseable date: {value!r}")
    return dt.astimezone(_dt.timezone.utc).strftime("%Y-%m-%d")


def chunk_handles(handles, chunk_size=DEFAULT_CHUNK_SIZE, solo=()):
    """Chunk handles for `allowed_x_handles`, isolating heavy accounts.

    Operator syntax returned 50 rows for a single heavy handle in ONE call, and only
    ~39% of posts clear 100 likes, so most handles yield a handful. Heavy accounts
    (>10 posts/day) go SOLO so one loud account can't consume the whole chunk's
    result budget and truncate its quieter neighbours; everyone else is batched.
    """
    size = max(1, min(int(chunk_size), MAX_HANDLES_PER_CALL))
    solo_set = {str(h).strip().lstrip("@").lower() for h in (solo or []) if str(h).strip()}
    seen, heavy, quiet = set(), [], []
    for h in handles or []:
        n = str(h or "").strip().lstrip("@")
        if not n or n.lower() in seen:
            continue
        seen.add(n.lower())
        (heavy if n.lower() in solo_set else quiet).append(n)
    chunks = [[h] for h in heavy]
    chunks += [quiet[i:i + size] for i in range(0, len(quiet), size)]
    return chunks


# ── Response parsing ─────────────────────────────────────────────────────────
def extract_rows(answer) -> list:
    """Pull a JSON array of post objects out of the model's `answer` string.

    Tolerates code fences and leading/trailing prose. "JSON only" is a MODEL
    BEHAVIOR, not an API contract (spec §8.5) — this must never throw on drift.
    """
    if isinstance(answer, list):
        return [r for r in answer if isinstance(r, dict)]
    text = str(answer or "").strip()
    if not text:
        return []
    for candidate in _json_candidates(text):
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, list):
            return [r for r in parsed if isinstance(r, dict)]
        if isinstance(parsed, dict):
            for key in ("posts", "results", "data", "tweets", "items"):
                v = parsed.get(key)
                if isinstance(v, list):
                    return [r for r in v if isinstance(r, dict)]
            return [parsed]
    return []


def _json_candidates(text):
    for m in _FENCE_RE.finditer(text):
        yield m.group(1)
    yield text
    start, end = text.find("["), text.rfind("]")
    if 0 <= start < end:
        yield text[start:end + 1]
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        yield text[start:end + 1]


def citation_ids(response: dict) -> set:
    """Every status id referenced by `citations` + `inline_citations`.

    B5: this is the free hallucination guard. Note that on live 2026-07-25 calls
    the top-level `citations` array came back EMPTY while `inline_citations`
    carried all three ids — so BOTH channels must be unioned. Checking only
    `citations` would reject every real chunk (see handoff: spec correction #1).
    """
    out = set()
    for key in ("citations", "inline_citations"):
        for c in response.get(key) or []:
            if isinstance(c, str):
                blob = c
            elif isinstance(c, dict):
                blob = " ".join(str(c.get(k) or "") for k in ("url", "title", "id", "tweet_id"))
            else:
                blob = str(c)
            tid = id_from_url(blob)
            if tid:
                out.add(tid)
                continue
            for m in _ID_RE.finditer(blob):
                out.add(m.group(1))
    return out


def _num(v, default=0):
    if v is None or isinstance(v, bool):
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# ── B1: the candidate shape ──────────────────────────────────────────────────
def to_candidate(row: dict) -> dict:
    """Map one x_search row to the pipeline candidate shape. Returns {} if unusable.

    🔴 THE SHAPE IS THE WHOLE POINT. Do not "simplify" these fields:

      tweet_text  — select_digest._item_text reads tweet_text|title|summary|line|
                    text_snippet and NOTHING else. Emitting `text` (as spec v3 did)
                    yields '' -> is_bare_fragment('') -> True -> silent 100% discard.
      likes/retweets (FLAT) — overview_digest._engagement and render_digest._engagement
                    read ONLY these. Without them the posted brief renders with no like
                    counts and ranks every author at 0.
      public_metrics — select_digest._engagement's documented fallback; keeps
                    low_reach_cap() honest.
      source:"x"  — select_digest._is_x is source-driven; without it the low-reach
                    guard silently stops applying to X rows.
    """
    handle = str(row.get("handle") or row.get("authorHandle") or row.get("username") or "").strip().lstrip("@")
    text = row.get("tweet_text")
    if text is None:
        text = row.get("text")
    if text is None:
        text = row.get("full_text")
    # F4/G3: `text: null` is a real media-only post, not corruption. Keep it as ''
    # and let the caller count it; do not crash and do not fabricate a body.
    text = "" if text is None else str(text)

    url = str(row.get("url") or row.get("link") or "").strip()
    tid = coerce_id(row.get("tweet_id") or row.get("id") or row.get("id_str"))
    if not tid:
        tid = id_from_url(url)
    if not tid:
        return {}
    if not handle:
        m = re.search(r"(?:x\.com|twitter\.com)/([A-Za-z0-9_]+)/status", url, re.I)
        handle = m.group(1) if m and m.group(1).lower() != "i" else ""
    if not url or "/i/status/" in url:
        url = f"https://x.com/{handle or 'i'}/status/{tid}"

    likes = _num(row.get("likes") if row.get("likes") is not None else row.get("like_count"))
    rts = _num(row.get("retweets") if row.get("retweets") is not None else row.get("reposts"))
    replies = _num(row.get("replies") if row.get("replies") is not None else row.get("reply_count"))
    views = _num(row.get("views") if row.get("views") is not None else row.get("view_count"))
    created = normalize_ts(row.get("created_at") or row.get("published_at") or row.get("timestamp"))

    return {
        "id": tid,
        "tweet_id": tid,                 # B2: string, always
        "source": "x",                   # select_digest._is_x is source-driven
        "authorHandle": handle,
        "tweet_text": text,              # B1: the ONLY key _item_text will read
        "title": "",                     # never set for tweets (would route as a story)
        "url": url,
        "likes": likes,                  # B1: flat — overview/render read only these
        "retweets": rts,
        "replies": replies,
        "views": views,
        "public_metrics": {              # B1: select_digest._engagement fallback
            "like_count": likes,
            "retweet_count": rts,
            "reply_count": replies,
            "impression_count": views,
        },
        "created_at": created,
        "published_at": created,
        "gather_source": "x_search",     # positive proof the grok path produced this row
    }


def in_window(candidate: dict, since, until) -> bool:
    """Local timestamp re-filter — MANDATORY, not optional.

    grok's date arithmetic is unreliable in both directions: a 48h query once
    returned "0 posts" while citing in-window posts, and a quiet account's "10 most
    recent" reached back 26 days. `since:`/`until:` are a soft, model-mediated hint;
    THIS is the hard boundary.

    A row with an unparseable/missing timestamp is DROPPED, not kept — keeping it
    would silently reintroduce out-of-window content through the one path the
    window filter can't see.
    """
    dt = _parse_dt(candidate.get("created_at"))
    if dt is None:
        return False
    s, u = _parse_dt(since), _parse_dt(until)
    if s is not None and dt < s:
        return False
    if u is not None and dt >= u:
        return False
    return True


def load_handles(path=THOUGHT_LEADERS_FILE):
    """X handles from a watchlist file: non-comment, non-blank, no spaces."""
    out = []
    try:
        with open(path) as f:
            for ln in f:
                ln = ln.strip()
                if not ln or ln.startswith("#") or " " in ln:
                    continue
                out.append(ln.lstrip("@"))
    except OSError:
        return []
    seen, uniq = set(), []
    for h in out:
        if h.lower() not in seen:
            seen.add(h.lower())
            uniq.append(h)
    return uniq


# ── Chunk adaptation (the guard stack) ───────────────────────────────────────
def adapt_chunk(response: dict, handles, since, until, min_faves=DEFAULT_MIN_FAVES,
                bypass_handles=(), truncation_cap=DEFAULT_TRUNCATION_CAP,
                verify_citations=True):
    """Turn ONE x_search response into (candidates, stats). Never raises.

    Guard order — each stage is counted so a silent collapse is impossible to miss:
      credential_source -> transport/degraded -> parse -> citation verify ->
      id coerce/dedupe -> local window filter -> likes floor (TL bypass) -> tripwire
    """
    stats = {
        "handles": list(handles),
        "ok": False,
        "credential_source": str(response.get("credential_source") or ""),
        "credential_ok": False,
        "degraded": bool(response.get("degraded")),
        "degraded_reason": response.get("degraded_reason"),
        "rows_parsed": 0,
        "rows_malformed": 0,
        "rows_uncited": 0,
        "rows_after_window_filter": 0,
        "rows_after_likes_filter": 0,
        "rows_dup": 0,
        "rows_null_text": 0,
        "per_handle": {},
        "truncated_handles": [],
        "errors": [],
    }
    stats["credential_ok"] = stats["credential_source"] == REQUIRED_CREDENTIAL_SOURCE

    if not response.get("success"):
        stats["errors"].append(f"x_search failed: {response.get('error') or 'unknown error'}")
        return [], stats
    if stats["degraded"]:
        # B5: filters were active but xAI returned NO citations in either channel —
        # the answer came from model knowledge, not the X index. Reject the chunk.
        #
        # ⚠️ NOT AN ERROR (capability-ref G7, confirmed live 2026-07-25): the
        # overwhelmingly common cause is simply "these handles posted nothing above
        # the floor in this window". A solo sweep of 5 handles produced 2 degraded
        # chunks for exactly that reason. Counting it as a FAILURE would page the
        # operator every single night. It is a distinct, benign outcome — the chunk
        # is dropped and counted, `ok` stays True, and only a run where EVERY chunk
        # degrades is worth alerting on (that is what empty_pool catches).
        stats["ok"] = True
        return [], stats
    if not stats["credential_ok"]:
        # B5/D5: NOT fatal (we still want the rows), but LOUD — this is silent
        # metered XAI_API_KEY billing that an X-portal read counter cannot see.
        stats["errors"].append(
            f"credential_source={stats['credential_source']!r} != {REQUIRED_CREDENTIAL_SOURCE!r} "
            f"— possible SILENT METERED BILLING")

    rows = extract_rows(response.get("answer"))
    stats["rows_parsed"] = len(rows)
    cited = citation_ids(response) if verify_citations else None

    bypass = {str(h).strip().lstrip("@").lower() for h in (bypass_handles or [])}
    out, seen = [], set()
    for row in rows:
        cand = to_candidate(row)
        if not cand:
            stats["rows_malformed"] += 1
            continue
        tid = cand["tweet_id"]
        if cited is not None and tid not in cited:
            # B5: an id the tool never cited. Treat as unverified and drop it.
            stats["rows_uncited"] += 1
            continue
        if tid in seen:
            stats["rows_dup"] += 1
            continue
        seen.add(tid)
        h = (cand["authorHandle"] or "").lower()
        stats["per_handle"][h] = stats["per_handle"].get(h, 0) + 1
        if not cand["tweet_text"].strip():
            stats["rows_null_text"] += 1
        if not in_window(cand, since, until):
            continue
        stats["rows_after_window_filter"] += 1
        if cand["likes"] < int(min_faves) and h not in bypass:
            continue
        stats["rows_after_likes_filter"] += 1
        out.append(cand)

    # TRUNCATION TRIPWIRE: a handle returning EXACTLY the cap was cut off, not
    # exhausted. Re-query it solo with a tighter since:/until:.
    for h, n in stats["per_handle"].items():
        if truncation_cap and n >= int(truncation_cap):
            stats["truncated_handles"].append(h)

    stats["ok"] = True
    return out, stats


def merge_stats(all_stats):
    """Roll per-chunk stats into the run report (§6c positive-proof counters)."""
    rep = {
        "x_search_calls": len(all_stats),
        "chunks_ok": 0,
        "chunks_failed": 0,
        "chunks_degraded": 0,
        "rows_parsed": 0,
        "rows_malformed": 0,
        "rows_uncited": 0,
        "rows_dup": 0,
        "rows_null_text": 0,
        "rows_after_window_filter": 0,
        "rows_after_likes_filter": 0,
        "candidates_emitted": 0,
        "credential_sources": [],
        "credential_ok": True,
        "truncated_handles": [],
        "errors": [],
        "per_handle": {},
    }
    for s in all_stats:
        rep["chunks_ok" if s.get("ok") else "chunks_failed"] += 1
        if s.get("degraded"):
            rep["chunks_degraded"] += 1
        for k in ("rows_parsed", "rows_malformed", "rows_uncited", "rows_dup",
                  "rows_null_text", "rows_after_window_filter", "rows_after_likes_filter"):
            rep[k] += int(s.get(k) or 0)
        src = s.get("credential_source") or ""
        if src and src not in rep["credential_sources"]:
            rep["credential_sources"].append(src)
        if not s.get("credential_ok"):
            rep["credential_ok"] = False
        rep["truncated_handles"].extend(s.get("truncated_handles") or [])
        rep["errors"].extend(s.get("errors") or [])
        for h, n in (s.get("per_handle") or {}).items():
            rep["per_handle"][h] = rep["per_handle"].get(h, 0) + n
    return rep


# ── Transport ────────────────────────────────────────────────────────────────
_DRIVER = (
    "import json,sys\n"
    "from tools.x_search_tool import x_search_tool\n"
    "req=json.load(sys.stdin)\n"
    "sys.stdout.write(x_search_tool(**req))\n"
)


def call_x_search(query, handles, since, until, timeout=300,
                  venv_py=HERMES_VENV_PY, runtime=HERMES_RUNTIME) -> dict:
    """Invoke the Hermes `x_search` tool out-of-process via the runtime venv.

    The tool is an in-process Hermes tool, not an HTTP endpoint we can curl, so a
    standalone script has to enter the runtime interpreter to reach it. Returns the
    tool's own JSON dict, or a synthetic {success:false} on transport failure —
    never raises, so one bad chunk can't abort the sweep.
    """
    if not os.path.exists(venv_py):
        return {"success": False, "error": f"hermes runtime python not found at {venv_py}"}
    req = {
        "query": query,
        "allowed_x_handles": [str(h).lstrip("@") for h in handles][:MAX_HANDLES_PER_CALL],
        "from_date": _date_only(since),
        "to_date": _date_only(until),
    }
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    try:
        proc = subprocess.run(
            [venv_py, "-c", _DRIVER], input=json.dumps(req), capture_output=True,
            text=True, cwd=runtime, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"x_search timed out after {timeout}s"}
    except OSError as e:
        return {"success": False, "error": f"x_search transport error: {e}"}
    if proc.returncode != 0:
        return {"success": False,
                "error": f"x_search driver exit {proc.returncode}: {(proc.stderr or '')[:500]}"}
    try:
        return json.loads(proc.stdout)
    except (ValueError, TypeError):
        return {"success": False, "error": f"x_search returned non-JSON: {(proc.stdout or '')[:300]}"}


# ── Run ──────────────────────────────────────────────────────────────────────
def gather(handles, since, until, min_faves=DEFAULT_MIN_FAVES, chunk_size=DEFAULT_CHUNK_SIZE,
           solo=(), bypass_handles=(), responses=None, caller=None,
           truncation_cap=DEFAULT_TRUNCATION_CAP, verify_citations=True):
    """Full sweep. `responses` (list of pre-fetched dicts) short-circuits the network."""
    chunks = chunk_handles(handles, chunk_size=chunk_size, solo=solo)
    caller = caller or (lambda q, h: call_x_search(q, h, since, until))
    candidates, all_stats, seen = [], [], set()

    if responses is not None:
        pairs = [(responses[i], chunks[i] if i < len(chunks) else [])
                 for i in range(len(responses))]
    else:
        pairs = []
        for ch in chunks:
            try:
                query = build_query(ch, since, until, min_faves=min_faves)
            except ValueError as e:
                all_stats.append({"ok": False, "handles": ch, "errors": [str(e)],
                                  "credential_ok": True})
                continue
            pairs.append((caller(query, ch), ch))

    for resp, ch in pairs:
        rows, stats = adapt_chunk(resp, ch, since, until, min_faves=min_faves,
                                  bypass_handles=bypass_handles,
                                  truncation_cap=truncation_cap,
                                  verify_citations=verify_citations)
        all_stats.append(stats)
        for c in rows:
            if c["tweet_id"] in seen:      # B2: cross-chunk dedupe on the STRING id
                continue
            seen.add(c["tweet_id"])
            candidates.append(c)

    report = merge_stats(all_stats)
    report["candidates_emitted"] = len(candidates)
    report["since"] = since
    report["until"] = until
    report["min_faves"] = int(min_faves)
    report["handles_requested"] = sum(len(c) for c in chunks)
    # B4: a 200/success:true response carrying zero in-window rows is the exact
    # shape that slips past the brief's Step-1.5 guard, posts a thin brief, and
    # then touches the PT-day lock — blocking retry for the whole day.
    report["empty_pool"] = (report["rows_after_window_filter"] == 0)
    report["alerts"] = _build_alerts(report)
    return candidates, report


def _build_alerts(report):
    a = []
    if report["empty_pool"]:
        a.append("EMPTY POOL: x_search returned 0 rows inside the window. "
                 "Do NOT touch the PT-day lock — retry must stay possible.")
    if not report["credential_ok"]:
        a.append(f"CREDENTIAL FALLBACK: credential_source={report['credential_sources']} "
                 f"(expected {REQUIRED_CREDENTIAL_SOURCE}) — possible SILENT METERED BILLING.")
    if report["chunks_failed"]:
        a.append(f"{report['chunks_failed']} of {report['x_search_calls']} chunks FAILED.")
    # A degraded chunk is normally just "nobody posted above the floor" (G7), so it is
    # informational at low rates. It only becomes a signal when it is the WHOLE run.
    if report["chunks_degraded"] and report["chunks_degraded"] == report["x_search_calls"]:
        a.append(f"ALL {report['chunks_degraded']} chunk(s) came back degraded (no citations "
                 f"anywhere) — the X index returned nothing; treat as a gather failure.")
    if report["truncated_handles"]:
        a.append(f"TRUNCATION TRIPWIRE: {sorted(set(report['truncated_handles']))} hit the "
                 f"row cap — re-query solo with a tighter since:/until:.")
    if report["rows_uncited"]:
        a.append(f"{report['rows_uncited']} row(s) dropped: tweet_id absent from the citation set.")
    return a


# ── CLI ──────────────────────────────────────────────────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(description="grok/x_search -> pipeline candidate rows")
    ap.add_argument("--handles-file", default=THOUGHT_LEADERS_FILE)
    ap.add_argument("--handle", action="append", default=[],
                    help="explicit handle (repeatable); overrides --handles-file")
    ap.add_argument("--solo-handle", action="append", default=[],
                    help="heavy account (>10 posts/day) to query SOLO (repeatable)")
    ap.add_argument("--since", help="ISO8601 window start (default: --window-hours ago)")
    ap.add_argument("--until", help="ISO8601 window end (default: now)")
    ap.add_argument("--window-hours", type=float, default=24.0)
    ap.add_argument("--min-faves", type=int, default=DEFAULT_MIN_FAVES)
    ap.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    ap.add_argument("--truncation-cap", type=int, default=DEFAULT_TRUNCATION_CAP)
    ap.add_argument("--no-citation-check", action="store_true",
                    help="disable the free hallucination guard (NOT recommended)")
    ap.add_argument("--no-tl-bypass", action="store_true",
                    help="apply the likes floor to thought-leaders too")
    ap.add_argument("--from-response", action="append", default=[],
                    help="adapt a pre-fetched x_search response JSON file (repeatable); no network")
    ap.add_argument("--out", help="write {candidates, report} here (default stdout)")
    ap.add_argument("--report", help="also write the report alone here")
    ap.add_argument("--print-query", action="store_true",
                    help="print the operator-syntax queries and exit (no network)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    now = _dt.datetime.now(_dt.timezone.utc)
    until = args.until or now.strftime("%Y-%m-%dT%H:%M:%SZ")
    until_dt = _parse_dt(until)
    if until_dt is None:
        print(f"xsearch_gather: unparseable --until {until!r}", file=sys.stderr)
        return 2
    since = args.since or (until_dt - _dt.timedelta(hours=args.window_hours)
                           ).strftime("%Y-%m-%dT%H:%M:%SZ")

    handles = args.handle or load_handles(args.handles_file)
    if not handles:
        print(f"xsearch_gather: no handles (checked {args.handles_file})", file=sys.stderr)
        return 2

    tl = [] if args.no_tl_bypass else load_handles(THOUGHT_LEADERS_FILE)

    if args.print_query:
        for ch in chunk_handles(handles, args.chunk_size, args.solo_handle):
            print(build_query(ch, since, until, args.min_faves))
            print("-" * 70)
        return 0

    responses = None
    if args.from_response:
        responses = []
        for p in args.from_response:
            with open(os.path.expanduser(p)) as f:
                responses.append(json.load(f))

    candidates, report = gather(
        handles, since, until, min_faves=args.min_faves, chunk_size=args.chunk_size,
        solo=args.solo_handle, bypass_handles=tl, responses=responses,
        truncation_cap=args.truncation_cap, verify_citations=not args.no_citation_check)

    payload = {"candidates": candidates, "report": report}
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        with open(os.path.expanduser(args.out), "w") as f:
            f.write(text)
    else:
        print(text)
    if args.report:
        with open(os.path.expanduser(args.report), "w") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"x_search_calls={report['x_search_calls']} ok={report['chunks_ok']} "
          f"failed={report['chunks_failed']} parsed={report['rows_parsed']} "
          f"malformed={report['rows_malformed']} uncited={report['rows_uncited']} "
          f"in_window={report['rows_after_window_filter']} "
          f"above_floor={report['rows_after_likes_filter']} "
          f"emitted={report['candidates_emitted']} "
          f"cred={report['credential_sources'] or ['none']}", file=sys.stderr)
    for a in report["alerts"]:
        print(f"🔴 {a}", file=sys.stderr)

    # B4: LOUD, non-zero exit on an empty pool so the caller alerts and does NOT
    # touch the day lock. A credential fallback is also fail-loud (silent metered
    # billing is exactly the thing this migration exists to avoid).
    if report["empty_pool"] or not report["credential_ok"]:
        return 3
    return 0


# ── Selftest ─────────────────────────────────────────────────────────────────
def _selftest():
    fails = []

    def check(cond, label):
        if not cond:
            fails.append(label)

    check(coerce_id(2081153980294648186) == "2081153980294648186", "coerce int id")
    check(coerce_id("2081153980294648186") == "2081153980294648186", "coerce str id")
    check(coerce_id("https://x.com/i/status/123") == "123", "coerce url id")
    check(coerce_id(None) == "" and coerce_id(True) == "", "coerce null/bool")
    check(normalize_ts("Fri, 24 Jul 2026 20:04:54 GMT") == "2026-07-24T20:04:54Z", "rfc1123")
    check(normalize_ts("2026-07-24T20:04:54Z") == "2026-07-24T20:04:54Z", "iso8601")
    check(normalize_ts("garbage") == "", "bad ts")
    q = build_query(["simonw", "karpathy"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z", 100)
    # QUERY FORM GATE (2026-07-27). The old assertion demanded the per-handle
    # repeated form — it encoded the BUG as the contract, which is why the 6x
    # recall loss shipped green. Multi-handle queries MUST group the handles into
    # one disjunction and state each filter ONCE; the repeated form silently
    # under-returns (10 handles @20000 -> 1 row vs 6, missing a 132k-like post).
    check("(from:simonw OR from:karpathy)" in q, "grouped disjunction form")
    check("min_faves:100 since:2026-07-24 until:2026-07-26" in q, "filters stated once")
    check(q.count("min_faves:") == 1, "min_faves NOT repeated per handle")
    check(q.count("since:") == 1 and q.count("until:") == 1, "window NOT repeated per handle")
    solo_q = build_query(["simonw"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z", 100)
    check("from:simonw min_faves:100 since:2026-07-24 until:2026-07-26" in solo_q,
          "single handle needs no parens")
    check("(" not in solo_q.split("\n")[0], "single-handle query is unparenthesized")
    check("simonw" in q and "karpathy" in q, "G1 handles in query text")
    check(len(chunk_handles(["a"] * 1 + [f"h{i}" for i in range(12)], 10, solo=["h0"])) == 3,
          "chunking")
    c = to_candidate({"handle": "simonw", "tweet_id": 123, "tweet_text": "hello world body",
                      "likes": 140, "retweets": 10, "created_at": "2026-07-25T23:05:49Z"})
    check(c["tweet_text"] == "hello world body", "B1 tweet_text")
    check(c["likes"] == 140 and c["public_metrics"]["like_count"] == 140, "B1 dual metrics")
    check(c["tweet_id"] == "123" and isinstance(c["tweet_id"], str), "B2 string id")
    check(c["source"] == "x", "source x")
    print(f"xsearch_gather selftest: {'PASS' if not fails else 'FAIL ' + repr(fails)}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
