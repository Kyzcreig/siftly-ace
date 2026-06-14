#!/usr/bin/env python3
"""A/B personal-fit affinity scoring for Wave 6.

This harness does not reimplement the affinity math. It shells through the real
T-A1 `scripts/pf-score.py` twice on the same labeled rows:

  - PF_AFFINITY_MODE=keyword -> legacy keyword-overlap affinity
  - PF_AFFINITY_MODE=embed   -> A1 embedding/vec affinity when provisioned

The default input is the digest gold set so T-A2's adversarial near-positive case
is easy to verify. When a mature organic-skip set exists, pass it with --input;
organic-skip metrics are the promotion evidence. Gold known_bad rows are reported
as a regression proxy only, never as promotion evidence.
"""
from __future__ import annotations

import argparse
import importlib
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
EVAL_DIR = SCRIPTS / "eval"
DEFAULT_INPUT = ROOT / "docs" / "eval" / "digest-gold-set.json"
DEFAULT_PF_SCORE = SCRIPTS / "pf-score.py"
DEFAULT_TIMEOUT = 60.0
DEFAULT_NEAR_MARGIN = 0.05
DEFAULT_NEAR_MIN = 0.35
SCORE_FIELDS = ("keyword", "mean_cosine")

sys.path.insert(0, str(EVAL_DIR))
import rank_metrics as R  # noqa: E402

Row = Mapping[str, Any]


def load_items(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data["items"]
    else:
        raise ValueError("input must be a JSON list or object with items[]")
    out = [item for item in items if isinstance(item, dict)]
    if not out:
        raise ValueError("input contains no item objects")
    return out


def text_of(row: Row) -> str:
    parts: list[str] = []
    for key in ("title", "text", "summary", "body", "content", "description"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return "\n".join(parts)


def row_id(row: Row, fallback: int) -> str:
    for key in ("id", "tweetId", "tweet_id", "url"):
        value = row.get(key)
        if isinstance(value, (str, int)) and str(value):
            return str(value)
    return str(fallback)


def candidate_from_row(row: Row, idx: int) -> dict[str, Any] | None:
    text = text_of(row)
    if not text:
        return None
    candidate = {
        "id": row_id(row, idx),
        "source": row.get("source"),
        "url": row.get("url"),
        "title": row.get("title") or row.get("text") or text,
        "text": row.get("text") or text,
        "summary": row.get("summary") or row.get("why") or row.get("label_rationale"),
        "authorHandle": row.get("authorHandle") or row.get("author_handle") or row.get("handle"),
    }
    return {k: v for k, v in candidate.items() if v is not None}


def scorable_rows(rows: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    kept: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, row in enumerate(rows):
        candidate = candidate_from_row(row, idx)
        if candidate is None:
            continue
        cid = str(candidate["id"])
        if cid in seen:
            raise ValueError(f"duplicate candidate id: {cid}")
        seen.add(cid)
        kept.append(row)
        candidates.append(candidate)
    if not candidates:
        raise ValueError("input has no rows with text/title/summary to score")
    return kept, candidates


def numeric(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return out


def generate_profile(rows: Sequence[Row]) -> Path:
    handles = []
    for row in rows:
        if str(row.get("label") or "").strip().lower() in {"known_good", "heldout_save", "organic_save", "saved", "positive"}:
            handle = row.get("authorHandle") or row.get("author_handle") or row.get("handle")
            if isinstance(handle, str) and handle.strip():
                handles.append({"handle": handle.strip().lstrip("@"), "weight": 10})
    profile = {
        "corpus_size": {"bookmarks": 0, "likes": 0},
        "top_topics": [
            {"name": "dev-tools", "weight": 10, "segment": "eval-fallback"},
            {"name": "ai-ml", "weight": 8, "segment": "eval-fallback"},
            {"name": "startups-business", "weight": 4, "segment": "eval-fallback"},
        ],
        "high_signal_authors": handles[:25],
        "favorite_formats": ["format:single", "is_thread", "has_video"],
        "downrank_patterns": ["contrast:boring"],
    }
    tmp = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix="-pf-profile.json", delete=False)
    with tmp:
        json.dump(profile, tmp)
    return Path(tmp.name)


def resolve_profile(explicit: str | None, rows: Sequence[Row]) -> tuple[Path, str, Path | None]:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise ValueError(f"profile not found: {path}")
        return path, "explicit", None
    default = Path.home() / ".hermes" / "state" / "x-bookmarks" / "preference-profile.json"
    if default.exists():
        return default, "default", None
    generated = generate_profile(rows)
    return generated, "generated-minimal-eval-profile", generated


def run_pf_score(
    mode: str,
    candidates: Sequence[Mapping[str, Any]],
    *,
    pf_score: Path,
    profile: Path,
    config: Path | None,
    timeout: float,
) -> dict[str, Any]:
    cmd = [sys.executable, str(pf_score), "-", "--profile", str(profile)]
    if config is not None:
        cmd += ["--config", str(config)]
    env = os.environ.copy()
    env["PF_AFFINITY_MODE"] = mode
    proc = subprocess.run(
        cmd,
        input=json.dumps({"candidates": list(candidates)}),
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "pf-score failed").strip()
        raise RuntimeError(f"pf-score {mode} failed: {detail}")
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"pf-score {mode} returned invalid JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise RuntimeError(f"pf-score {mode} returned non-object JSON")
    if not parsed.get("ok"):
        raise RuntimeError(f"pf-score {mode} declined: {parsed.get('reason')}")
    return parsed


def item_map(result: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item in result.get("items", []) if isinstance(result.get("items"), list) else []:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if item_id is not None:
            out[str(item_id)] = item
    return out


def score_rows(
    rows: Sequence[dict[str, Any]],
    candidates: Sequence[Mapping[str, Any]],
    keyword: Mapping[str, Any],
    embed: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    keyword_by_id = item_map(keyword)
    embed_by_id = item_map(embed)
    details: dict[str, dict[str, Any]] = {}
    metric_rows: list[dict[str, Any]] = []
    for idx, row in enumerate(rows):
        cid = str(candidates[idx]["id"])
        key_item = keyword_by_id.get(cid)
        embed_item = embed_by_id.get(cid)
        if key_item is None or embed_item is None:
            raise RuntimeError(f"pf-score output missing item {cid}")
        key_affinity = numeric(key_item.get("personal_fit_affinity"))
        embed_affinity = numeric(embed_item.get("embedding_affinity"))
        if embed_affinity is None:
            embed_affinity = numeric(embed_item.get("personal_fit_affinity"))
        scores = {"keyword": key_affinity, "mean_cosine": embed_affinity}
        metric_row = dict(row)
        metric_row["scores"] = {k: v for k, v in scores.items() if v is not None}
        metric_rows.append(metric_row)
        details[cid] = {
            "label": row.get("label"),
            "keyword_affinity": key_affinity,
            "keyword_delta": numeric(key_item.get("personal_fit_delta")),
            "mean_cosine_affinity": embed_affinity,
            "embed_combined_affinity": numeric(embed_item.get("personal_fit_affinity")),
            "embed_delta": numeric(embed_item.get("personal_fit_delta")),
            "embed_item_source": embed_item.get("affinity_source"),
        }
    return metric_rows, details


def try_rank_metrics(rows: Sequence[Row], k_values: Sequence[int]) -> dict[str, Any]:
    try:
        metrics = R.evaluate_labeled_rows(rows, k_values=k_values, score_fields=SCORE_FIELDS)
    except ValueError as e:
        return {"status": "skipped", "reason": str(e)}
    return {"status": "ok", "metrics": metrics}


def metrics_report(rows: Sequence[dict[str, Any]], k_values: Sequence[int]) -> dict[str, Any]:
    organic = try_rank_metrics(rows, k_values)

    gold_rows: list[dict[str, Any]] = []
    for row in rows:
        label = str(row.get("label") or "").strip().lower()
        if label == "known_good":
            gold_rows.append(dict(row, label="known_good"))
        elif label == "known_bad":
            proxy = dict(row)
            proxy["label"] = "organic_skip"
            proxy["negative_source"] = "gold_known_bad_proxy"
            gold_rows.append(proxy)
    gold_proxy: dict[str, Any] = (
        try_rank_metrics(gold_rows, k_values)
        if gold_rows
        else {"status": "skipped", "reason": "no known_good/known_bad gold rows"}
    )
    if gold_proxy.get("status") == "ok":
        gold_proxy["promotion_evidence"] = False
        gold_proxy["basis"] = "known_good vs known_bad gold proxy; organic-skip set is still required for promotion"
    return {"organic_skip": organic, "gold_proxy": gold_proxy}


def score_digest_item(row: Row, personal_fit_delta: float) -> tuple[float, dict[str, Any], dict[str, Any]]:
    os.environ["RECENCY_AS_TIEBREAK"] = "1"
    sys.path.insert(0, str(SCRIPTS))
    import score_digest as S  # noqa: E402
    importlib.reload(S)

    raw = dict(row)
    raw["authorHandle"] = row.get("authorHandle") or row.get("author_handle") or row.get("handle")
    raw["tweet_text"] = row.get("tweet_text") or row.get("text") or row.get("title") or text_of(row)
    source = str(row.get("source") or "").strip().lower()
    raw["source"] = "hackernews" if source in {"hackernews", "hn"} else "x"
    raw["personal_fit_delta"] = personal_fit_delta
    tl_handles, tl_aliases = S._load_thought_leaders()
    tracked = set(S._load_tracked_projects())
    scored = S.score_item(raw, tl_handles, tl_aliases, tracked, low_reach_cap_val=S.ALSO_GATE - 5)
    return float(scored["_final"]), scored["_breakdown"], {"top": S.TOP_GATE, "also": S.ALSO_GATE}


def adversarial_report(
    rows: Sequence[dict[str, Any]],
    details: Mapping[str, Mapping[str, Any]],
    *,
    gate_name: str,
    near_margin: float,
    near_min: float,
    require_embed: bool,
) -> tuple[dict[str, Any], list[str]]:
    cases = [row for row in rows if row.get("adversarial_case")]
    failures: list[str] = []
    out_cases: list[dict[str, Any]] = []
    for row in cases:
        cid = str(row.get("id"))
        detail = details.get(cid, {})
        row_delta = numeric(row.get("personal_fit_delta")) or 0.0
        embed_delta = numeric(detail.get("embed_delta")) or 0.0
        rescue_delta = max(row_delta, embed_delta)
        final, breakdown, gates = score_digest_item(row, rescue_delta)
        gate_value = float(gates[gate_name])
        below_gate = final < gate_value
        if not below_gate:
            failures.append(f"{cid} final {final} >= {gate_name.upper()}_GATE {gate_value}")

        near_positive_id = row.get("near_positive_id")
        near: dict[str, Any] = {"status": "not_configured"}
        bad_affinity = numeric(detail.get("mean_cosine_affinity"))
        if near_positive_id:
            positive_detail = details.get(str(near_positive_id), {})
            positive_affinity = numeric(positive_detail.get("mean_cosine_affinity"))
            real_embed = detail.get("embed_item_source") == "embed" and positive_detail.get("embed_item_source") == "embed"
            if not real_embed:
                near = {"status": "skipped", "reason": "embed affinity was not available for both rows"}
            elif bad_affinity is None or positive_affinity is None:
                near = {"status": "skipped", "reason": "missing embedding affinity"}
            else:
                margin = positive_affinity - bad_affinity
                passes = bad_affinity >= near_min and margin <= near_margin
                near = {
                    "status": "pass" if passes else "fail",
                    "near_positive_id": near_positive_id,
                    "bad_mean_cosine": bad_affinity,
                    "positive_mean_cosine": positive_affinity,
                    "positive_minus_bad": margin,
                    "near_margin": near_margin,
                    "near_min": near_min,
                }
                if require_embed and not passes:
                    failures.append(f"{cid} did not embed near {near_positive_id}: {near}")
        elif require_embed:
            failures.append(f"{cid} has no near_positive_id")

        if require_embed and detail.get("embed_item_source") != "embed":
            failures.append(f"{cid} embed affinity source was {detail.get('embed_item_source')!r}, not 'embed'")

        out_cases.append({
            "id": cid,
            "label": row.get("label"),
            "gate_checked": gate_name,
            "gate_value": gate_value,
            "final_with_rescue_delta": final,
            "rescue_delta_used": rescue_delta,
            "below_gate": below_gate,
            "breakdown": breakdown,
            "embedding_nearness": near,
        })
    if not cases:
        failures.append("no adversarial_case rows found")
    return {"cases": out_cases, "count": len(out_cases)}, failures


def parse_k(raw: str) -> tuple[int, ...]:
    values = tuple(int(part.strip()) for part in raw.split(",") if part.strip())
    if not values:
        raise argparse.ArgumentTypeError("expected at least one k")
    if any(k <= 0 for k in values):
        raise argparse.ArgumentTypeError("k must be positive")
    return values


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="A/B score keyword vs embedding personal-fit affinity.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="labeled-set JSON path")
    parser.add_argument("--pf-score", default=str(DEFAULT_PF_SCORE), help="path to scripts/pf-score.py")
    parser.add_argument("--profile", help="preference-profile.json path; generated minimal eval profile if omitted and default is missing")
    parser.add_argument("--config", help="brief-config.json path")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--k", type=parse_k, default=(5, 10), help="comma-separated k values for rank metrics")
    parser.add_argument("--adversarial-gate", choices=("top", "also"), default="also")
    parser.add_argument("--near-margin", type=float, default=DEFAULT_NEAR_MARGIN)
    parser.add_argument("--near-min", type=float, default=DEFAULT_NEAR_MIN)
    parser.add_argument("--require-embed", action="store_true", help="fail if the embed run falls back instead of using A1 embedding affinity")
    parser.add_argument("--require-metrics", action="store_true", help="fail if organic-skip rank metrics cannot be computed")
    args = parser.parse_args(argv)

    cleanup: Path | None = None
    failures: list[str] = []
    try:
        input_path = Path(args.input).expanduser()
        rows = load_items(input_path)
        scored_rows_input, candidates = scorable_rows(rows)
        profile, profile_source, cleanup = resolve_profile(args.profile, scored_rows_input)
        config = Path(args.config).expanduser() if args.config else None
        if config is not None and not config.exists():
            raise ValueError(f"config not found: {config}")

        keyword = run_pf_score("keyword", candidates, pf_score=Path(args.pf_score), profile=profile, config=config, timeout=args.timeout)
        embed = run_pf_score("embed", candidates, pf_score=Path(args.pf_score), profile=profile, config=config, timeout=args.timeout)
        if args.require_embed and embed.get("affinity_source") != "embed":
            failures.append(f"embed run affinity_source={embed.get('affinity_source')!r}; expected 'embed'")

        metric_rows, details = score_rows(scored_rows_input, candidates, keyword, embed)
        metrics = metrics_report(metric_rows, args.k)
        if args.require_metrics and metrics["organic_skip"].get("status") != "ok":
            failures.append(f"organic-skip metrics unavailable: {metrics['organic_skip'].get('reason')}")

        adversarial, adversarial_failures = adversarial_report(
            metric_rows,
            details,
            gate_name=args.adversarial_gate,
            near_margin=args.near_margin,
            near_min=args.near_min,
            require_embed=args.require_embed,
        )
        failures.extend(adversarial_failures)

        report = {
            "ok": not failures,
            "input": str(input_path),
            "profile": {"path": str(profile), "source": profile_source},
            "counts": {"input_items": len(rows), "scored_items": len(metric_rows)},
            "pf_score": {
                "keyword_affinity_source": keyword.get("affinity_source"),
                "embed_affinity_source": embed.get("affinity_source"),
                "embed_error": embed.get("embed_error"),
                "vec_metric": embed.get("vec_metric"),
            },
            "metrics": metrics,
            "adversarial": adversarial,
            "scores": details,
            "failures": failures,
        }
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0 if not failures else 1
    finally:
        if cleanup is not None:
            try:
                cleanup.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
