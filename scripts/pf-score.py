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
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_PROFILE = Path.home() / ".hermes/state/x-bookmarks/preference-profile.json"
DEFAULT_CONFIG = Path.home() / ".hermes/state/x-bookmarks/brief-config.json"
DEFAULT_WEIGHT = 30.0
DEFAULT_BASELINE = 0.18
DEFAULT_AFFINITY_MODE = "shadow"
AFFINITY_MODES = {"keyword", "embed", "shadow", "fused"}
EMBED_KNN = 50
EMBED_TOP_K = 5
REPO_ROOT = Path(__file__).resolve().parents[1]
WORD_RE = re.compile(r"[a-z0-9][a-z0-9+_.-]{1,}", re.I)
URL_RE = re.compile(r"https?://\S+", re.I)
X_STATUS_RE = re.compile(r"(?:x|twitter)\.com/([^/]+)/status/(\d+)", re.I)

TOPIC_ALIASES = {
    "dev-tools": ["agent", "agents", "coding", "developer", "devtools", "hermes", "codex", "claude", "cursor", "mcp", "github", "typescript", "python"],
    "ai-ml": ["ai", "llm", "model", "openai", "anthropic", "inference", "training", "eval", "benchmark", "rag", "embedding"],
    "startups-business": ["startup", "founder", "business", "agency", "company", "growth", "product", "sales"],
    "finance": ["market", "markets", "invest", "equity", "money", "fund"],
    "security-privacy": ["security", "privacy", "auth", "token", "exploit", "vulnerability", "malware"],
    "productivity": ["workflow", "automation", "productivity", "notes", "obsidian", "calendar"],
    "politics": ["policy", "politics", "election", "government", "law", "regulation"],
}

EMBED_AFFINITY_TS = r'''
import Database from 'better-sqlite3'
import { createEmbeddingProviderFromEnv, type EmbeddingProvider } from './src/lib/search/embeddings'
import { openVectorStore, resolveDatabasePath } from './src/lib/vec'
import { SIFTLY_VEC_METRIC } from './src/lib/vec-metric'

const KNN_LIMIT = 50
const TOP_K = 5

interface CandidatePayload {
  index: number
  id: string
  text: string
}

interface Payload {
  candidates: CandidatePayload[]
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

class KeywordEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions: number

  constructor(private readonly terms: string[], model: string) {
    this.model = model
    this.dimensions = terms.length
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => keywordVector(text, this.terms))
  }
}

function embeddingProvider(): EmbeddingProvider {
  if (process.env.PF_EMBED_AFFINITY_TEST_PROVIDER === 'keyword') {
    const terms = (process.env.PF_EMBED_AFFINITY_TEST_TERMS ?? '')
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
    if (terms.length === 0) throw new Error('PF_EMBED_AFFINITY_TEST_TERMS is required for keyword test provider')
    return new KeywordEmbeddingProvider(terms, process.env.SIFTLY_EMBED_MODEL ?? 'pf-score-keyword-test-v1')
  }
  return createEmbeddingProviderFromEnv(process.env)
}

function keywordVector(text: string, terms: string[]): number[] {
  const normalized = text.toLowerCase().replace(/sqlite-vec/g, 'sqlite vec')
  const tokens = new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean))
  return terms.map((term) => (tokens.has(term) ? 1 : 0))
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function sourceWeight(source: string | undefined): number {
  const normalized = (source ?? '').toLowerCase()
  if (normalized === 'bookmark') return 1.0
  if (normalized === 'like') return 0.3
  return 0
}

async function main(): Promise<void> {
  const raw = await readStdin()
  const payload = JSON.parse(raw) as Payload
  if (process.env.PF_EMBED_AFFINITY_FORCE_FAILURE === '1') {
    throw new Error('forced embedding affinity failure')
  }

  const dbPath = resolveDatabasePath(process.env.DATABASE_URL ?? 'file:./prisma/dev.db', process.cwd())
  const db = new Database(dbPath)
  const store = openVectorStore({ dbPath, env: process.env })
  try {
    if (store.mode !== 'sqlite-vec') {
      throw new Error(`sqlite-vec unavailable: ${store.status.reason}${store.status.error ? ` (${store.status.error})` : ''}`)
    }

    const provider = embeddingProvider()
    const vectors = await provider.embed(payload.candidates.map((candidate) => candidate.text))
    if (vectors.length !== payload.candidates.length) {
      throw new Error(`embedding provider returned ${vectors.length} vectors for ${payload.candidates.length} candidates`)
    }

    const items = payload.candidates.map((candidate, i) => {
      const vector = vectors[i]
      const neighbors = store.search(vector, KNN_LIMIT, provider.model)
      if (neighbors.some((neighbor) => neighbor.mode !== 'sqlite-vec')) {
        throw new Error('sqlite-vec silently demoted during KNN search')
      }

      const ids = neighbors.map((neighbor) => neighbor.bookmarkId)
      const sourceById = new Map<string, string>()
      if (ids.length > 0) {
        const rows = db.prepare(`SELECT id, source FROM Bookmark WHERE id IN (${placeholders(ids.length)})`).all(...ids) as { id: string, source: string }[]
        for (const row of rows) sourceById.set(row.id, row.source)
      }

      const weighted = [] as Array<{ bookmarkId: string, score: number, distance: number, source: string, weight: number }>
      for (const neighbor of neighbors) {
        const source = sourceById.get(neighbor.bookmarkId) ?? ''
        const weight = sourceWeight(source)
        if (weight <= 0) continue
        weighted.push({
          bookmarkId: neighbor.bookmarkId,
          score: neighbor.score,
          distance: neighbor.distance,
          source,
          weight,
        })
        if (weighted.length >= TOP_K) break
      }

      const weightSum = weighted.reduce((sum, neighbor) => sum + neighbor.weight, 0)
      if (weightSum <= 0) {
        throw new Error(`no bookmark/like positive neighbors for candidate ${candidate.id}`)
      }
      const affinity = weighted.reduce((sum, neighbor) => sum + neighbor.score * neighbor.weight, 0) / weightSum

      return {
        index: candidate.index,
        id: candidate.id,
        affinity,
        neighbors: weighted.map((neighbor) => ({
          bookmarkId: neighbor.bookmarkId,
          source: neighbor.source,
          weight: neighbor.weight,
          score: neighbor.score,
          distance: neighbor.distance,
        })),
      }
    })

    console.log(JSON.stringify({
      ok: true,
      affinity_source: 'embed',
      vec_metric: SIFTLY_VEC_METRIC,
      model: provider.model,
      db_path: dbPath,
      items,
    }))
  } finally {
    store.close()
    db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
'''


def fail(reason: str, affinity_mode: str | None = None) -> None:
    payload = {"ok": False, "base_score_only": True, "reason": reason, "items": [], "affinity_source": "sentinel"}
    if affinity_mode:
        payload["affinity_mode"] = affinity_mode
    print(json.dumps(payload, ensure_ascii=False))


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_config_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        cfg = load_json(path)
    except Exception:
        return {}
    return cfg if isinstance(cfg, dict) else {}


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
    cfg = load_config_dict(config_path)
    if cfg:
        return normalize_weight(cfg.get("PF_WEIGHT", cfg.get("pf_weight", DEFAULT_WEIGHT)))
    return DEFAULT_WEIGHT


def normalize_baseline(value: Any, default: float = DEFAULT_BASELINE) -> float:
    try:
        n = float(value)
    except Exception:
        return default
    if not math.isfinite(n):
        return default
    # Baseline is subtracted from the affinity (which lives in [-1, 1]); keep it sane.
    return max(0.0, min(1.0, n))


def load_baseline(config_path: Path) -> float:
    env = os.environ.get("PF_BASELINE") or os.environ.get("SIFTLY_PF_BASELINE")
    if env is not None:
        return normalize_baseline(env)
    cfg = load_config_dict(config_path)
    if cfg:
        return normalize_baseline(cfg.get("PF_BASELINE", cfg.get("pf_baseline", DEFAULT_BASELINE)))
    return DEFAULT_BASELINE


def normalize_affinity_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    if mode in AFFINITY_MODES:
        return mode
    return DEFAULT_AFFINITY_MODE


def load_affinity_mode(config_path: Path) -> str:
    if "PF_AFFINITY_MODE" in os.environ:
        return normalize_affinity_mode(os.environ.get("PF_AFFINITY_MODE"))
    if "SIFTLY_PF_AFFINITY_MODE" in os.environ:
        return normalize_affinity_mode(os.environ.get("SIFTLY_PF_AFFINITY_MODE"))
    cfg = load_config_dict(config_path)
    if cfg:
        return normalize_affinity_mode(cfg.get("PF_AFFINITY_MODE", cfg.get("pf_affinity_mode", DEFAULT_AFFINITY_MODE)))
    return DEFAULT_AFFINITY_MODE


def words(text: str) -> set[str]:
    return {m.group(0).lower() for m in WORD_RE.finditer(text)}


def text_of(c: dict[str, Any]) -> str:
    parts = []
    for key in ("title", "text", "summary", "body", "content", "description"):
        v = c.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(v)
    return "\n".join(parts)


def embedding_text_of(c: dict[str, Any]) -> str:
    parts = [text_of(c)]
    for label, key in (("source", "source"), ("url", "url"), ("author", "authorHandle"), ("author", "author_handle"), ("author", "handle")):
        value = c.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(f"{label}: {value.strip()}")
    return "\n".join(part for part in parts if part)


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


def score_candidate(c: dict[str, Any], idx: int, profile: dict[str, Any], weight: float,
                    baseline: float = DEFAULT_BASELINE, affinity_source: str = "keyword_fallback") -> dict[str, Any]:
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

    affinity = 0.42 * topic_score + 0.28 * author_score + 0.18 * format_score - 0.18 * downrank_score
    # Small source-specific prior: X candidates are more likely to be comparable to the corpus than generic web pages.
    source = str(c.get("source", "")).lower()
    url_value = c.get("url")
    if source == "x" or (isinstance(url_value, str) and X_STATUS_RE.search(url_value)):
        affinity += 0.08
    affinity = max(-1.0, min(1.0, affinity))
    # Downshift by the corpus baseline so the layer is a true up/down signal: items below the
    # typical affinity floor get a NEGATIVE delta (penalized) instead of a universal positive lift.
    # PF_BASELINE=0 restores the legacy "lift everything" behavior.
    raw = max(-1.0, min(1.0, affinity - baseline))
    delta = raw * weight
    source_tag = "sentinel" if weight == 0 else affinity_source
    return {
        "index": idx,
        "id": candidate_id(c, idx),
        "url": c.get("url"),
        "title": c.get("title") or c.get("text"),
        "personal_fit_raw": round(raw, 4),
        "personal_fit_affinity": round(affinity, 4),
        "personal_fit_delta": round(delta, 2),
        "affinity_source": source_tag,
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


def run_embed_affinity(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    payload = {
        "candidates": [
            {"index": i, "id": candidate_id(c, i), "text": embedding_text_of(c)}
            for i, c in enumerate(candidates)
        ]
    }
    tsx = REPO_ROOT / "node_modules" / ".bin" / "tsx"
    cmd = [str(tsx), "--eval", EMBED_AFFINITY_TS] if tsx.exists() else ["npx", "tsx", "--eval", EMBED_AFFINITY_TS]
    timeout = normalize_timeout(os.environ.get("PF_EMBED_AFFINITY_TIMEOUT"), default=25.0)
    proc = subprocess.run(
        cmd,
        input=json.dumps(payload),
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "embedding affinity helper failed").strip()
        raise RuntimeError(detail.splitlines()[-1] if detail else "embedding affinity helper failed")
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"embedding affinity helper returned invalid JSON: {e}") from e
    if not isinstance(parsed, dict) or not parsed.get("ok"):
        raise RuntimeError(str(parsed.get("reason") if isinstance(parsed, dict) else "embedding affinity helper failed"))
    return parsed


def normalize_timeout(value: Any, default: float) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(timeout) or timeout <= 0:
        return default
    return min(timeout, 120.0)


def apply_embed_affinity(item: dict[str, Any], embed_item: dict[str, Any], weight: float, baseline: float) -> dict[str, Any]:
    keyword_affinity = float(item.get("personal_fit_affinity", 0) or 0)
    embed_affinity = float(embed_item.get("affinity", 0) or 0)
    combined_affinity = max(-1.0, min(1.0, embed_affinity + 0.2 * keyword_affinity))
    raw = max(-1.0, min(1.0, combined_affinity - baseline))
    delta = raw * weight
    out = dict(item)
    out.update({
        "keyword_personal_fit_affinity": item.get("personal_fit_affinity"),
        "keyword_personal_fit_raw": item.get("personal_fit_raw"),
        "keyword_personal_fit_delta": item.get("personal_fit_delta"),
        "personal_fit_affinity": round(combined_affinity, 4),
        "personal_fit_raw": round(raw, 4),
        "personal_fit_delta": round(delta, 2),
        "embedding_affinity": round(embed_affinity, 4),
        "keyword_secondary_affinity": round(0.2 * keyword_affinity, 4),
        "affinity_source": "embed",
        "vec_metric": embed_item.get("vec_metric"),
    })
    signals = dict(out.get("signals") or {})
    signals["embedding_affinity"] = round(embed_affinity, 4)
    signals["keyword_secondary_affinity"] = round(0.2 * keyword_affinity, 4)
    out["signals"] = signals
    return out


def apply_shadow_affinity(item: dict[str, Any], embed_item: dict[str, Any], weight: float, baseline: float) -> dict[str, Any]:
    out = dict(item)
    return out


def apply_fused_affinity(items: list[dict[str, Any]], embed_items: dict[int, dict[str, Any]],
                         weight: float, baseline: float, vec_metric: str | None) -> list[dict[str, Any]]:
    """FUSED PF (Ace-approved 2026-06-20): combine the keyword and embed signals at
    the DELTA level with equal weight, after centering the embed delta by the pool
    mean. This is the exact formula Ace eyeballed+approved in the daily preview's
    FUSED column — NOT the affinity-level `embed + 0.2*keyword` blend of embed mode.

    Per item:  fused_delta = (keyword_delta + (embed_delta - mean_embed_delta)) / 2

    Centering by the pool mean cancels the embed delta's miscalibrated near-uniform
    offset (~+10.6) while preserving its ORDERING (centering is monotonic); the
    keyword delta is already ~centered. The result lives on keyword's scale, so the
    downstream pf_points/PF_CAP clamp (±12) and select_shadow consume it unchanged.
    personal_fit_raw is back-derived (fused_delta/weight) so audits stay consistent.
    Requires the whole pool to compute the mean, hence a list-level apply."""
    # First materialize each item's embed delta exactly as embed mode would compute it.
    embedded = [apply_embed_affinity(item, embed_items[i], weight, baseline) for i, item in enumerate(items)]
    embed_deltas = [float(e.get("personal_fit_delta") or 0.0) for e in embedded]
    mean_embed = (sum(embed_deltas) / len(embed_deltas)) if embed_deltas else 0.0

    out_items = []
    for item, emb in zip(items, embedded):
        kw_delta = float(item.get("personal_fit_delta") or 0.0)
        emb_delta = float(emb.get("personal_fit_delta") or 0.0)
        centered_embed = emb_delta - mean_embed
        fused_delta = (kw_delta + centered_embed) / 2.0
        fused_raw = (fused_delta / weight) if weight else 0.0
        out = dict(item)
        out.update({
            "keyword_personal_fit_affinity": item.get("personal_fit_affinity"),
            "keyword_personal_fit_raw": item.get("personal_fit_raw"),
            "keyword_personal_fit_delta": item.get("personal_fit_delta"),
            "embed_personal_fit_delta": emb.get("personal_fit_delta"),
            "embedding_affinity": emb.get("embedding_affinity"),
            "fused_embed_mean_delta": round(mean_embed, 4),
            "personal_fit_raw": round(fused_raw, 4),
            "personal_fit_delta": round(fused_delta, 2),
            "affinity_source": "fused",
            "vec_metric": vec_metric,
        })
        signals = dict(out.get("signals") or {})
        signals["embedding_affinity"] = emb.get("embedding_affinity")
        signals["fused_keyword_delta"] = item.get("personal_fit_delta")
        signals["fused_centered_embed_delta"] = round(centered_embed, 2)
        out["signals"] = signals
        out_items.append(out)
    return out_items


def shadow_affinity_audit(item: dict[str, Any], embed_item: dict[str, Any], weight: float, baseline: float) -> dict[str, Any]:
    embedded = apply_embed_affinity(item, embed_item, weight, baseline)
    return {
        "index": item.get("index"),
        "id": item.get("id"),
        "keyword_personal_fit_affinity": item.get("personal_fit_affinity"),
        "keyword_personal_fit_raw": item.get("personal_fit_raw"),
        "keyword_personal_fit_delta": item.get("personal_fit_delta"),
        "shadow_personal_fit_affinity": embedded["personal_fit_affinity"],
        "shadow_personal_fit_raw": embedded["personal_fit_raw"],
        "shadow_personal_fit_delta": embedded["personal_fit_delta"],
        "embedding_affinity": embedded["embedding_affinity"],
        "keyword_secondary_affinity": embedded["keyword_secondary_affinity"],
        "vec_metric": embedded.get("vec_metric"),
    }


def score_candidates(candidates: list[dict[str, Any]], profile: dict[str, Any], weight: float,
                     baseline: float, affinity_mode: str) -> tuple[list[dict[str, Any]], str, str | None, str | None, dict[str, Any] | None]:
    items = [score_candidate(c, i, profile, weight, baseline) for i, c in enumerate(candidates)]
    if weight == 0:
        return items, "sentinel", None, None, None
    if affinity_mode == "keyword":
        return items, "keyword_fallback", None, None, None

    try:
        embed = run_embed_affinity(candidates)
        embed_items = {int(item["index"]): item for item in embed.get("items", []) if isinstance(item, dict) and "index" in item}
        vec_metric = str(embed.get("vec_metric") or "") or None
        for embed_item in embed_items.values():
            if vec_metric:
                embed_item["vec_metric"] = vec_metric
        if len(embed_items) != len(items):
            raise RuntimeError("embedding affinity helper returned incomplete item set")
    except Exception as e:
        return items, "keyword_fallback", str(e), None, None

    if affinity_mode == "embed":
        return [apply_embed_affinity(item, embed_items[i], weight, baseline) for i, item in enumerate(items)], "embed", None, vec_metric, None
    if affinity_mode == "fused":
        return apply_fused_affinity(items, embed_items, weight, baseline, vec_metric), "fused", None, vec_metric, None
    audit_items = [shadow_affinity_audit(item, embed_items[i], weight, baseline) for i, item in enumerate(items)]
    audit = {"vec_metric": vec_metric, "items": audit_items}
    return [apply_shadow_affinity(item, embed_items[i], weight, baseline) for i, item in enumerate(items)], "keyword_fallback", None, None, audit


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="candidate JSON path; omit or '-' for stdin")
    ap.add_argument("--profile", default=str(DEFAULT_PROFILE))
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--timeout-self-test", action="store_true", help="emit fail-safe sentinel for tests")
    ap.add_argument("--include-affinity-audit", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    try:
        if args.timeout_self_test:
            fail("forced timeout/failure self-test")
            return 0
        profile_path = Path(args.profile)
        config_path = Path(args.config)
        profile = load_json(profile_path)
        weight = load_weight(config_path)
        baseline = load_baseline(config_path)
        affinity_mode = load_affinity_mode(config_path)
        data = load_input(args.input)
        candidates = candidates_from(data)
        items, affinity_source, embed_error, vec_metric, affinity_audit = score_candidates(candidates, profile, weight, baseline, affinity_mode)
        output: dict[str, Any] = {
            "ok": True,
            "base_score_only": weight == 0,
            "profile_path": str(profile_path),
            "pf_weight": weight,
            "pf_baseline": baseline,
            "affinity_mode": affinity_mode,
            "affinity_source": affinity_source,
            "items": items,
        }
        if embed_error:
            output["embed_error"] = embed_error
        if vec_metric:
            output["vec_metric"] = vec_metric
        if args.include_affinity_audit and affinity_audit:
            output["affinity_audit"] = affinity_audit
        print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as e:
        fail(str(e))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
