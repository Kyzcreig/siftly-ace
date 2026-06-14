#!/usr/bin/env python3
"""Rank metrics for Wave-6 personal-fit evaluation.

The honest negative class is organic skips: items Ace saw in a brief/timeline pull
and did not save after the provenance grace period. Random negatives are rejected
because they make embedding affinity look better by construction.
"""
import argparse
import json
import math
import os
import sys
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

POSITIVE_LABELS = {"heldout_save", "organic_save", "known_good", "saved", "positive"}
ORGANIC_SKIP_LABEL = "organic_skip"
UNLABELED_LABELS = {"", "unlabeled", "pending", "todo", "slot"}
RANDOM_NEGATIVE_LABELS = {"random", "random_negative", "random_skip", "synthetic_random_negative"}
DEFAULT_SCORE_FIELDS = ("keyword", "mean_cosine", "probe")
DEFAULT_K_VALUES = (5, 10)
MIN_NDCG_POSITIVES = 5
MIN_AUC_PAIRS = 1

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_LABELED_SET = os.path.join(ROOT, "docs", "eval", "rank-labeled-set.json")

Row = Mapping[str, Any]
MetricDict = Dict[str, Any]


def _label(row: Row) -> str:
    value = row.get("label")
    if value is None:
        value = row.get("relevance_label")
    return str(value or "").strip().lower()


def is_unlabeled(row: Row) -> bool:
    label = _label(row)
    status = str(row.get("status") or "").strip().lower()
    return label in UNLABELED_LABELS or status == "unlabeled"


def is_positive(row: Row) -> bool:
    return _label(row) in POSITIVE_LABELS


def is_organic_skip(row: Row) -> bool:
    return _label(row) == ORGANIC_SKIP_LABEL or str(row.get("negative_source") or "").strip().lower() == ORGANIC_SKIP_LABEL


def _is_random_negative(row: Row) -> bool:
    label = _label(row)
    source = str(row.get("negative_source") or row.get("negative_kind") or "").strip().lower()
    return label in RANDOM_NEGATIVE_LABELS or source in RANDOM_NEGATIVE_LABELS


def _metric_relevance(row: Row) -> Optional[int]:
    if is_positive(row):
        return 1
    if is_organic_skip(row):
        return 0
    return None


def _score(row: Row, field: str) -> Optional[float]:
    value = row.get(field)
    if value is None and isinstance(row.get("scores"), Mapping):
        value = row["scores"].get(field)  # type: ignore[index]
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return out


def _rows_with_score(rows: Sequence[Row], field: str) -> List[Row]:
    return [row for row in rows if _metric_relevance(row) is not None and _score(row, field) is not None]


def _required_score(row: Row, field: str) -> float:
    value = _score(row, field)
    if value is None:
        raise ValueError("missing score for field %s" % field)
    return value


def _score_field_counts(all_rows: Sequence[Row], scored_rows: Sequence[Row]) -> Dict[str, int]:
    positives = sum(1 for row in scored_rows if is_positive(row))
    skips = sum(1 for row in scored_rows if is_organic_skip(row))
    return {
        "positives": positives,
        "organic_skips": skips,
        "scored": len(scored_rows),
        "missing": len(all_rows) - len(scored_rows),
        "pairs": positives * skips,
    }


def _insufficient_pairs_reason() -> str:
    return "requires at least %d positive/organic_skip score pair" % MIN_AUC_PAIRS


def _brief_rank(row: Row, fallback: int) -> float:
    for key in ("brief_rank", "rank", "position"):
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return float(fallback)


def _normalize_rows(rows: Iterable[Row]) -> Tuple[List[Row], int]:
    materialized = list(rows)
    unlabeled = sum(1 for row in materialized if is_unlabeled(row))
    for row in materialized:
        if _is_random_negative(row):
            raise ValueError(
                "rank metrics require organic_skip negatives; random negatives are forbidden"
            )
    metric_rows = [row for row in materialized if not is_unlabeled(row) and _metric_relevance(row) is not None]
    positives = [row for row in metric_rows if is_positive(row)]
    skips = [row for row in metric_rows if is_organic_skip(row)]
    if not positives:
        raise ValueError("rank metrics require at least one held-out positive/save")
    if not skips:
        raise ValueError("rank metrics require at least one organic_skip negative")
    return metric_rows, unlabeled


def precision_at(ranked_rows: Sequence[Row], k: int) -> float:
    if k <= 0:
        raise ValueError("k must be positive")
    window = ranked_rows[:k]
    if not window:
        return 0.0
    return sum(1 for row in window if is_positive(row)) / float(len(window))


def dcg_at(ranked_rows: Sequence[Row], k: int) -> float:
    score = 0.0
    for idx, row in enumerate(ranked_rows[:k]):
        relevance = 1.0 if is_positive(row) else 0.0
        score += relevance / math.log2(idx + 2)
    return score


def ndcg_at(ranked_rows: Sequence[Row], k: int) -> float:
    if k <= 0:
        raise ValueError("k must be positive")
    positives = sum(1 for row in ranked_rows if is_positive(row))
    if positives == 0:
        return 0.0
    ideal_hits = min(k, positives)
    ideal = sum(1.0 / math.log2(idx + 2) for idx in range(ideal_hits))
    if ideal == 0:
        return 0.0
    return dcg_at(ranked_rows, k) / ideal


def auc_score(rows: Sequence[Row], score_field: str) -> float:
    scored_rows = _rows_with_score(rows, score_field)
    pos_scores = [_required_score(row, score_field) for row in scored_rows if is_positive(row)]
    neg_scores = [_required_score(row, score_field) for row in scored_rows if is_organic_skip(row)]
    if len(pos_scores) * len(neg_scores) < MIN_AUC_PAIRS:
        raise ValueError(_insufficient_pairs_reason())

    wins = 0.0
    total = 0
    for pos in pos_scores:
        for neg in neg_scores:
            total += 1
            if pos > neg:
                wins += 1.0
            elif pos == neg:
                wins += 0.5
    return wins / float(total)


def roc_curve(rows: Sequence[Row], score_field: str) -> List[Dict[str, Any]]:
    points: List[Dict[str, Any]] = [{"threshold": "inf", "tpr": 0.0, "fpr": 0.0}]
    scored_rows = _rows_with_score(rows, score_field)
    positives = [row for row in scored_rows if is_positive(row)]
    negatives = [row for row in scored_rows if is_organic_skip(row)]
    if len(positives) * len(negatives) < MIN_AUC_PAIRS:
        raise ValueError(_insufficient_pairs_reason())
    scored = [(row, _required_score(row, score_field)) for row in positives + negatives]

    thresholds = sorted({score for _, score in scored}, reverse=True)
    for threshold in thresholds:
        tp = sum(1 for row, score in scored if score >= threshold and is_positive(row))
        fp = sum(1 for row, score in scored if score >= threshold and is_organic_skip(row))
        points.append({
            "threshold": threshold,
            "tpr": tp / float(len(positives)),
            "fpr": fp / float(len(negatives)),
        })
    points.append({"threshold": "-inf", "tpr": 1.0, "fpr": 1.0})
    return points


def _rank_by_score(rows: Sequence[Row], score_field: str) -> List[Row]:
    def key(row: Row) -> Tuple[float, str]:
        value = _score(row, score_field)
        if value is None:
            raise ValueError("missing score for field %s" % score_field)
        return (-value, str(row.get("id") or ""))

    return sorted(rows, key=key)


def _rank_by_brief(rows: Sequence[Row]) -> List[Row]:
    pairs = sorted(enumerate(rows), key=lambda pair: (_brief_rank(pair[1], pair[0] + 1), pair[0]))
    return [row for _, row in pairs]


def _rank_metrics(ranked_rows: Sequence[Row], k_values: Sequence[int]) -> MetricDict:
    out: MetricDict = {}
    positives = sum(1 for row in ranked_rows if is_positive(row))
    report_ndcg = positives >= MIN_NDCG_POSITIVES
    for k in k_values:
        out["precision@%d" % k] = precision_at(ranked_rows, k)
        out["ndcg@%d" % k] = ndcg_at(ranked_rows, k) if report_ndcg else None
    if not report_ndcg:
        out["ndcg_status"] = {
            "status": "skipped",
            "reason": "requires at least %d positives before reporting nDCG" % MIN_NDCG_POSITIVES,
            "positives": positives,
            "min_positives": MIN_NDCG_POSITIVES,
        }
    return out


def evaluate_labeled_rows(
    rows: Iterable[Row],
    k_values: Sequence[int] = DEFAULT_K_VALUES,
    score_fields: Sequence[str] = DEFAULT_SCORE_FIELDS,
) -> MetricDict:
    """Compute brief-rank metrics and A/B score metrics on one labeled set.

    Only held-out positives and organic_skip negatives enter the metrics. Unlabeled
    scaffold rows are counted but ignored. Random negatives fail loudly.
    """
    metric_rows, unlabeled = _normalize_rows(rows)
    positives = sum(1 for row in metric_rows if is_positive(row))
    skips = sum(1 for row in metric_rows if is_organic_skip(row))
    brief_ranked = _rank_by_brief(metric_rows)

    result: MetricDict = {
        "counts": {
            "positives": positives,
            "organic_skips": skips,
            "scored": len(metric_rows),
            "unlabeled": unlabeled,
        },
        "brief": _rank_metrics(brief_ranked, k_values),
        "ab": {},
    }

    for field in score_fields:
        field_rows = _rows_with_score(metric_rows, field)
        counts = _score_field_counts(metric_rows, field_rows)
        if counts["pairs"] < MIN_AUC_PAIRS:
            result["ab"][field] = {
                "status": "skipped",
                "reason": _insufficient_pairs_reason(),
                "counts": counts,
            }
            continue
        ranked = _rank_by_score(field_rows, field)
        metrics = _rank_metrics(ranked, k_values)
        metrics["status"] = "ok"
        metrics["counts"] = counts
        metrics["auc"] = auc_score(field_rows, field)
        metrics["roc"] = roc_curve(field_rows, field)
        result["ab"][field] = metrics
    return result


def load_labeled_set(path: str = DEFAULT_LABELED_SET) -> List[Row]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data["items"]
    raise ValueError("labeled set must be a JSON list or an object with items[]")


def _parse_csv_ints(raw: str) -> Tuple[int, ...]:
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(int(part))
    if not out:
        raise argparse.ArgumentTypeError("expected at least one k")
    return tuple(out)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compute Wave-6 rank metrics against organic skips.")
    parser.add_argument("--input", default=DEFAULT_LABELED_SET, help="labeled-set JSON path")
    parser.add_argument("--score-field", action="append", dest="score_fields",
                        help="score column to evaluate; repeat for A/B fields")
    parser.add_argument("--k", type=_parse_csv_ints, default=DEFAULT_K_VALUES,
                        help="comma-separated k values (default: 5,10)")
    args = parser.parse_args(argv)

    fields = tuple(args.score_fields or DEFAULT_SCORE_FIELDS)
    result = evaluate_labeled_rows(load_labeled_set(args.input), k_values=args.k, score_fields=fields)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
