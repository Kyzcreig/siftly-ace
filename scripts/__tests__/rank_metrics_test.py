#!/usr/bin/env python3
"""Regression tests for the Wave-6 rank metrics harness."""
import json
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
EVAL = SCRIPTS / "eval"
sys.path.insert(0, str(EVAL))

import rank_metrics as R  # noqa: E402


def synthetic_rows():
    return [
        {"id": "save-a", "label": "heldout_save", "brief_rank": 1,
         "scores": {"keyword": 0.95, "mean_cosine": 0.20, "probe": 0.85}},
        {"id": "skip-d", "label": "organic_skip", "brief_rank": 2,
         "scores": {"keyword": 0.90, "mean_cosine": 0.10, "probe": 0.20}},
        {"id": "save-b", "label": "heldout_save", "brief_rank": 3,
         "scores": {"keyword": 0.60, "mean_cosine": 0.90, "probe": 0.80}},
        {"id": "skip-e", "label": "organic_skip", "brief_rank": 4,
         "scores": {"keyword": 0.30, "mean_cosine": 0.30, "probe": 0.10}},
        {"id": "save-c", "label": "heldout_save", "brief_rank": 5,
         "scores": {"keyword": 0.40, "mean_cosine": 0.70, "probe": 0.75}},
        {"id": "skip-f", "label": "organic_skip", "brief_rank": 6,
         "scores": {"keyword": 0.20, "mean_cosine": 0.40, "probe": 0.05}},
        {"id": "save-g", "label": "heldout_save", "brief_rank": 7,
         "scores": {"keyword": 0.10, "mean_cosine": 0.85, "probe": 0.70}},
        {"id": "save-h", "label": "heldout_save", "brief_rank": 8,
         "scores": {"keyword": 0.05, "mean_cosine": 0.82, "probe": 0.65}},
    ]


def test_precision_ndcg_auc_and_ab_scaffold_on_synthetic_set():
    result = R.evaluate_labeled_rows(
        synthetic_rows(),
        k_values=(2, 3),
        score_fields=("keyword", "mean_cosine", "probe"),
    )

    assert result["counts"] == {"positives": 5, "organic_skips": 3, "scored": 8, "unlabeled": 0}

    assert result["brief"]["precision@2"] == pytest.approx(0.5)
    expected_ndcg3 = (1.0 + 1.0 / math.log2(4)) / (
        1.0 + 1.0 / math.log2(3) + 1.0 / math.log2(4)
    )
    assert result["brief"]["ndcg@3"] == pytest.approx(expected_ndcg3)

    assert result["ab"]["keyword"]["auc"] == pytest.approx(7 / 15)
    assert result["ab"]["keyword"]["precision@2"] == pytest.approx(0.5)
    assert result["ab"]["mean_cosine"]["precision@2"] == pytest.approx(1.0)
    assert result["ab"]["probe"]["auc"] == pytest.approx(1.0)
    assert result["ab"]["probe"]["ndcg@3"] == pytest.approx(1.0)

    roc = result["ab"]["probe"]["roc"]
    assert roc[0] == {"threshold": "inf", "tpr": 0.0, "fpr": 0.0}
    assert roc[-1] == {"threshold": "-inf", "tpr": 1.0, "fpr": 1.0}


def test_ab_score_fields_filter_to_rows_with_that_field_instead_of_aborting():
    rows = synthetic_rows()
    partial_scores = {
        "save-a": 0.90,
        "save-b": 0.80,
        "skip-d": 0.20,
        "skip-e": 0.10,
    }
    for row in rows:
        if row["id"] in partial_scores:
            row["scores"]["probe_partial"] = partial_scores[row["id"]]

    result = R.evaluate_labeled_rows(rows, k_values=(2,), score_fields=("probe_partial",))

    partial = result["ab"]["probe_partial"]
    assert partial["status"] == "ok"
    assert partial["counts"] == {
        "positives": 2,
        "organic_skips": 2,
        "scored": 4,
        "missing": 4,
        "pairs": 4,
    }
    assert partial["auc"] == pytest.approx(1.0)
    assert partial["ndcg@2"] is None
    assert partial["ndcg_status"]["min_positives"] == 5


def test_ab_score_field_with_no_positive_negative_pairs_is_skipped_not_global_failure():
    rows = synthetic_rows()
    for row in rows:
        if R.is_positive(row):
            row["scores"]["positive_only"] = 0.5

    result = R.evaluate_labeled_rows(rows, k_values=(2,), score_fields=("positive_only", "absent"))

    assert result["ab"]["positive_only"]["status"] == "skipped"
    assert result["ab"]["positive_only"]["counts"]["pairs"] == 0
    assert result["ab"]["absent"]["status"] == "skipped"


def test_tiny_positive_cohort_does_not_report_perfect_ndcg():
    rows = [
        {"id": "save-a", "label": "heldout_save", "brief_rank": 1, "scores": {"keyword": 0.9}},
        {"id": "skip-a", "label": "organic_skip", "brief_rank": 2, "scores": {"keyword": 0.1}},
    ]

    result = R.evaluate_labeled_rows(rows, k_values=(1,), score_fields=("keyword",))

    assert result["brief"]["precision@1"] == pytest.approx(1.0)
    assert result["brief"]["ndcg@1"] is None
    assert result["brief"]["ndcg_status"] == {
        "status": "skipped",
        "reason": "requires at least 5 positives before reporting nDCG",
        "positives": 1,
        "min_positives": 5,
    }


def test_auc_rejects_random_negatives_instead_of_organic_skips():
    rows = synthetic_rows() + [
        {"id": "bad-negative", "label": "random_negative", "brief_rank": 7,
         "scores": {"keyword": 0.01, "mean_cosine": 0.01, "probe": 0.01}},
    ]

    with pytest.raises(ValueError, match="organic_skip"):
        R.evaluate_labeled_rows(rows, score_fields=("keyword",))


def test_rank_labeled_set_scaffold_has_at_least_150_slots():
    scaffold = ROOT / "docs" / "eval" / "rank-labeled-set.json"
    data = json.loads(scaffold.read_text())

    assert data["_meta"]["negative_label"] == "organic_skip"
    assert data["_meta"]["minimum_slots"] == 150
    assert len(data["items"]) >= 150
    assert all(row.get("label") != "random_negative" for row in data["items"])
    assert all(row.get("status") in {"unlabeled", "labeled"} for row in data["items"])
