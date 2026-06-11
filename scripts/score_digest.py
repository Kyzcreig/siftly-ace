#!/usr/bin/env python3
"""
score_digest.py — DETERMINISTIC digest scoring (model = qualitative labels only).

WHY THIS EXISTS
---------------
Per SPEC-deterministic-digest-scoring.md (v4, APPROVED 3-pass review). The model
has repeatedly proven bad at producing a quantitative 0-100 base_score in prose
(flat-rates X items at 80, scores a spam bot above @emollick, lets a 2-like
@yoheinakajima post hit 100). The fix, per Ace: the MODEL classifies (bounded
enum labels it's reliable at); PYTHON scores (a deterministic sum of named,
logged terms). This file is Python's half.

DESIGN (spec §4): final = clamp(0,100,
    BASE[content_type, actionability]        # 36-cell table, §4.1
  + SUBSTANCE_ADJ[substance]                 # §4
  + engagement_points(likes, rt, handle)     # log-scaled, unknown capped lower, §4.2
  + author_tier_points(handle)               # +8 TL / +6 tracked-author / 0, §4.3
  + pf_points(personal_fit_delta)            # bounded personal-fit, §4.3a (NOT folded away)
  + recency_points(published_at)             # §4.6
  + media_points(item)                       # §4.6
  - OFF_TOPIC_PEN[on_topic]                   # §4.5#2
)  then low_reach_cap() as a permanent floor-guard (§4.3).

The model emits ONLY enum labels (§3); this file never trusts a model number.
Every score carries a term-by-term breakdown into the debug dump (§5).

This module is PURE + SELFTESTED. It does NOT mutate prompt.md or any cron
config (that's the Hard-Config cutover, gated on Ace). It can run in SHADOW
mode (score in parallel, change nothing) — see score_pool() / --shadow.

USAGE
  score_digest.py --selftest                 # built-in checks, no I/O
  score_digest.py --shadow --in PATH --out PATH   # score a pool, write breakdowns (no posting)
"""
from __future__ import annotations
import argparse, json, math, os, re, sys, datetime

# Reuse the guard's TESTED handle/topic/text helpers so there is ONE source of
# truth for "is this a thought leader / on-topic / a bare fragment".
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from select_digest import (  # noqa: E402
    _load_thought_leaders, _load_tracked_projects,
    _handle, _is_thought_leader, _matches_tracked, is_on_topic,
    is_bare_fragment, _item_text, _engagement, _is_x, _substance, _LEADING_MENTIONS_RE,
    THOUGHT_LEADERS_FILE, TRACKED_PROJECTS_FILE,
)
# Reuse select_digest's TESTED dedup/distribution primitives so the shadow select
# pipeline is identical to the live one EXCEPT it consumes the new deterministic
# `_final` (single-authority, spec §4.4). These read/write the `_final` key that
# score_item() already sets, so they compose directly.
from select_digest import (  # noqa: E402
    _collapse_events as _sd_collapse_events,
    apply_forced_distribution as _sd_apply_forced_distribution,
)

# ── Gates (re-derived against the new score range, spec §6 step-2) ───────────
# The new BASE table tops at 70, so the OLD 83/77 gates are wrong by
# construction. Defaults below are the shadow-mode STARTING points; they are
# tunables re-derived from the shadow distribution before cutover.
TOP_GATE = 58
ALSO_GATE = 50
MAX_TOP = 5            # max Top Stories slots (mirrors select_digest)
MAX_ALSO = 2          # max Also Noted slots
MAX_GE_90 = 2          # forced-distribution carries over; unreachable unless tuned
MAX_EQ_100 = 1

# ── BASE: 36-cell categorical base, spec §4.1 ───────────────────────────────
# rows = content_type, cols = actionability (actionable_now|reference|context_only|none)
# Ordered high→low by base value so monotonicity is asserted over the real ladder.
CONTENT_TYPES = ["launch", "benchmark", "tutorial", "field_report",
                 "analysis", "news", "opinion", "promo", "reply_fragment"]
ACTIONABILITIES = ["actionable_now", "reference", "context_only", "none"]
BASE = {
    "launch":         {"actionable_now": 70, "reference": 60, "context_only": 48, "none": 40},
    "benchmark":      {"actionable_now": 66, "reference": 60, "context_only": 46, "none": 38},
    "field_report":   {"actionable_now": 60, "reference": 52, "context_only": 42, "none": 34},
    "tutorial":       {"actionable_now": 64, "reference": 58, "context_only": 44, "none": 34},
    "analysis":       {"actionable_now": 56, "reference": 50, "context_only": 40, "none": 30},
    "news":           {"actionable_now": 50, "reference": 44, "context_only": 36, "none": 28},
    "opinion":        {"actionable_now": 40, "reference": 34, "context_only": 25, "none": 18},
    "promo":          {"actionable_now": 5,  "reference": 5,  "context_only": 5,  "none": 5},
    "reply_fragment": {"actionable_now": 0,  "reference": 0,  "context_only": 0,  "none": 0},
}

SUBSTANCE_ADJ = {"concrete": 3, "mixed": 0, "vague": -5}
OFF_TOPIC_PEN = {"core": 0, "adjacent": 0, "off": 40}

# Engagement (§4.2): log-scaled, capped; unknown handles capped lower (anti-gaming).
ENGAGEMENT_K = 6
ENGAGEMENT_CAP = 15            # known / thought-leader / tracked-author handles
ENGAGEMENT_CAP_UNKNOWN = 6     # no-name accounts: cheap purchased likes can't buy a TOP slot

# Author tier (§4.3): additive, bounded.
AUTHOR_TL_POINTS = 8
AUTHOR_TRACKED_POINTS = 6

# Personal-fit (§4.3a): own bounded term, NOT folded into author tier.
PF_CAP = 12                    # down from today's uncapped ~24.6

# Recency (§4.6).
RECENCY_24H = 10
RECENCY_3D = 6
RECENCY_7D = 3

# Media (§4.6): monotonic video/transcript >= image >= none.
MEDIA_VIDEO = 4
MEDIA_IMAGE = 2

# Low-reach cap (§4.3): permanent floor-guard, COMPUTED below the gate (not the
# blind-inherited 70). Always strictly < ALSO_GATE by construction.
LOW_REACH_SCORE_CAP = ALSO_GATE - 5
LOW_REACH_ENGAGEMENT_FLOOR = 5

# Fresh-content floor (§4.2a): ships DARK for v1 (current ingest is ~daily, so
# tweets have engagement by scoring time). Only arms under near-real-time ingest.
FRESH_FLOOR_ENABLED = False
FRESH_FLOOR_BASE = 45

# Safe-default labels for malformed/missing model output (§3): never crash,
# never silent-zero. Maps to a mid-low base (opinion x context_only = 25).
SAFE_DEFAULT = {
    "content_type": "opinion", "actionability": "context_only",
    "substance": "mixed", "on_topic": "adjacent",
}
# Documented synonym map for near-miss labels (§3).
CONTENT_SYNONYMS = {
    "announcement": "launch", "release": "launch", "ship": "launch",
    "howto": "tutorial", "how_to": "tutorial", "guide": "tutorial",
    "review": "analysis", "deepdive": "analysis", "deep_dive": "analysis",
    "report": "field_report", "experience": "field_report",
    "take": "opinion", "commentary": "opinion", "thread": "analysis",
    "ad": "promo", "sponsored": "promo", "fragment": "reply_fragment", "reply": "reply_fragment",
}
ACTION_SYNONYMS = {
    "actionable": "actionable_now", "now": "actionable_now", "use_now": "actionable_now",
    "ref": "reference", "lookup": "reference",
    "context": "context_only", "background": "context_only",
    "na": "none", "nil": "none", "": "none",
}
SUBSTANCE_SYNONYMS = {"specific": "concrete", "detailed": "concrete", "solid": "concrete",
                      "partial": "mixed", "some": "mixed",
                      "empty": "vague", "thin": "vague", "fluff": "vague"}
ONTOPIC_SYNONYMS = {"on": "core", "primary": "core", "related": "adjacent",
                    "tangential": "adjacent", "off_topic": "off", "unrelated": "off"}

# Counter populated per pool run, surfaced for the #alerts threshold (§3).
LABEL_COERCION_ALERT_THRESHOLD = 8


def _norm(val, enum, synonyms, default):
    """Normalize one model label: strip/lower → synonym map → enum check →
    safe default. Returns (value, coerced_bool)."""
    if val is None:
        return default, True
    v = str(val).strip().lower().replace("-", "_")
    v = re.sub(r"[^a-z0-9_]", "", v)  # strip stray punctuation ("announcement!!" -> "announcement")
    if v in enum:
        return v, False
    if v in synonyms:
        mapped = synonyms[v]
        return mapped, (mapped != v)
    return default, True


def normalize_labels(item):
    """§3: coerce model labels to valid enums, fail-SAFE not silent.
    Returns (labels_dict, coerced_bool, raw_vs_coerced_dict)."""
    raw = {
        "content_type": item.get("content_type"),
        "actionability": item.get("actionability"),
        "substance": item.get("substance"),
        "on_topic": item.get("on_topic"),
    }
    ct, c1 = _norm(raw["content_type"], set(CONTENT_TYPES), CONTENT_SYNONYMS, SAFE_DEFAULT["content_type"])
    ac, c2 = _norm(raw["actionability"], set(ACTIONABILITIES), ACTION_SYNONYMS, SAFE_DEFAULT["actionability"])
    su, c3 = _norm(raw["substance"], set(SUBSTANCE_ADJ), SUBSTANCE_SYNONYMS, SAFE_DEFAULT["substance"])
    ot, c4 = _norm(raw["on_topic"], set(OFF_TOPIC_PEN), ONTOPIC_SYNONYMS, SAFE_DEFAULT["on_topic"])
    labels = {"content_type": ct, "actionability": ac, "substance": su, "on_topic": ot}
    coerced = c1 or c2 or c3 or c4
    return labels, coerced, raw


def engagement_points(item, is_known):
    eng = _engagement(item)
    raw = ENGAGEMENT_K * math.log10(1 + eng)
    cap = ENGAGEMENT_CAP if is_known else ENGAGEMENT_CAP_UNKNOWN
    return int(round(min(raw, cap)))


def author_tier_points(item, tl_handles, tl_aliases, tracked):
    """§4.3: authorship tier only. Tracked = AUTHORSHIP (handle), not a mention.
    Tracked-project mention drives the keyword boost in select_digest, but here
    only the AUTHOR's tier matters for points (mentions handled separately)."""
    if _is_thought_leader(item, tl_handles, tl_aliases):
        return AUTHOR_TL_POINTS, "thought_leader"
    h = _handle(item)
    if h and h in tracked:   # tracked AUTHOR (handle in tracked list)
        return AUTHOR_TRACKED_POINTS, "tracked_author"
    return 0, "unknown"


def pf_points(item):
    """§4.3a: bounded personal-fit; preserved, not deleted. Kill-switch: a 0
    delta (PF_WEIGHT=0 upstream) yields 0."""
    try:
        d = float(item.get("personal_fit_delta") or 0.0)
    except (TypeError, ValueError):
        d = 0.0
    return int(round(max(-PF_CAP, min(PF_CAP, d))))


def recency_points(item, now=None):
    ts = item.get("published_at") or item.get("created_at")
    if not ts:
        return 0
    dt = _parse_ts(ts)
    if dt is None:
        return 0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    age_h = (now - dt).total_seconds() / 3600.0
    if age_h <= 24:
        return RECENCY_24H
    if age_h <= 72:
        return RECENCY_3D
    if age_h <= 168:
        return RECENCY_7D
    return 0


def _parse_ts(ts):
    s = str(ts).strip().replace("Z", "+00:00")
    for fmt in (None,):  # try ISO first
        try:
            return datetime.datetime.fromisoformat(s)
        except ValueError:
            break
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def media_points(item):
    has_video = bool(item.get("has_video") or item.get("transcript") or item.get("video_transcript"))
    has_image = bool(item.get("has_image") or item.get("ocr_text"))
    mt = str(item.get("media_type") or "").lower()
    if mt in ("video", "gif") or has_video:
        return MEDIA_VIDEO
    if mt in ("photo", "image") or has_image:
        return MEDIA_IMAGE
    return 0


def low_reach_cap(item, is_known):
    """§4.3: permanent floor-guard. Unknown handle + engagement below floor on an
    X item → cap at LOW_REACH_SCORE_CAP (computed < ALSO_GATE)."""
    if not _is_x(item):
        return None
    if is_known:
        return None
    if _engagement(item) >= LOW_REACH_ENGAGEMENT_FLOOR:
        return None
    return LOW_REACH_SCORE_CAP


# ── Label-trust backstops (SPEC-label-trust-backstops.md) ───────────────────
# The model's on_topic/content_type labels are a HINT. Python verifies the cheap
# objective ones and can OVERRIDE toward exclusion (never upgrade). This fixes the
# 2026-06-11 @elonmusk "scumbag and traitor" miss: the model labeled a political
# reply fragment on_topic=core, and the deterministic scorer trusted it → 92.
ON_TOPIC_TOKENS = {
    "ai", "ml", "llm", "llms", "model", "models", "agent", "agents", "agentic",
    "gpu", "cuda", "code", "coding", "codex", "claude", "gpt", "gemini", "opus",
    "api", "sdk", "ship", "shipped", "shipping", "launch", "launched", "release",
    "released", "open", "source", "opensource", "weights", "benchmark", "eval",
    "evals", "prompt", "prompting", "finetune", "fine", "tuning", "rl", "rlhf",
    "inference", "repo", "github", "dataset", "training", "train", "transformer",
    "embedding", "embeddings", "rag", "vector", "token", "tokens", "context",
    "diffusion", "neural", "robot", "robotics", "compute", "datacenter", "chip",
    "anthropic", "openai", "deepmind", "nous", "hermes", "mcp", "tool", "tools",
    "app", "build", "building", "builder", "dev", "developer", "software",
    "startup", "founder", "product", "deploy", "framework", "library", "python",
    "typescript", "rust", "database", "server", "cloud", "kubernetes", "docker",
    # ML/architecture vocab (added 2026-06-11 after ylecun/emollick false-positives)
    "transformer", "transformers", "encoder", "encoders", "decoder", "predictor",
    "predictors", "jepa", "jepas", "attention", "guardrail", "guardrails", "fable",
    "mythos", "opus", "gemma", "llama", "mistral", "qwen", "grok", "diffusiongemma",
    "quantization", "lora", "distillation", "alignment", "safety", "jailbreak",
    "reasoning", "multimodal", "vision", "speech", "voice", "latency", "throughput",
    "fewshot", "zeroshot", "agentics", "orchestration", "pipeline", "eval", "evals",
    "scaling", "pretraining", "posttraining", "checkpoint", "weights", "params",
    "parameters", "architecture", "research", "paper", "arxiv", "sota", "frontier",
    "kernel", "tensor", "pytorch", "jax", "vllm", "cuda", "rocm", "datacenter",
}
# Off-topic markers: politics / insults / culture-war / non-AI-health. NOT used to
# force-off alone (too blunt) — used only as a confirming tie-breaker + to escalate
# a zero-on-topic-token post to a hard fragment-or-off.
OFF_TOPIC_MARKERS = {
    "scumbag", "traitor", "migrant", "migrants", "election", "woke", "communist",
    "fascist", "vaccine", "ivermectin", "leftist", "rightwing", "maga", "liberal",
    "conservative", "democrat", "republican", "trump", "biden", "politician",
    "deport", "border", "groomer", "shill", "clown", "idiot", "moron", "corrupt",
}


def _tokens(text):
    """Lowercase alnum word tokens of the post body (mentions/URLs stripped)."""
    return set(w.lower() for w in _substance(text))


def python_on_topic(item):
    """Independent topic check (does NOT trust the model label). Returns
    ('core'|'adjacent'|'off', reason). Fail-SAFE: only ever returns 'off' as an
    OVERRIDE signal; an item with real tech tokens is left to the model label."""
    text = _item_text(item)
    toks = _tokens(text)
    # NOTE: we deliberately do NOT trust item.signals.topic_hits here — the
    # enrichment auto-tags are as unreliable as the model label (the 2026-06-11
    # @elonmusk "scumbag and traitor" insult carried a bogus topic_hits=['ai']).
    # Only ACTUAL on-topic word tokens in the post body count as a topic signal.
    has_on_topic_token = bool(toks & ON_TOPIC_TOKENS)
    if has_on_topic_token:
        return None, None  # real tech tokens present → let the model label stand
    # zero on-topic signal at all → force off
    if toks & OFF_TOPIC_MARKERS:
        return "off", "python:no-tech-tokens+offtopic-marker"
    return "off", "python:no-tech-tokens"


def score_item(item, tl_handles, tl_aliases, tracked, now=None):
    """Deterministic score + term-by-term breakdown (§5). Returns dict with
    `_final` and `_breakdown`."""
    labels, coerced, raw = normalize_labels(item)

    # ── Backstop 1: fragment override (§3.1) — a bare reply fragment is forced to
    # content_type=reply_fragment (BASE 0) regardless of the model's label.
    frag_override = False
    if labels["content_type"] != "reply_fragment" and is_bare_fragment(_item_text(item)):
        labels = dict(labels); labels["content_type"] = "reply_fragment"
        frag_override = True

    # ── Backstop 2: off-topic override (§3.2) — independent Python topic check can
    # force on_topic→off when the text carries ZERO tech/AI tokens (fail-safe: only
    # downgrades core/adjacent→off, never upgrades off→core).
    eff_on_topic = labels["on_topic"]
    on_topic_override_reason = None
    py_ot, py_reason = python_on_topic(item)
    if py_ot == "off" and eff_on_topic != "off":
        eff_on_topic = "off"; on_topic_override_reason = py_reason

    ct, ac = labels["content_type"], labels["actionability"]
    base = BASE[ct][ac]

    is_known = _is_thought_leader(item, tl_handles, tl_aliases) or (_handle(item) in tracked)

    sub = SUBSTANCE_ADJ[labels["substance"]]
    eng = engagement_points(item, is_known)
    auth, auth_tier = author_tier_points(item, tl_handles, tl_aliases, tracked)
    # Author-tier bump is topic-gated (§4.3): only on_topic items get it. Uses the
    # EFFECTIVE (Python-verified) on_topic, not the raw model label.
    if auth and eff_on_topic == "off":
        auth, auth_tier = 0, auth_tier + "(off-topic→0)"
    pf = pf_points(item)
    rec = recency_points(item, now=now)
    med = media_points(item)
    off = OFF_TOPIC_PEN[eff_on_topic]

    pre = base + sub + eng + auth + pf + rec + med - off
    final = max(0.0, min(100.0, float(pre)))

    cap = low_reach_cap(item, is_known)
    capped = False
    if cap is not None and final > cap:
        final, capped = float(cap), True

    breakdown = {
        "base": base, "substance_adj": sub, "engagement": eng,
        "author": auth, "author_tier": auth_tier, "pf": pf,
        "recency": rec, "media": med, "off_topic_pen": -off,
        "pre_cap": round(float(pre), 1), "low_reach_capped": capped,
        "final": round(final, 1), "labels": labels,
        "label_coerced": coerced, "raw_labels": raw,
        "effective_on_topic": eff_on_topic,
        "on_topic_overridden": on_topic_override_reason,
        "fragment_overridden": frag_override,
    }
    out = dict(item)
    out["_final"] = final
    out["_breakdown"] = breakdown
    return out


def score_pool(pool, tl_handles=None, tl_aliases=None, tracked=None, now=None):
    """Score an entire pool. Returns (scored_sorted_desc, coercion_count)."""
    if tl_handles is None:
        tl_handles, tl_aliases = _load_thought_leaders()
    if tracked is None:
        tracked = set(_load_tracked_projects())
    elif not isinstance(tracked, set):
        tracked = set(tracked)
    scored = [score_item(it, tl_handles, tl_aliases or [], tracked, now=now) for it in pool]
    coercion = sum(1 for s in scored if s["_breakdown"]["label_coerced"])
    scored.sort(key=lambda s: s["_final"], reverse=True)
    return scored, coercion


def select_shadow(pool, tl_handles=None, tl_aliases=None, tracked=None, now=None):
    """Full deterministic SELECT pipeline (shadow-only — does NOT post).

    Single-authority per spec §4.4: score_digest.py owns the `final`; we then apply
    select_digest.py's TESTED event-collapse → forced-distribution → Top/Also gating
    on top of it. Returns (selected, also, discarded, meta). Mirrors
    select_digest.select() but fed by the new deterministic scorer, so the dry-run
    preview is faithful (deduped, capped, distributed) — closing the 3 gaps the raw
    --shadow score dump showed (dupes, >MAX_TOP overflow, no distribution).
    """
    if tl_handles is None:
        tl_handles, tl_aliases = _load_thought_leaders()
    if tracked is None:
        tracked = set(_load_tracked_projects())
    elif not isinstance(tracked, set):
        tracked = set(tracked)

    scored, discarded = [], []
    for raw in pool:
        # Backstop 1 also lives in score_item, but mirror select_digest's pre-filter
        # so a bare fragment is dropped (not just zero-based) for parity.
        if is_bare_fragment(_item_text(raw)):
            d = dict(raw); d["_drop"] = "bare_fragment"; discarded.append(d); continue
        scored.append(score_item(raw, tl_handles, tl_aliases or [], tracked, now=now))

    scored.sort(key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)

    # Event-collapse (5 accounts on one launch → 1 winner) BEFORE gating.
    scored, event_dropped = _sd_collapse_events(scored)
    discarded.extend(event_dropped)

    # Forced distribution (anti-inflation), then re-sort for placement.
    scored = _sd_apply_forced_distribution(scored)
    scored.sort(key=lambda it: (it["_final"], _engagement(it), _item_text(it)), reverse=True)

    selected, also = [], []
    for it in scored:
        f = it["_final"]
        if f >= TOP_GATE and len(selected) < MAX_TOP:
            selected.append(it)
        elif f >= ALSO_GATE and len(also) < MAX_ALSO:
            also.append(it)
        else:
            d = dict(it); d["_drop"] = "below_gate_or_cap"; discarded.append(d)

    coercion = sum(1 for it in scored if it["_breakdown"]["label_coerced"])
    overrides = sum(1 for it in scored if it["_breakdown"]["on_topic_overridden"])
    meta = {"scored": len(scored), "label_coercion_count": coercion,
            "on_topic_overrides": overrides,
            "gates": {"top": TOP_GATE, "also": ALSO_GATE, "low_reach_cap": LOW_REACH_SCORE_CAP},
            "cleared_top": sum(1 for it in scored if it["_final"] >= TOP_GATE),
            "cleared_also": sum(1 for it in scored if it["_final"] >= ALSO_GATE)}
    return selected, also, discarded, meta


# ── Selftests (spec §7 acceptance) ──────────────────────────────────────────
def _selftest():
    fails = []

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    # --- §4.1 BASE table integrity ---
    check(set(BASE) == set(CONTENT_TYPES), "BASE rows != CONTENT_TYPES")
    for ct in CONTENT_TYPES:
        check(set(BASE[ct]) == set(ACTIONABILITIES), f"BASE[{ct}] cols wrong")
    check(sum(len(v) for v in BASE.values()) == 36, "BASE is not 36 cells")
    # column monotonicity: launch >= benchmark >= ... >= reply_fragment
    for ac in ACTIONABILITIES:
        col = [BASE[ct][ac] for ct in CONTENT_TYPES]
        check(col == sorted(col, reverse=True), f"BASE column {ac} not monotonic: {col}")
    # row monotonicity: actionable_now >= reference >= context_only >= none
    for ct in CONTENT_TYPES:
        row = [BASE[ct][a] for a in ACTIONABILITIES]
        check(row == sorted(row, reverse=True), f"BASE row {ct} not monotonic: {row}")

    # --- §4.6 media monotonic ---
    check(MEDIA_VIDEO >= MEDIA_IMAGE >= 0, "media not monotonic")

    # --- §4.3 cap strictly below gate (the Pass-3 fix) ---
    check(LOW_REACH_SCORE_CAP < ALSO_GATE, f"LOW_REACH_SCORE_CAP {LOW_REACH_SCORE_CAP} !< ALSO_GATE {ALSO_GATE}")
    check(ALSO_GATE <= TOP_GATE, "ALSO_GATE > TOP_GATE")

    tl_h, tl_a = {"emollick", "karpathy", "yoheinakajima"}, []
    trk = {"langchain"}

    def s(item):
        return score_item(item, tl_h, tl_a, trk)["_breakdown"]

    # --- Incident pool: spam bot < @emollick (§7) ---
    spam = {"source": "x", "authorHandle": "bitnewsbot", "content_type": "promo",
            "actionability": "none", "substance": "vague", "on_topic": "off",
            "likes": 0, "retweets": 0, "tweet_text": "#bitcoin #cryptonews pump now"}
    emollick = {"source": "x", "authorHandle": "emollick", "content_type": "analysis",
                "actionability": "reference", "substance": "concrete", "on_topic": "core",
                "likes": 249, "retweets": 30, "tweet_text": "Here's how the new routing model changes agent design ..."}
    fs, fe = score_item(spam, tl_h, tl_a, trk)["_final"], score_item(emollick, tl_h, tl_a, trk)["_final"]
    check(fs < fe, f"spam {fs} not < emollick {fe}")
    check(fs < ALSO_GATE, f"spam {fs} cleared ALSO_GATE")

    # --- @yoheinakajima 2-like CANNOT reach 100 (the headline fix, §4.2) ---
    yohei = {"source": "x", "authorHandle": "yoheinakajima", "content_type": "opinion",
             "actionability": "context_only", "substance": "mixed", "on_topic": "core",
             "likes": 2, "retweets": 0, "personal_fit_delta": 24.6,
             "tweet_text": "interesting thought about agents and memory loops here"}
    fy = score_item(yohei, tl_h, tl_a, trk)["_final"]
    check(fy < 100, f"yohei reached {fy} (must be <100)")
    check(fy < 90, f"yohei {fy} still inflated (pf should be capped at {PF_CAP})")

    # --- engagement is a CONTINUOUS term: identical labels rank by engagement (§7) ---
    lowE = {"source": "x", "authorHandle": "karpathy", "content_type": "field_report",
            "actionability": "reference", "substance": "concrete", "on_topic": "core",
            "likes": 8, "retweets": 1, "tweet_text": "shipped a thing that does X reliably now"}
    hiE = dict(lowE); hiE["likes"] = 15000; hiE["retweets"] = 2000
    fl, fh = score_item(lowE, tl_h, tl_a, trk)["_final"], score_item(hiE, tl_h, tl_a, trk)["_final"]
    check(fh > fl, f"high-engagement {fh} not > low {fl} on identical labels")

    # --- pf preserved but bounded (§4.3a): pf term never exceeds PF_CAP ---
    bd = s(yohei)
    check(bd["pf"] <= PF_CAP, f"pf {bd['pf']} exceeded cap {PF_CAP}")
    # kill-switch: 0 delta -> 0 pf
    z = dict(lowE); z["personal_fit_delta"] = 0
    check(score_item(z, tl_h, tl_a, trk)["_breakdown"]["pf"] == 0, "pf kill-switch broken")

    # --- malformed labels: NEVER crash, NEVER silent-zero (§3) ---
    bad = {"source": "x", "authorHandle": "someuser", "content_type": "ANNOUNCEMENT!!",
           "actionability": None, "substance": "???", "on_topic": "whatever",
           "likes": 500, "retweets": 50, "tweet_text": "we just launched the new SDK with full docs"}
    bbd = s(bad)
    check(bbd["label_coerced"] is True, "malformed labels not flagged coerced")
    check(bbd["final"] > 0, "malformed labels silent-zeroed a real post")
    # 'ANNOUNCEMENT' -> synonym 'launch'; None actionability -> safe default
    check(bbd["labels"]["content_type"] == "launch", f"synonym map failed: {bbd['labels']}")

    # --- low-reach cap is the permanent floor-guard (§4.3) ---
    lowreach = {"source": "x", "authorHandle": "nobody", "content_type": "launch",
                "actionability": "actionable_now", "substance": "concrete", "on_topic": "core",
                "likes": 1, "retweets": 0, "personal_fit_delta": 12,
                "tweet_text": "huge launch everyone must see this incredible new tool"}
    lrf = score_item(lowreach, tl_h, tl_a, trk)
    check(lrf["_final"] <= LOW_REACH_SCORE_CAP, f"low-reach {lrf['_final']} > cap {LOW_REACH_SCORE_CAP}")
    check(lrf["_breakdown"]["low_reach_capped"] is True, "low-reach cap did not fire")
    # thought-leader with 0 reach is EXEMPT (don't bury a 0-like Karpathy gem)
    karpathy = dict(lowreach); karpathy["authorHandle"] = "karpathy"
    check(score_item(karpathy, tl_h, tl_a, trk)["_breakdown"]["low_reach_capped"] is False,
          "thought-leader wrongly low-reach-capped")

    # --- off-topic: TL bump gated off + penalty applied (§4.3/§4.5) ---
    offtop = {"source": "x", "authorHandle": "emollick", "content_type": "opinion",
              "actionability": "context_only", "substance": "mixed", "on_topic": "off",
              "likes": 100, "retweets": 5, "tweet_text": "political hot take unrelated to AI"}
    obd = s(offtop)
    check(obd["author"] == 0, f"off-topic TL still got author bump: {obd['author']}")
    check(obd["off_topic_pen"] == -OFF_TOPIC_PEN["off"], "off-topic penalty not applied")

    # --- Backstop: @elonmusk "scumbag and traitor" political reply (2026-06-11 miss) ---
    # Model mislabeled it content_type=field_report, on_topic=core. Backstops must
    # force it off-topic and drop it below the gate despite 5264 likes + TL author.
    elon_insult = {"source": "x", "authorHandle": "elonmusk",
                   "content_type": "field_report", "actionability": "reference",
                   "substance": "mixed", "on_topic": "core",
                   "likes": 5264, "retweets": 440,
                   "tweet_text": "@IterIntellectus @ZackPolanski Yes, he is a scumbag and traitor"}
    eb = score_item(elon_insult, tl_h, tl_a, trk)
    check(eb["_breakdown"]["effective_on_topic"] == "off",
          f"elon insult not forced off-topic: {eb['_breakdown']['effective_on_topic']}")
    check(eb["_breakdown"]["author"] == 0, f"elon insult still got author bump: {eb['_breakdown']['author']}")
    check(eb["_final"] < ALSO_GATE, f"elon insult {eb['_final']} still >= ALSO_GATE {ALSO_GATE}")

    # --- No-regression: a REAL on-topic TL post is NOT forced off ---
    real_ai = {"source": "x", "authorHandle": "karpathy",
               "content_type": "analysis", "actionability": "reference",
               "substance": "concrete", "on_topic": "core", "likes": 1200, "retweets": 90,
               "tweet_text": "The new model's attention pattern changes how you should structure agent prompts — here's why"}
    rb = score_item(real_ai, tl_h, tl_a, trk)
    check(rb["_breakdown"]["effective_on_topic"] == "core",
          f"real AI post wrongly forced off: {rb['_breakdown']['effective_on_topic']}")
    check(rb["_breakdown"]["author"] == AUTHOR_TL_POINTS, "real AI post lost its author bump")

    # --- non-X items are exempt from the low-reach cap ---
    story = {"source": "hackernews", "title": "Show HN: a new thing", "content_type": "launch",
             "actionability": "actionable_now", "substance": "concrete", "on_topic": "core",
             "hn_points": 3}
    check(score_item(story, tl_h, tl_a, trk)["_breakdown"]["low_reach_capped"] is False,
          "non-X story wrongly low-reach-capped")

    # --- Integration seam: select_shadow dedups, caps, distributes (§4.4) ---
    base_item = lambda h, txt, likes=500: {
        "source": "x", "authorHandle": h, "content_type": "launch",
        "actionability": "actionable_now", "substance": "concrete", "on_topic": "core",
        "likes": likes, "retweets": 10, "tweet_text": txt}
    # 3 accounts reporting the SAME launch event (shared distinctive phrase) → collapse to 1
    dup_pool = [
        base_item("acct1", "DiffusionGemma is now available lightning fast text diffusion model launch"),
        base_item("acct2", "DiffusionGemma is now available lightning fast text diffusion model launch today"),
        base_item("acct3", "DiffusionGemma is now available lightning fast text diffusion model release"),
        base_item("karpathy", "Shipped a new agent orchestration framework with full eval suite and docs", 2000),
        base_item("nobody", "random unrelated on-topic AI tool announcement with code repo here", 800),
    ]
    sel, also2, disc, meta2 = select_shadow(dup_pool, tl_h, tl_a, trk)
    check(len(sel) <= MAX_TOP, f"select exceeded MAX_TOP: {len(sel)}")
    check(len(also2) <= MAX_ALSO, f"select exceeded MAX_ALSO: {len(also2)}")
    # the 3 DiffusionGemma dupes must collapse to exactly 1 in the output
    all_out = sel + also2
    dg = [it for it in all_out if "diffusiongemma" in _item_text(it).lower()]
    check(len(dg) <= 1, f"event-collapse failed: {len(dg)} DiffusionGemma items survived")
    check(any(it.get("_drop") == "event_dup" for it in disc), "no event_dup in discarded")

    if fails:
        print("SELFTEST FAILED:")
        for f in fails:
            print("  -", f)
        return 1
    print(f"score_digest selftest OK (gates TOP={TOP_GATE}/ALSO={ALSO_GATE}, cap={LOW_REACH_SCORE_CAP}, PF_CAP={PF_CAP})")
    print(f"  spam={fs} < emollick={fe} | yohei(2-like,pf24.6)={fy} <90 | eng {fl}->{fh}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--shadow", action="store_true", help="score a pool, write breakdowns, change nothing")
    ap.add_argument("--select", action="store_true", help="full deterministic select pipeline (dedup+distribution+gates), shadow preview — no posting")
    ap.add_argument("--in", dest="inp", default=None)
    ap.add_argument("--out", dest="out", default=None)
    args = ap.parse_args()

    if args.selftest:
        sys.exit(_selftest())

    if args.select:
        src = args.inp or os.path.expanduser("~/.hermes/state/cron/morning-digest/_last_run_debug.json")
        data = json.load(open(src))
        pool = data.get("all_scored") or data.get("pool") or []
        selected, also, discarded, meta = select_shadow(pool)
        out = args.out or os.path.expanduser("~/.hermes/state/cron/morning-digest/_shadow_select.json")
        def slim(it):
            b = it["_breakdown"]
            return {"handle": _handle(it), "final": it["_final"],
                    "text": (_item_text(it) or "")[:120],
                    "content_type": b["labels"]["content_type"],
                    "effective_on_topic": b["effective_on_topic"],
                    "breakdown": {k: b[k] for k in ("base","engagement","author","pf","off_topic_pen")}}
        payload = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "mode": "select-shadow", "meta": meta,
                   "selected": [slim(i) for i in selected],
                   "also": [slim(i) for i in also]}
        json.dump(payload, open(out, "w"), indent=2)
        print(f"select-shadow: {len(selected)} top + {len(also)} also (of {meta['scored']}); "
              f"{meta['on_topic_overrides']} off-topic overrides, {meta['label_coercion_count']} coerced -> {out}")
        return

    if args.shadow:
        src = args.inp or os.path.expanduser("~/.hermes/state/cron/morning-digest/_last_run_debug.json")
        data = json.load(open(src))
        pool = data.get("all_scored") or data.get("pool") or []
        scored, coercion = score_pool(pool)
        out = args.out or os.path.expanduser("~/.hermes/state/cron/morning-digest/_shadow_scores.json")
        payload = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "mode": "shadow",
            "label_coercion_count": coercion,
            "label_coercion_alert": coercion >= LABEL_COERCION_ALERT_THRESHOLD,
            "gates": {"top": TOP_GATE, "also": ALSO_GATE, "low_reach_cap": LOW_REACH_SCORE_CAP},
            "scored": [{"id": s.get("id") or s.get("tweet_id"),
                        "handle": _handle(s), "old_final": s.get("final_score"),
                        "new_final": s["_final"], "breakdown": s["_breakdown"]}
                       for s in scored],
        }
        json.dump(payload, open(out, "w"), indent=2)
        print(f"shadow: scored {len(scored)} items, {coercion} coerced -> {out}")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
