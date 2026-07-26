#!/usr/bin/env python3
"""Tests for xsearch_gather.py — the grok/x_search -> pipeline candidate adapter.

These are BLOCKER-DRIVEN tests. Each class guards one failure mode from the
adversarial review of the X-API→x_search migration spec, and each has a paired
`*_naive_shape_*` / `*_naive_*` test that RED-PROVES the blocker: it asserts the
BROKEN pre-fix behavior is real, so the guard test is demonstrably not vacuous.

Run: python3 -m pytest scripts/__tests__/xsearch_gather_test.py -q
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import xsearch_gather as xg  # noqa: E402
import select_digest as sd  # noqa: E402


# ── Live-captured fixtures ───────────────────────────────────────────────────
# Verbatim from real x_search calls on 2026-07-25 (trimmed). Two different calls
# on the SAME day returned two DIFFERENT timestamp formats for the same account —
# that is fixture RESP_ISO vs RESP_RFC below, not an invention.

RESP_ISO = {
    "success": True,
    "provider": "xai",
    "credential_source": "xai-oauth",
    "tool": "x_search",
    "model": "grok-4.20-reasoning",
    "answer": json.dumps([
        {
            "handle": "simonw",
            "tweet_id": "2081153980294648186",
            "tweet_text": ("Ruff 0.16.0 - @astral_sh's fast Python linter - came out a few "
                           "days ago and increased the number of default-enabled rules from "
                           "59 to 413, which highlighted all sorts of problems across my "
                           "projects (1618 in sqlite-utils alone)"),
            "url": "https://x.com/simonw/status/2081153980294648186",
            "likes": 140, "retweets": 10, "replies": 15, "views": 15757,
            "created_at": "2026-07-25T23:05:49Z",
        },
        {
            "handle": "simonw",
            "tweet_id": "2080102848050933904",
            "tweet_text": ("I think loops were a short-lived patch for models that couldn't "
                           "reliably keep working on long problems until they hit a defined goal"),
            "url": "https://x.com/simonw/status/2080102848050933904",
            "likes": 1273, "retweets": 59, "replies": 139, "views": 153034,
            "created_at": "2026-07-23T01:29:00Z",
        },
    ]),
    "citations": [],
    "inline_citations": [
        {"url": "https://x.com/i/status/2081153980294648186", "title": "", "start_index": 0, "end_index": 0},
        {"url": "https://x.com/i/status/2080102848050933904", "title": "", "start_index": 0, "end_index": 0},
    ],
    "degraded": False,
    "degraded_reason": None,
}

RESP_RFC = {
    "success": True,
    "credential_source": "xai-oauth",
    "answer": json.dumps([
        {
            "handle": "ollama",
            "tweet_id": "2080746063104008408",
            "tweet_text": ("The demand for GLM-5.2 and other frontier-level open models has "
                           "been surging on Ollama's cloud."),
            "url": "https://x.com/ollama/status/2080746063104008408",
            "likes": 1755, "retweets": 79, "replies": 73, "views": 183997,
            "created_at": "Fri, 24 Jul 2026 20:04:54 GMT",
        },
    ]),
    "citations": [],
    "inline_citations": [{"url": "https://x.com/i/status/2080746063104008408"}],
    "degraded": False,
}

WINDOW = ("2026-07-23T00:00:00Z", "2026-07-26T00:00:00Z")


def _tl():
    return set(), []


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 1 — CANDIDATE SHAPE. The single most important test in the deliverable.
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker1CandidateShape:

    def test_RED_naive_text_key_is_invisible_to_item_text(self):
        """RED-PROOF: the spec-v3 row shape (`text`) is read as '' by select_digest."""
        naive = {"id": "1", "source": "x", "text": "a real substantive tweet body here",
                 "authorHandle": "simonw", "url": "https://x.com/simonw/status/1"}
        assert sd._item_text(naive) == "", "expected the naive `text` key to be INVISIBLE"
        assert sd.is_bare_fragment(sd._item_text(naive)) is True

    def test_RED_naive_shape_is_100pct_discarded_by_select(self):
        """RED-PROOF: a full pool of naive rows loses EVERY candidate, silently."""
        pool = [{"id": str(i), "source": "x", "text": f"substantive body number {i} with detail",
                 "authorHandle": "simonw", "likes": 500, "retweets": 20,
                 "base_score": 90, "url": f"https://x.com/simonw/status/{i}",
                 "signals": {"topic_hits": [{"topic": "ai"}]}} for i in range(10)]
        tlh, tla = _tl()
        selected, also, discarded = sd.select(pool, tlh, tla, [])
        assert selected == [] and also == []
        assert len(discarded) == 10
        assert all(d.get("_drop") == "bare_fragment" for d in discarded)

    def test_RED_naive_public_metrics_only_reads_zero_in_render_and_overview(self):
        """RED-PROOF: public_metrics alone => render/overview engagement is 0."""
        import overview_digest as od
        import render_digest as rd
        pm_only = {"source": "x", "tweet_text": "body",
                   "public_metrics": {"like_count": 4510, "retweet_count": 300}}
        assert sd._engagement(pm_only) == 4810.0          # select_digest DOES fall back
        assert od._engagement(pm_only) == 0.0             # overview does NOT
        assert rd._engagement(pm_only) == 0               # renderer does NOT

    # ── GREEN ────────────────────────────────────────────────────────────────
    def test_adapter_emits_tweet_text_visible_to_item_text(self):
        cands, _ = xg.adapt_chunk(RESP_ISO, ["simonw"], *WINDOW)
        assert cands, "adapter produced no candidates"
        for c in cands:
            assert sd._item_text(c) == c["tweet_text"] != ""
            assert sd.is_bare_fragment(sd._item_text(c)) is False

    def test_adapter_emits_flat_AND_nested_metrics(self):
        import overview_digest as od
        import render_digest as rd
        cands, _ = xg.adapt_chunk(RESP_ISO, ["simonw"], *WINDOW)
        c = cands[0]
        assert c["likes"] == 140 and c["retweets"] == 10
        assert c["public_metrics"]["like_count"] == 140
        assert c["public_metrics"]["retweet_count"] == 10
        # all three consumers agree — this is what the naive shape broke
        assert sd._engagement(c) == 150.0
        assert od._engagement(c) == 150.0
        assert rd._engagement(c) == 150

    def test_SURVIVAL_real_adapter_row_survives_select_with_final_gt_zero(self):
        """⭐ THE FIXTURE. A real adapter row must survive select_digest.select()
        with _final > 0 — this is the assertion the whole migration rides on."""
        cands, _ = xg.adapt_chunk(RESP_ISO, ["simonw"], *WINDOW)
        pool = []
        for c in cands:
            row = dict(c)
            row["base_score"] = 85
            row["personal_fit_delta"] = 0
            row["signals"] = {"topic_hits": [{"topic": "ai"}]}
            pool.append(row)

        tlh, tla = _tl()
        selected, also, discarded = sd.select(pool, tlh, tla, [])
        survivors = selected + also

        assert survivors, (
            f"NO adapter row survived select(): "
            f"{[d.get('_drop') for d in discarded]}")
        assert not any(d.get("_drop") == "bare_fragment" for d in discarded)
        for s in survivors:
            assert s["_final"] > 0, f"survivor scored _final={s['_final']}"
            assert s.get("_low_reach_capped") is not True

    def test_SURVIVAL_row_renders_through_the_render_contract(self):
        """The survivor must also emit a usable render item (tweet branch, metrics kept)."""
        cands, _ = xg.adapt_chunk(RESP_ISO, ["simonw"], *WINDOW)
        row = dict(cands[0]); row["base_score"] = 85; row["personal_fit_delta"] = 0
        row["signals"] = {"topic_hits": [{"topic": "ai"}]}
        tlh, tla = _tl()
        selected, also, _ = sd.select([row], tlh, tla, [])
        item = sd._to_render_item((selected + also)[0])
        assert item["source"] == "X"
        assert item["tweet_text"].startswith("Ruff 0.16.0")
        assert item["likes"] == 140 and item["retweets"] == 10
        assert item["score"] > 0

    def test_null_text_media_only_post_is_kept_not_crashed(self):
        """G3/F4: `text: null` is a real media-only post. Tolerate it, count it."""
        c = xg.to_candidate({"handle": "x", "tweet_id": "9", "tweet_text": None, "likes": 5})
        assert c["tweet_text"] == ""
        assert c["tweet_id"] == "9"

    def test_source_x_is_set_so_low_reach_guard_still_applies(self):
        c = xg.to_candidate({"handle": "nobody", "tweet_id": "9", "tweet_text": "x" * 40,
                             "likes": 0, "retweets": 0})
        assert c["source"] == "x"
        assert sd._is_x(c) is True
        cap, reason = sd.low_reach_cap(c, set(), [])
        assert cap == sd.LOW_REACH_SCORE_CAP


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 2 — SNOWFLAKE ID PRECISION / TYPE DRIFT
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker2IdCoercion:

    def test_RED_float64_hop_corrupts_a_snowflake_id(self):
        """RED-PROOF: the corruption is real — any float hop loses precision."""
        real = 2081153980294648186
        assert real > 2 ** 53
        corrupted = int(float(real))
        assert corrupted != real
        assert abs(corrupted - real) > 0

    def test_RED_naive_int_vs_str_defeats_dedupe(self):
        """RED-PROOF: the tool alternates int/string between calls; a raw set
        holding both treats ONE post as TWO."""
        naive = {2081153980294648186, "2081153980294648186"}
        assert len(naive) == 2, "expected raw int/str drift to double-count"

    def test_coercion_makes_dedupe_type_stable(self):
        coerced = {xg.coerce_id(2081153980294648186), xg.coerce_id("2081153980294648186")}
        assert coerced == {"2081153980294648186"}

    def test_coerce_id_never_returns_a_number(self):
        for v in (2081153980294648186, "2081153980294648186", 123.0):
            assert isinstance(xg.coerce_id(v), str)

    def test_coerce_id_extracts_from_permalink(self):
        assert xg.coerce_id("https://x.com/i/status/2081153980294648186") == "2081153980294648186"
        assert xg.coerce_id("https://twitter.com/simonw/status/999") == "999"

    def test_coerce_id_rejects_none_and_bool(self):
        assert xg.coerce_id(None) == ""
        assert xg.coerce_id(True) == ""   # bool is an int subclass — never a valid id

    def test_id_recovered_from_url_when_field_missing(self):
        c = xg.to_candidate({"handle": "simonw", "tweet_text": "body",
                             "url": "https://x.com/simonw/status/777"})
        assert c["tweet_id"] == "777"

    def test_cross_chunk_dedupe_on_string_id(self):
        cands, rep = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO, RESP_ISO])
        ids = [c["tweet_id"] for c in cands]
        assert len(ids) == len(set(ids))
        assert all(isinstance(i, str) for i in ids)


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 3 — TIMESTAMP FORMAT DRIFT
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker3TimestampNormalization:

    def test_RED_naive_iso_parser_rejects_the_rfc1123_form(self):
        """RED-PROOF: a fromisoformat-only parser throws on the live RFC-1123 value."""
        import datetime
        with pytest.raises(ValueError):
            datetime.datetime.fromisoformat("Fri, 24 Jul 2026 20:04:54 GMT")

    def test_RED_unnormalized_rfc1123_row_falls_out_of_the_window(self):
        """RED-PROOF: without normalization the row is dropped as out-of-window,
        i.e. an entire call's worth of content vanishes on a format flip."""
        raw = {"created_at": "Fri, 24 Jul 2026 20:04:54 GMT"}
        assert xg._parse_dt(raw["created_at"]) is not None      # parseable via RFC path
        naive_only_iso = {"created_at": ""}                     # what an ISO-only parser yields
        assert xg.in_window(naive_only_iso, *WINDOW) is False

    def test_both_formats_normalize_to_the_same_instant(self):
        assert xg.normalize_ts("2026-07-24T20:04:54Z") == "2026-07-24T20:04:54Z"
        assert xg.normalize_ts("Fri, 24 Jul 2026 20:04:54 GMT") == "2026-07-24T20:04:54Z"

    def test_offset_timestamp_converted_to_utc(self):
        assert xg.normalize_ts("2026-07-24T22:04:54+02:00") == "2026-07-24T20:04:54Z"

    def test_naive_timestamp_assumed_utc(self):
        assert xg.normalize_ts("2026-07-24 20:04:54") == "2026-07-24T20:04:54Z"

    def test_unparseable_timestamp_is_empty_not_an_exception(self):
        assert xg.normalize_ts("last tuesday") == ""
        assert xg.normalize_ts(None) == ""

    def test_rfc1123_response_survives_the_window_filter_end_to_end(self):
        cands, stats = xg.adapt_chunk(RESP_RFC, ["ollama"], *WINDOW)
        assert stats["rows_after_window_filter"] == 1
        assert cands[0]["created_at"] == "2026-07-24T20:04:54Z"

    def test_local_window_filter_overrides_groks_date_math(self):
        """F1/F3: grok's since:/until: is a hint. Ours is the hard boundary."""
        cands, stats = xg.adapt_chunk(RESP_ISO, ["simonw"],
                                      "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z")
        assert stats["rows_parsed"] == 2
        assert stats["rows_after_window_filter"] == 1   # the 07-23 row is cut locally
        assert cands[0]["created_at"].startswith("2026-07-25")

    def test_row_with_unparseable_timestamp_is_dropped_not_kept(self):
        resp = dict(RESP_RFC)
        resp["answer"] = json.dumps([{"handle": "ollama", "tweet_id": "1",
                                      "tweet_text": "body text here ok", "likes": 999,
                                      "created_at": "who knows"}])
        resp["inline_citations"] = [{"url": "https://x.com/i/status/1"}]
        cands, stats = xg.adapt_chunk(resp, ["ollama"], *WINDOW)
        assert cands == []
        assert stats["rows_after_window_filter"] == 0


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 4 — EMPTY POOL MUST FAIL LOUDLY (and must NOT touch the day lock)
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker4EmptyPoolLoudFailure:

    EMPTY_OK = {"success": True, "credential_source": "xai-oauth",
                "answer": "[]", "citations": [], "inline_citations": [],
                "degraded": False}

    def test_RED_empty_pool_is_an_http200_success_true_response(self):
        """RED-PROOF: the dangerous case is NOT an error — the brief's existing
        Step-1.5 non-200 guard cannot see it."""
        assert self.EMPTY_OK["success"] is True
        assert self.EMPTY_OK.get("error") is None
        naive_failed = not self.EMPTY_OK.get("success")
        assert naive_failed is False, "a success-only check would call this a GOOD run"

    def test_empty_pool_flagged_and_alerted(self):
        cands, rep = xg.gather(["simonw"], *WINDOW, responses=[self.EMPTY_OK])
        assert cands == []
        assert rep["empty_pool"] is True
        assert rep["alerts"], "empty pool produced NO alert"
        assert any("EMPTY POOL" in a for a in rep["alerts"])

    def test_empty_pool_alert_forbids_touching_the_day_lock(self):
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[self.EMPTY_OK])
        joined = " ".join(rep["alerts"])
        assert "day" in joined.lower() and "lock" in joined.lower()

    def test_all_rows_filtered_out_of_window_is_also_an_empty_pool(self):
        """The subtler case: rows came back, none are in the window."""
        _, rep = xg.gather(["simonw"], "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z",
                           responses=[RESP_ISO])
        assert rep["rows_parsed"] == 2
        assert rep["rows_after_window_filter"] == 0
        assert rep["empty_pool"] is True

    def test_non_empty_pool_raises_no_empty_alert(self):
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO])
        assert rep["empty_pool"] is False
        assert not any("EMPTY POOL" in a for a in rep["alerts"])

    def test_cli_exits_nonzero_on_empty_pool(self, tmp_path):
        p = tmp_path / "empty.json"
        p.write_text(json.dumps(self.EMPTY_OK))
        rc = xg.main(["--handle", "simonw", "--since", WINDOW[0], "--until", WINDOW[1],
                      "--from-response", str(p), "--out", str(tmp_path / "o.json")])
        assert rc != 0, "empty pool exited 0 — the caller would post a thin brief"

    def test_cli_exits_zero_on_a_healthy_pool(self, tmp_path):
        p = tmp_path / "ok.json"
        p.write_text(json.dumps(RESP_ISO))
        rc = xg.main(["--handle", "simonw", "--since", WINDOW[0], "--until", WINDOW[1],
                      "--from-response", str(p), "--out", str(tmp_path / "o.json")])
        assert rc == 0

    def test_transport_failure_counts_as_failed_chunk_not_silent_zero(self):
        bad = {"success": False, "error": "xAI x_search timed out after 180 seconds"}
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[bad])
        assert rep["chunks_failed"] == 1
        assert rep["empty_pool"] is True
        assert any("FAILED" in a for a in rep["alerts"])


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 5 — CITATION / DEGRADED HALLUCINATION GUARD (free)
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker5CitationGuard:

    FABRICATED = {
        "success": True, "credential_source": "xai-oauth",
        "answer": json.dumps([
            {"handle": "simonw", "tweet_id": "2081153980294648186",
             "tweet_text": "a genuine cited post body", "likes": 500,
             "url": "https://x.com/simonw/status/2081153980294648186",
             "created_at": "2026-07-25T12:00:00Z"},
            {"handle": "simonw", "tweet_id": "1111111111111111111",
             "tweet_text": "a plausible but UNCITED fabricated post", "likes": 900,
             "url": "https://x.com/simonw/status/1111111111111111111",
             "created_at": "2026-07-25T13:00:00Z"},
        ]),
        "citations": [],
        "inline_citations": [{"url": "https://x.com/i/status/2081153980294648186"}],
        "degraded": False,
    }

    def test_RED_ungated_parse_accepts_the_fabricated_row(self):
        """RED-PROOF: without the guard the uncited row sails straight through."""
        rows = xg.extract_rows(self.FABRICATED["answer"])
        assert len(rows) == 2
        assert any(r["tweet_id"] == "1111111111111111111" for r in rows)

    def test_uncited_row_is_dropped_and_counted(self):
        cands, stats = xg.adapt_chunk(self.FABRICATED, ["simonw"], *WINDOW)
        ids = {c["tweet_id"] for c in cands}
        assert "2081153980294648186" in ids
        assert "1111111111111111111" not in ids
        assert stats["rows_uncited"] == 1

    def test_citation_guard_can_be_disabled_explicitly(self):
        cands, _ = xg.adapt_chunk(self.FABRICATED, ["simonw"], *WINDOW,
                                  verify_citations=False)
        assert len(cands) == 2

    def test_RED_top_level_citations_alone_would_reject_every_real_chunk(self):
        """SPEC CORRECTION: on live 2026-07-25 calls `citations` was EMPTY while
        `inline_citations` carried every id. Checking only `citations` (as the
        spec's wording implies) rejects 100% of genuine rows."""
        assert RESP_ISO["citations"] == []
        assert len(RESP_ISO["inline_citations"]) == 2
        citations_only = {xg.id_from_url(c.get("url", ""))
                          for c in RESP_ISO["citations"]} - {""}
        assert citations_only == set(), "expected the top-level array to be empty"
        union = xg.citation_ids(RESP_ISO)
        assert len(union) == 2, "the union of BOTH channels must carry the ids"

    def test_degraded_chunk_yields_no_candidates(self):
        resp = dict(RESP_ISO)
        resp["degraded"] = True
        resp["degraded_reason"] = "no citations returned despite filters: allowed_x_handles"
        cands, stats = xg.adapt_chunk(resp, ["simonw"], *WINDOW)
        assert cands == []
        assert stats["degraded"] is True

    def test_degraded_is_benign_at_low_rates_but_alerts_when_total(self):
        """G7: a degraded chunk usually just means 'nobody posted above the floor'.
        Alert only when it is the WHOLE run."""
        deg = dict(RESP_ISO); deg["degraded"] = True
        _, mixed = xg.gather(["a", "b"], *WINDOW, responses=[RESP_ISO, deg])
        assert not any("degraded" in a for a in mixed["alerts"])
        _, total = xg.gather(["a"], *WINDOW, responses=[deg])
        assert any("degraded" in a for a in total["alerts"])

    def test_citation_ids_reads_both_channels(self):
        resp = {"citations": [{"url": "https://x.com/a/status/111"}],
                "inline_citations": [{"url": "https://x.com/i/status/222"}]}
        assert xg.citation_ids(resp) == {"111", "222"}


# ═════════════════════════════════════════════════════════════════════════════
# BLOCKER 6 — CREDENTIAL FALLBACK VISIBILITY (silent metered billing)
# ═════════════════════════════════════════════════════════════════════════════
class TestBlocker6CredentialSource:

    METERED = dict(RESP_ISO, credential_source="xai")

    def test_RED_metered_response_is_indistinguishable_on_success_alone(self):
        assert self.METERED["success"] is True
        assert self.METERED["credential_source"] != "xai-oauth"

    def test_oauth_source_is_clean(self):
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO])
        assert rep["credential_ok"] is True
        assert rep["credential_sources"] == ["xai-oauth"]
        assert not any("METERED" in a for a in rep["alerts"])

    def test_metered_fallback_alerts_loudly(self):
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[self.METERED])
        assert rep["credential_ok"] is False
        assert any("METERED" in a for a in rep["alerts"])

    def test_metered_fallback_still_returns_rows(self):
        """Alert, don't discard — the data is fine, the BILLING is the problem."""
        cands, _ = xg.gather(["simonw"], *WINDOW, responses=[self.METERED])
        assert len(cands) == 2

    def test_cli_exits_nonzero_on_credential_fallback(self, tmp_path):
        p = tmp_path / "metered.json"
        p.write_text(json.dumps(self.METERED))
        rc = xg.main(["--handle", "simonw", "--since", WINDOW[0], "--until", WINDOW[1],
                      "--from-response", str(p), "--out", str(tmp_path / "o.json")])
        assert rc != 0


# ═════════════════════════════════════════════════════════════════════════════
# THE SOURCING CONTRACT — operator syntax, handles-in-both, chunking, tripwire
# ═════════════════════════════════════════════════════════════════════════════
class TestSourcingContract:

    def test_query_is_operator_syntax_not_prose(self):
        q = xg.build_query(["elonmusk"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z", 100)
        assert "from:elonmusk min_faves:100 since:2026-07-24 until:2026-07-26" in q
        for prose in ("most recent posts", "Please find", "Show me"):
            assert prose not in q

    def test_G1_handles_appear_in_the_query_text_not_only_the_param(self):
        """G1/F2: `allowed_x_handles` does NOT reach the prompt. A query that
        doesn't name them returns 'the query does not list any handles'."""
        q = xg.build_query(["simonw", "karpathy", "ollama"],
                           "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z")
        for h in ("simonw", "karpathy", "ollama"):
            assert f"from:{h}" in q

    def test_since_until_always_present(self):
        q = xg.build_query(["a"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z")
        assert "since:2026-07-24" in q and "until:2026-07-26" in q

    def test_min_faves_zero_omits_the_operator(self):
        q = xg.build_query(["a"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z", min_faves=0)
        assert "min_faves" not in q

    def test_retweets_opt_in_only(self):
        base = xg.build_query(["a"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z")
        assert "include:nativeretweets" not in base
        rt = xg.build_query(["a"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z",
                            include_retweets=True)
        assert "include:nativeretweets" in rt

    def test_query_demands_string_ids_and_iso_timestamps(self):
        q = xg.build_query(["a"], "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z")
        assert "STRING" in q and "ISO8601" in q

    def test_chunking_respects_the_ten_handle_cap(self):
        chunks = xg.chunk_handles([f"h{i}" for i in range(35)], chunk_size=10)
        assert all(len(c) <= 10 for c in chunks)
        assert sum(len(c) for c in chunks) == 35

    def test_heavy_accounts_go_solo(self):
        chunks = xg.chunk_handles(["elonmusk"] + [f"h{i}" for i in range(5)],
                                  chunk_size=10, solo=["elonmusk"])
        assert ["elonmusk"] in chunks
        assert len(chunks) == 2

    def test_chunking_dedupes_case_insensitively(self):
        assert xg.chunk_handles(["Simonw", "simonw", "@SIMONW"]) == [["Simonw"]]

    def test_build_query_rejects_over_cap_chunks(self):
        with pytest.raises(ValueError):
            xg.build_query([f"h{i}" for i in range(11)],
                           "2026-07-24T00:00:00Z", "2026-07-26T00:00:00Z")

    def test_truncation_tripwire_fires_at_the_cap(self):
        rows = [{"handle": "elonmusk", "tweet_id": str(1000 + i),
                 "tweet_text": f"post number {i} with a real body",
                 "likes": 500, "created_at": "2026-07-24T12:00:00Z"} for i in range(5)]
        resp = {"success": True, "credential_source": "xai-oauth",
                "answer": json.dumps(rows), "degraded": False,
                "inline_citations": [{"url": f"https://x.com/i/status/{1000+i}"} for i in range(5)]}
        _, stats = xg.adapt_chunk(resp, ["elonmusk"], *WINDOW, truncation_cap=5)
        assert "elonmusk" in stats["truncated_handles"]
        _, ok = xg.adapt_chunk(resp, ["elonmusk"], *WINDOW, truncation_cap=50)
        assert ok["truncated_handles"] == []

    def test_MEASURED_default_tripwire_is_10_not_the_specs_50(self):
        """🔴 SPEC CORRECTION, measured live 2026-07-25.

        The spec asserts operator syntax returns up to 50 rows and implies a cap of
        50. Live on @emollick with min_faves:100 a single 48h call returned EXACTLY
        10 rows, while splitting the same window into two 24h calls returned 10 + 4
        = 14. Ten is a real, silently-reached cap. A tripwire defaulted to 50 would
        never fire on it, so the default is 10.
        """
        assert xg.DEFAULT_TRUNCATION_CAP == 10

        ten = [{"handle": "emollick", "tweet_id": str(2000 + i),
                "tweet_text": f"a substantive post body number {i}",
                "likes": 300, "created_at": "2026-07-24T12:00:00Z"} for i in range(10)]
        resp = {"success": True, "credential_source": "xai-oauth", "degraded": False,
                "answer": json.dumps(ten),
                "inline_citations": [{"url": f"https://x.com/i/status/{2000+i}"} for i in range(10)]}

        _, stats = xg.adapt_chunk(resp, ["emollick"], *WINDOW)   # default cap
        assert "emollick" in stats["truncated_handles"], (
            "a handle returning exactly 10 must trip the wire under the default")

        # and the spec's 50 would have stayed silent on the same data
        _, spec_default = xg.adapt_chunk(resp, ["emollick"], *WINDOW, truncation_cap=50)
        assert spec_default["truncated_handles"] == [], (
            "RED-PROOF: with the spec's cap of 50 this real truncation is invisible")

    def test_tripwire_surfaces_in_the_run_alerts(self):
        ten = [{"handle": "emollick", "tweet_id": str(3000 + i),
                "tweet_text": f"another real post body number {i}",
                "likes": 300, "created_at": "2026-07-24T12:00:00Z"} for i in range(10)]
        resp = {"success": True, "credential_source": "xai-oauth", "degraded": False,
                "answer": json.dumps(ten),
                "inline_citations": [{"url": f"https://x.com/i/status/{3000+i}"} for i in range(10)]}
        _, rep = xg.gather(["emollick"], *WINDOW, responses=[resp])
        assert any("TRUNCATION TRIPWIRE" in a for a in rep["alerts"])

    def test_likes_floor_applied_with_thought_leader_bypass(self):
        rows = [{"handle": "nobody", "tweet_id": "1", "tweet_text": "under floor body text",
                 "likes": 5, "created_at": "2026-07-24T12:00:00Z"},
                {"handle": "karpathy", "tweet_id": "2", "tweet_text": "tl under floor body",
                 "likes": 5, "created_at": "2026-07-24T12:00:00Z"}]
        resp = {"success": True, "credential_source": "xai-oauth", "degraded": False,
                "answer": json.dumps(rows),
                "inline_citations": [{"url": "https://x.com/i/status/1"},
                                     {"url": "https://x.com/i/status/2"}]}
        cands, _ = xg.adapt_chunk(resp, ["nobody", "karpathy"], *WINDOW,
                                  min_faves=100, bypass_handles=["karpathy"])
        assert {c["authorHandle"] for c in cands} == {"karpathy"}

    def test_per_handle_row_counts_are_logged(self):
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO])
        assert rep["per_handle"]["simonw"] == 2

    def test_positive_proof_counters_present(self):
        """§6c: a posted brief with x_search_calls=0 is a silent fallback = FAILURE."""
        _, rep = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO])
        for k in ("x_search_calls", "chunks_ok", "chunks_failed", "rows_parsed",
                  "rows_malformed", "rows_after_window_filter",
                  "rows_after_likes_filter", "candidates_emitted"):
            assert k in rep
        assert rep["x_search_calls"] == 1
        assert rep["candidates_emitted"] == 2

    def test_every_candidate_is_stamped_with_the_grok_gather_source(self):
        cands, _ = xg.gather(["simonw"], *WINDOW, responses=[RESP_ISO])
        assert all(c["gather_source"] == "x_search" for c in cands)


# ═════════════════════════════════════════════════════════════════════════════
# PARSE ROBUSTNESS — "JSON only" is model behavior, not an API contract
# ═════════════════════════════════════════════════════════════════════════════
class TestParseRobustness:

    ROW = [{"handle": "a", "tweet_id": "1", "tweet_text": "body text here",
            "likes": 1, "created_at": "2026-07-24T00:00:00Z"}]

    def test_bare_array(self):
        assert len(xg.extract_rows(json.dumps(self.ROW))) == 1

    def test_code_fenced(self):
        assert len(xg.extract_rows("```json\n" + json.dumps(self.ROW) + "\n```")) == 1

    def test_prose_wrapped(self):
        blob = "Here are the posts I found:\n" + json.dumps(self.ROW) + "\nHope that helps!"
        assert len(xg.extract_rows(blob)) == 1

    def test_object_wrapper(self):
        assert len(xg.extract_rows(json.dumps({"posts": self.ROW}))) == 1

    def test_garbage_returns_empty_not_an_exception(self):
        assert xg.extract_rows("I could not find any posts.") == []
        assert xg.extract_rows("") == []
        assert xg.extract_rows(None) == []

    def test_malformed_rows_counted_not_silently_dropped(self):
        resp = {"success": True, "credential_source": "xai-oauth", "degraded": False,
                "answer": json.dumps([{"handle": "a", "tweet_text": "no id and no url"}]),
                "inline_citations": []}
        _, stats = xg.adapt_chunk(resp, ["a"], *WINDOW, verify_citations=False)
        assert stats["rows_malformed"] == 1

    def test_adapt_chunk_never_raises_on_junk(self):
        for junk in ({}, {"success": True}, {"success": True, "answer": "???"},
                     {"success": True, "answer": None, "credential_source": "xai-oauth"}):
            cands, stats = xg.adapt_chunk(junk, ["a"], *WINDOW)
            assert isinstance(cands, list) and isinstance(stats, dict)
