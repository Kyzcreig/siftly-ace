#!/usr/bin/env python3
"""Fail-safe personal-fit scorer for Siftly brief candidates.

Input: JSON file path or stdin. Accepts either a list of candidates or an object with
`candidates`/`items`/`results` arrays. Candidate fields are intentionally loose:
text/title/summary/body/content, author/authorHandle/handle/source/url/id.

Output is always JSON and the script exits 0. Any error returns a base-score-only
sentinel so load-bearing brief crons continue unchanged.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_PROFILE = Path.home() / ".hermes/state/x-bookmarks/preference-profile.json"
DEFAULT_CONFIG = Path.home() / ".hermes/state/x-bookmarks/brief-config.json"
DEFAULT_WEIGHT = 30.0
WORD_RE = re.compile(r"[a-z0-9][a-z0-9+_.-]{1,}", re.I)
URL_RE = re.compile(r"https?://\S+", re.I)
X_STATUS_RE = re.compile(r"(?:x|twitter)\.com/([^/]+)/status/(\d+)", re.I)

TOPIC_ALIASES = {
    "dev-tools": ["agent", "agents", "coding", "developer", "devtools", "hermes", "codex", "claude", "cursor", "mcp", "github", "typescript", "python"],
    "ai-ml": ["ai", "llm", "model", "openai", "anthropic", "inference", "training", "eval", "benchmark", "rag", "embedding"],
    "startups-business": ["startup", "founder", "business", "agency", "company", "growth", "product", "sales"],
    "finance": ["market", "markets", "invest", "equity", "trading", "bitcoin", "crypto", "money", "fund"],
    "security-privacy": ["security", "privacy", "auth", "token", "exploit", "vulnerability", "malware"],
    "productivity": ["workflow", "automation", "productivity", "notes", "obsidian", "calendar"],
    "politics": ["policy", "politics", "election", "government", "law", "regulation"],
}


def fail(reason: str) -> None:
    print(json.dumps({"ok": False, "base_score_only": True, "reason": reason, "items": []}, ensure_ascii=False))


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_input(path: str | None) -> Any:
    if path and path != "-":
        return load_json(Path(path))
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty input")
    return json.loads(raw)


def candidates_from(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("candidates", "items", "results", "bookmarks"):
            val = data.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
    raise ValueError("input has no candidates/items/results array")


def normalize_weight(value: Any, default: float = DEFAULT_WEIGHT) -> float:
    try:
        n = float(value)
    except Exception:
        return default
    if not math.isfinite(n):
        return default
    return max(0.0, min(60.0, n))


def load_weight(config_path: Path) -> float:
    env = os.environ.get("PF_WEIGHT") or os.environ.get("SIFTLY_PF_WEIGHT")
    if env is not None:
        return normalize_weight(env)
    if config_path.exists():
        cfg = load_json(config_path)
        if isinstance(cfg, dict):
            return normalize_weight(cfg.get("PF_WEIGHT", cfg.get("pf_weight", DEFAULT_WEIGHT)))
    return DEFAULT_WEIGHT


def words(text: str) -> set[str]:
    return {m.group(0).lower() for m in WORD_RE.finditer(text)}


def text_of(c: dict[str, Any]) -> str:
    parts = []
    for key in ("title", "text", "summary", "body", "content", "description"):
        v = c.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(v)
    return "\n".join(parts)


def handle_of(c: dict[str, Any]) -> str | None:
    for key in ("authorHandle", "author_handle", "handle", "author", "username", "screen_name"):
        v = c.get(key)
        if isinstance(v, str) and v.strip():
            h = v.strip().lstrip("@").split()[0]
            if h:
                return h
    url = c.get("url")
    if isinstance(url, str):
        m = X_STATUS_RE.search(url)
        if m:
            return m.group(1)
    return None


def candidate_id(c: dict[str, Any], idx: int) -> str:
    for key in ("id", "tweetId", "tweet_id", "url"):
        v = c.get(key)
        if isinstance(v, (str, int)) and str(v):
            return str(v)
    return str(idx)


def topic_terms(name: str) -> set[str]:
    base = name.lower().replace("embedding-cluster:", "").replace("&", " ")
    terms = set(re.split(r"[-_/\s]+", base)) - {"and", "the", "for", "with"}
    for key, aliases in TOPIC_ALIASES.items():
        if key in base or any(part in base for part in key.split("-")):
            terms.update(aliases)
    return {t for t in terms if len(t) > 1}


def format_hits(c: dict[str, Any], text: str, favorite_formats: list[str]) -> list[str]:
    hay = text.lower()
    url = str(c.get("url", "")).lower()
    hits = []
    has_url = bool(URL_RE.search(text) or url)
    if has_url and "format:single" in favorite_formats:
        hits.append("format:single")
    if any(x in hay for x in ("thread", "1/", "🧵")) and "is_thread" in favorite_formats:
        hits.append("is_thread")
    if any(x in hay for x in ("quote", "quoted")) and "is_quote" in favorite_formats:
        hits.append("is_quote")
    if any(x in hay or x in url for x in ("video", "youtu", "watch")) and "has_video" in favorite_formats:
        hits.append("has_video")
    if any(x in hay for x in ("image", "screenshot", "chart", "meme")) and "has_image" in favorite_formats:
        hits.append("has_image")
    return hits[:5]


def score_candidate(c: dict[str, Any], idx: int, profile: dict[str, Any], weight: float) -> dict[str, Any]:
    text = text_of(c)
    token_set = words(text + " " + str(c.get("url", "")))
    handle = handle_of(c)
    author_hits = []
    topic_hits = []
    format_match = []
    downrank_hits = []

    authors_raw = profile.get("high_signal_authors")
    authors: list[Any] = authors_raw if isinstance(authors_raw, list) else []
    max_author_weight = max([float(a.get("weight", 0) or 0) for a in authors if isinstance(a, dict)] + [1.0])
    author_score = 0.0
    if handle:
        for a in authors:
            if not isinstance(a, dict):
                continue
            if str(a.get("handle", "")).lower().lstrip("@") == handle.lower():
                aw = float(a.get("weight", 0) or 0)
                author_score = min(1.0, aw / max_author_weight)
                author_hits.append({"handle": handle, "weight": round(aw, 3)})
                break

    topics_raw = profile.get("top_topics")
    topics: list[Any] = topics_raw if isinstance(topics_raw, list) else []
    topic_score = 0.0
    max_topic_weight = max([float(t.get("weight", 0) or 0) for t in topics if isinstance(t, dict)] + [1.0])
    for t in topics[:40]:
        if not isinstance(t, dict):
            continue
        name = str(t.get("name", ""))
        terms = topic_terms(name)
        overlap = sorted(token_set & terms)
        if not overlap:
            continue
        tw = float(t.get("weight", 0) or 0)
        contribution = min(0.35, (tw / max_topic_weight) * min(1.0, len(overlap) / 3.0))
        topic_score += contribution
        topic_hits.append({"topic": name, "terms": overlap[:5], "contribution": round(contribution, 3)})
        if len(topic_hits) >= 5:
            break
    topic_score = min(1.0, topic_score)

    fav_formats = [str(x) for x in profile.get("favorite_formats", []) if isinstance(x, str)]
    format_match = format_hits(c, text, fav_formats)
    format_score = min(1.0, len(format_match) / 3.0)

    for pat in profile.get("downrank_patterns", []) or []:
        if not isinstance(pat, str):
            continue
        p = pat.lower().replace("contrast:", "").replace("downrank:", "").strip()
        if p and p in " ".join(token_set):
            downrank_hits.append(pat)
    downrank_score = min(1.0, len(downrank_hits) / 3.0)

    raw = 0.42 * topic_score + 0.28 * author_score + 0.18 * format_score - 0.18 * downrank_score
    # Small source-specific prior: X candidates are more likely to be comparable to the corpus than generic web pages.
    source = str(c.get("source", "")).lower()
    url_value = c.get("url")
    if source == "x" or (isinstance(url_value, str) and X_STATUS_RE.search(url_value)):
        raw += 0.08
    raw = max(-1.0, min(1.0, raw))
    delta = raw * weight
    return {
        "index": idx,
        "id": candidate_id(c, idx),
        "url": c.get("url"),
        "title": c.get("title") or c.get("text"),
        "personal_fit_raw": round(raw, 4),
        "personal_fit_delta": round(delta, 2),
        "base_score_only": weight == 0,
        "signals": {
            "topic_score": round(topic_score, 4),
            "topic_hits": topic_hits,
            "author_score": round(author_score, 4),
            "author_hits": author_hits,
            "format_score": round(format_score, 4),
            "format_hits": format_match,
            "downrank_score": round(downrank_score, 4),
            "downrank_hits": downrank_hits,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="candidate JSON path; omit or '-' for stdin")
    ap.add_argument("--profile", default=str(DEFAULT_PROFILE))
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--timeout-self-test", action="store_true", help="emit fail-safe sentinel for tests")
    args = ap.parse_args()

    try:
        if args.timeout_self_test:
            fail("forced timeout/failure self-test")
            return 0
        profile_path = Path(args.profile)
        config_path = Path(args.config)
        profile = load_json(profile_path)
        weight = load_weight(config_path)
        data = load_input(args.input)
        candidates = candidates_from(data)
        items = [score_candidate(c, i, profile, weight) for i, c in enumerate(candidates)]
        print(json.dumps({
            "ok": True,
            "base_score_only": weight == 0,
            "profile_path": str(profile_path),
            "pf_weight": weight,
            "items": items,
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        fail(str(e))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
