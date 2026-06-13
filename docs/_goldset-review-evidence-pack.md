# Evidence Pack — Gold-Set Certification PRD (ground truth; trust this)

## FACT 1 — the gap is real (ran the gold set through the live engine at 24c965f)
All 15 gold items carry NO content_type/actionability/substance/on_topic labels.
Scoring them through score_item() → 15/15 `label_coerced:true` (fall to SAFE_DEFAULT).
Sample results (label = the gold human label, final = engine score):
  incident-yohei-2like        gold=neutral    final=36.0 coerced=True
  incident-bitnewsbot-spam    gold=known_bad  final= 0.0 coerced=True
  incident-emollick-routing   gold=known_good final=48.0 coerced=True  ← below ALSO_GATE despite being known_good
  incident-elon-reply-fragment gold=known_bad final= 0.0 coerced=True
So "every known_good ≥ ALSO_GATE" is structurally unsatisfiable until items are labeled.

## FACT 2 — no harness exists
grep across scripts/ e2e/ __tests__/ for digest-gold-set / gold_set / shadow_pass_bar → ZERO hits.
The §6a bar is prose inside the JSON `_meta`, not executable. Nothing scores the gold set.

## FACT 3 — gold set status
docs/eval/digest-gold-set.json `_meta.status` = "DRAFT — awaiting Ace ratification of each label".
`owner_ratify` = "Ace". 15 items. Never ratified.

## FACT 4 — SAFE_DEFAULT (score_digest.py L144-146)
SAFE_DEFAULT = {content_type: "opinion", actionability: "context_only", substance: "mixed", on_topic: "adjacent"}
→ BASE[opinion][context_only] = 25. This is why unlabeled items score mid-low and coerce.

## FACT 5 — the engine entry points the harness will call (score_digest.py)
- select_shadow(pool, ..., *, max_top, max_also, top_gate, also_gate)  L486 — the FULL production pipeline
  (event-collapse → forced-distribution → gates → TOP/ALSO). RECENCY_AS_TIEBREAK gates = 49/45 (L70-75).
- score_item(item, ...) L399 — per-item; reads the 4 enum labels; SAFE_DEFAULT on missing → coerces.
- normalize_labels(item) L188 — coerces missing/bad labels to SAFE_DEFAULT, flags label_coerced.
- Gates: default 58/50, tiebreak (RECENCY_AS_TIEBREAK=1, production's mode) 49/45.
- LOW_REACH_SCORE_CAP = ALSO_GATE - 5 (L134); OFF_TOPIC_PEN["off"] = 40 (L100).

## FACT 6 — gold schema vs engine schema
Gold items: {id, source, handle, likes/retweets OR hn_points, text, label, why}.
Engine reads: authorHandle, tweet_text, source, likes, retweets, + the 4 enum labels.
Harness must map handle→authorHandle, text→tweet_text before scoring.

## FACT 7 — existing test pattern (what the harness/test should match)
- Python selftests: `python3 scripts/score_digest.py --selftest`, `select_digest.py --selftest`.
- pytest suite: scripts/__tests__/*.py (pf_score_test.py, pf_audit_test.py, xfeed_shadow_test.py).
- JS gate: `npm run verify` = typecheck + lint + vitest + e2e. Python selftests run separately today.

## FACT 8 — non-goals (scope guard)
NOT re-tuning the scorer/gates/table. NOT building the 200-item corpus (roadmap). NOT certifying
the model LABELER (separate concern). NOT touching live prompt.md/cron (repo-only, no Hard-Config).
