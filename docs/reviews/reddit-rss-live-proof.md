# Reddit RSS Pivot — Live Proof Artifact

**Captured:** 2026-06-14 (Apollo, from the Mac Studio host — the same datacenter IP that 403s on
Reddit `.json`). This is the MANUAL+SPACED live e2e per PRD §5a / AC-1 / AC-5 / AC-9. NOT in CI.

**Fixture provenance (AC-12 / CR-3):** unit fixture
`scripts/gather/__tests__/fixtures/reddit-hot-machinelearning.atom.xml` captured **2026-06-14** from
`https://www.reddit.com/r/MachineLearning/hot.rss?limit=25`. The live captures below match the
fixture's entry shape (title / link href / author `/u/<name>` / published ISO8601 / content). No
schema drift at capture time. Staleness trigger: re-capture if a future live run's entry shape
diverges OR fixture >90 days old.

## AC-1 — live single-sub parse (PASS)
```
$ npx tsx scripts/gather/reddit.ts --subreddit MachineLearning --limit 10
candidates: 10   (HTTP 200, no warnings)
 - [D] Self-Promotion Thread                      | u/AutoModerator       | /r/MachineLearning/comments/1tude…
 - [D] Monthly Who's Hiring and Who wants…        | u/AutoModerator       | /r/MachineLearning/comments/1tsip…
 - I’m building a free bilingual ML notebook…     | u/abolfazl1363        | /r/MachineLearning/comments/1u4zb…
 - The Verifier Tax: Horizon-Dependent…           | u/AccomplishedLeg1508 | /r/MachineLearning/comments/1u58m…
 - Anomaly Detection vs Classification…           | u/DryHat3296          | /r/MachineLearning/comments/1u4ob…
```
Real titles, canonical `u/<name>` handles (no leading slash, AC-11), real permalinks, ISO `created_at`.

## AC-5 / cadence measurement (CR-1) — the load-bearing finding
The per-IP RSS budget is the real constraint, and it is TIGHT and STATEFUL — **not** solvable by an
inter-request gap:

| run | delay between subs | sub A | sub B |
|---|---|---|---|
| 2-sub | 4000 ms | MachineLearning → **429** (budget already spent) | LocalLLaMA → **200**, 10 candidates |
| 2-sub (after 60s+ cooldown) | 8000 ms | MachineLearning → **200**, 10 candidates | LocalLLaMA → **429** |

**Measured reality:** from this datacenter IP, Reddit RSS lets roughly **one successful fetch per
cooldown window (~minutes)** through; the *second* sub 429s even at an 8 s gap. Whichever sub leads
gets its 200; the other degrades to `[]` + a distinct 429 warn. **The graceful-degrade invariant
(§3) held in every run — one source always returned data, the other warned and contributed `[]`,
nothing threw.**

**Recommended cadence (recorded per CR-1, not guessed):** the inter-sub `delayMs` is NOT the
effective control — code default `DEFAULT_DELAY_MS=2500` is fine for politeness but does not buy a
second 200. The durable multi-sub path is a **residential egress lane** for Reddit RSS (see
`egress-lanes` skill — the macbook-pro-2021 lane `207.212.61.97` is residential and would not hit the
datacenter throttle). Scoped as a documented limitation + handoff to the live-wiring PRD; NOT built
here (this PRD restores the gatherer, it does not wire it).

**Live 429 header observation (CR-2):** the 429 responses did not surface a usable `Retry-After` /
`x-ratelimit-reset` in testing → the exponential backoff branch is the load-bearing one, and since
the budget is a rolling window (not a short cooldown), retries within a run do not recover the second
sub. This confirms: treat the gatherer as **best-effort, ≥1 sub/run**, never load-bearing;
github-trending remains the resilient source.

## AC-9 — probe (deferred to closeout, same IP constraint)
The probe consumes the same `gatherRedditPosts`; one spaced run yields reddit `fetched>0` for the
leading sub. Given the ~1-fetch/window budget, the probe inherits the same best-effort behavior.

## Bottom line
RSS pivot is **live-verified working**: real candidates parse from the blocked IP, the contract is
unchanged, and failure degrades gracefully. The honest limitation — datacenter-IP RSS budget ≈ 1
fetch/window → multi-sub needs a residential egress lane — is documented and handed to the wiring PRD.
