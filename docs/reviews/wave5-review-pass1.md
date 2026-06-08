All claims ground-truthed. Here's the review.

---

# Wave 5 PRD — Senior Review (Pass 1)

## Verdict

**BLOCK** — two cache-correctness defects in the *already-built* Feature 1 will silently serve stale / miss genuinely-new top-of-timeline tweets, and the day-key/TZ design is latently broken. Feature 1 must be patched + the day-boundary contract pinned before it can be trusted as the cost foundation for the Feature 2 confirming reruns. Features 2 & 3 have fixable spec gaps but no hard blocker on their own.

I ground-truthed everything below against `lib/x-feed-cache.ts`, `scripts/x-feed-fetch.ts`, the live cron (`30 7 * * *`, model `gpt-5.5`), the prompt, and the run-dir UTC timestamps — not the PRD prose.

---

## Critical Blockers

**B1 — Incremental top-up can MISS genuinely-new tweets, and the 24h trim in the incremental path is wrong (§3.1 step 2; `lib/x-feed-cache.ts` `fetchTimeline` incremental branch + `sweep`).**
Two compounding bugs:

1. **`created_at`-based 24h re-trim on merge silently deletes still-valid cached tweets.** The incremental branch does:
   `mergeTweets(existing.tweets, fresh).filter(t => !t.created_at || t.created_at >= since)`.
   `since` is recomputed as `now − 24h` on *every* run. A tweet that was 23h old when first cached is now 24h+ old on a rerun 90+ min later and gets **dropped from the merged cache and rewritten out of the file permanently**. Over a few same-day reruns the cache *shrinks from the bottom* — the brief sees a narrower-than-24h window than a fresh sweep would. This violates AC "brief output is byte-equivalent in shape to today's" and the "never silently lose content" user rule. The full-sweep (`miss`) path trims correctly during pagination; the incremental path re-trims an already-built corpus against a *moving* boundary. **Decouple the cache's retained window from the per-run `since`** (store the original sweep `since` in meta and trim only newly-fetched pages against it, or keep a fixed logical-day window).

2. **`idIsNewer` length-fallback is a real corruptness vector for `stopAtId`.** `idIsNewer` says "different length → longer is newer." X snowflake IDs are *currently* 19 digits but the cache persists across the 19→20-digit rollover and across any historical 18-digit ID that slips in. If a freshly-fetched new tweet's ID has a different digit length than `meta.newest_id`, the `stopAtId` comparison (`!idIsNewer(t.id, stopAtId)`) can stop the sweep too early (missing new tweets) or never stop (over-paging). Snowflake IDs are monotonic by *numeric value*, not string length+lex. **Compare as BigInt**, not length-then-lexicographic. (You already hit exactly this class of bug in `lib/vec.ts` — "better-sqlite3 binds float64; bind BigInt." Same lesson.)

**B2 — Cache day-key is UTC but the cron fires in local PT; the design is latently broken and the AC doesn't pin it (§3.1; `isoDay = now.toISOString().slice(0,10)`; cron `30 7 * * *`, `config.yaml timezone: ''`).**
Empirically confirmed: run dirs are `…143122Z` = 14:31 UTC = **07:31 PT**, so the scheduler runs the cron in **local PT**, while the cache day key is **UTC**. Today that's *accidentally* fine — 07:30 PT = 14:30 UTC lands mid-UTC-day, so the daily run always gets a fresh UTC-day key and a clean MISS. But:
- The PRD never states this invariant, so a future schedule change (e.g. moving the brief earlier, or a 2nd run) or the **PDT→PST shift** (07:30 PST = 15:30 UTC, still fine; but any run between 16:00–24:00 PT crosses into the *next* UTC day) can make "first run of the day" key to a UTC day that already has a stale file from the *previous* evening's manual rerun → it does an unwanted incremental top-up against yesterday, or a fresh sweep keyed wrong.
- The PRD's own Open-Question framing ("does a 7:30am PT run map to the right UTC day") is the right question and the answer is **"only by luck at the current schedule."** This needs to be a *pinned contract*, not an accident. **Either key the cache on local-PT day (matching the cron's mental model and the seen-list's `date` fields which are PT) or assert/document the UTC-day invariant with a test.** As written it's a time-bomb that won't show up in the dry-run proof.

**B3 — The "MISS = fresh sweep after midnight" guarantee isn't actually guaranteed; a stale prior-day file under the same key forces an incremental, not a fresh sweep (§3.1 steps 1–3).**
The day-rollover Open Question (1) — "does first run after midnight do a fresh sweep" — depends entirely on B2. If the day key rolls (new file name) → yes, clean MISS. If two calendar concepts collide (B2), the new day's first run can find an `existing` file and take the **incremental** branch, whose `stopAtId` is *yesterday's* `newest_id`. That path will fetch only pages newer than yesterday's newest — which is *most* of the new day — but then B1's moving-`since` trim and the BigInt bug apply to the largest, most important sweep of the day. **The daily cron must force a fresh sweep at the day boundary.** Recommendation: the daily 7:30 cron passes `--force` (it already pays for freshness; the cache exists for *reruns*, not the canonical daily run). This also resolves Open Question (1) cleanly: canonical run = always fresh; reruns = free. The PRD's §3.1 escape-hatch note ("cron can opt into freshness if ever desired; default is cache-respecting") has it backwards — **the daily run should default to fresh, reruns default to cached.**

---

## Required Changes

**RC1 — Feature 1: add the missing tests for the bugs above.** Current `__tests__/x-feed-cache.test.ts` covers MISS, merge-dedupe, id-ordering — but has **no test** for: (a) incremental re-trim not deleting still-in-window cached tweets across a moving `since`; (b) cross-digit-length ID `stopAtId` correctness; (c) day-key behavior at a PT/UTC boundary; (d) the 20-page ceiling on the *incremental* path (only verified on miss). AC §3.3 lists "TTL boundary" and "20-page ceiling honored on miss" but **not incremental-merge window correctness** — add it.

**RC2 — Feature 1: the "search/recent caching" in §3.1 is UNBUILT and out of the current artifact.** Confirmed: `scripts/x-feed-fetch.ts` and `lib/x-feed-cache.ts` contain **zero** `search/recent` calls — those 3 searches still live inline in `prompt.md` (4 occurrences). So Decision #3 (§7) "cache morning-digest search/recent too" and §3.1's "cache them too" are **net-new scope**, not part of the live-proven artifact. Either descope to a follow-up or spec the search-cache as its own task with its own tests. Don't let "Feature 1 is built" imply the search-cache is built — it isn't.

**RC3 — Feature 2: define exactly what PII lands in `pf-audit/*.json` and how it's pruned (§4.1).** Confirmed from `pf-score.py`: per-item output carries `id`, `url`, `authorHandle`/`author`/`username`, full candidate `text`, and topic signals. That's **Ace's full inbound timeline incl. author handles + verbatim tweet text** persisted forever to `~/.hermes/state/x-bookmarks/pf-audit/*.json` and an append-only `log.jsonl`. No secrets/tokens (pf-score reads no creds), so it's not a credential-leak risk — but it **is** a growing PII/content corpus with no retention policy. The brief's own seen-list prunes to 7 days; **pf-audit has no prune in the spec.** Add: a retention/prune policy (mirror the 7-day seen-list prune), confirm the dir is gitignored / outside any synced vault, and decide whether per-item raw `text` is needed in the durable artifact or whether `id` + scores + top-2 signals suffice (smaller, less PII). The Obsidian archive enrichment (§4.1) is fine — that vault already holds the tweets.

**RC4 — Feature 3: the §5.2(b) "auto-pick provider whose key is present" must account for `getProvider()`'s module-level cache (`lib/settings.ts`, `_cachedProvider` + `_providerCacheExpiry`).** The resolved provider is cached in-process with a TTL. A request-time "no usable key → auto-pick" guard that reads only `getProvider()` can be served a **stale cached provider** after Ace fixes the DB setting, and won't recover until the TTL expires. The guard must key off *actual key presence at request time* (which env keys exist) and bypass/invalidate the provider cache, not just re-read the cached value. Also: the 90s `codexPrompt`/`claudePrompt` `timeoutMs: 90_000` is confirmed at `route.ts` lines ~378/388 — bound it to ≤25s as specced.

**RC5 — Feature 3: §5.2 "auto-pick (b), hard-error (a) only if no key" needs a deterministic precedence rule.** If *both* `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are present but DB `aiProvider` is a typo, which wins? Auto-picking the "first key present" makes search results silently provider-dependent (different models, different match quality) — a correctness surprise. Ace's stated preference is **allowlist / fail-closed**. Recommend: if DB provider is set-but-unusable AND a *different* provider's key exists → auto-pick **with a loud logged warning + surface the resolved provider in the response** (already in the §5.3 AC). If DB provider is *unset* → pick deterministically (document the order). Make this an explicit table in the spec, not "prefer (b)."

**RC6 — Both prompt edits (G-W5-1, G-W5-2) are config-class gates per Hard Config Rules.** The PRD correctly flags this. Confirmed `.bak` discipline is already in use (`prompt.md.bak.20260608-163534-pre-cache` exists). One gap: G-W5-1's prompt edit is **already live** (the prompt already calls `x-feed-fetch.ts`) — so that gate was either already cleared or the edit shipped ahead of the gate. **Clarify in the PRD that Feature 1's prompt edit is DONE/approved**, otherwise P1's gate reads as pending work that's actually already in production.

---

## Lens Notes

**Architecture.** The pure-logic-+-IO-seam split (`lib/x-feed-cache.ts` testable, `scripts/x-feed-fetch.ts` injects xurl) is the right shape and makes B1/B2 fixable with unit tests rather than live spend. Good. The read-through pattern is sound; the bugs are in the *incremental* merge math, not the architecture.

**SRE / cost.** The 20-page ceiling + 402 `CreditsDepleted` handling are present in both `sweep` (throws on `status>=400`/`title`) and `realFetchPage` (maps 402). The PRD's cost-ceiling story (§3.1 credit-safety, §6 verification) is real. **But §6's cost note `~$${(pages*0.5)}`** in the log line assumes 100 reads/page × $0.005 = $0.50/page — verify that matches the actual per-*read* (not per-*page*) billing; the prompt says "$0.005/read" and a page is up to 100 tweets but billed as reads. If billing is per-request-page not per-tweet, the logged cost is 100× too high (harmless but misleading in the evidence doc). Pin the unit.

**Security.** No credential surface in Feature 1/2 (pf-score reads no secrets; cache holds public tweets). Feature 3's real risk is the **silent provider fallthrough**, which is a UX/correctness bug, not a security one. The redaction-layer gotcha (noted in AGENTS.md) applies to any prompt.md edit containing `$(op …)` — use `execute_code` literal-byte writes for those, not patch/write_file.

**QA.** Feature 1 has 10 tests but **zero** for the two failure modes in the Open Questions. "Live-proven cold=1/warm=0" proves the *hit* path, not the *incremental* path — the incremental branch (the riskiest code) is exercised by neither the live proof nor a targeted test. The dry-run proof in AC §3.3 ("two consecutive runs, second logs 0 reads") only validates HIT, not INCREMENTAL or day-rollover. **Add a 3rd-run-after-TTL-expiry dry-run** to the evidence.

**Implementation (Feature 2).** Symmetric prompt edits to *both* briefs is correct. The "fired: true|false + reason" contract is good and directly answers "should it have fired." One nit: `pf-score.py` already exits 0 on all errors with a sentinel — so "ok:false" is the only failure signal; make sure the audit logger distinguishes *timeout* (helper killed by `timeout 30s`, no JSON at all) from *ok:false* (helper ran, declined). Those are different root causes and the §4.1 `reason?` field should capture which.

---

## Open Questions

1. **(Cache staleness / missed new tweets — B1, B3)** Confirmed real: the incremental path's `merge…filter(t.created_at >= since)` with a per-run-recomputed `since` will *drop* still-valid cached tweets on reruns, and `stopAtId` uses length-then-lex ID comparison that's wrong across snowflake digit-length changes — so it can both serve a *shrunk* window and *miss* genuinely-new top-of-timeline tweets. **Will the daily 7:30 run use `--force` (fresh) so the canonical run never depends on the buggy incremental path?** I recommend yes; the PRD currently defaults the daily run to cache-respecting (§3.1), which is backwards.

2. **(Day boundary — B2)** Confirmed empirically: cron runs **local PT** (`…143122Z` = 07:31 PT), cache key is **UTC day** (`now.toISOString().slice(0,10)`), `config.yaml timezone: ''`. Today 07:30 PT = 14:30 UTC keys cleanly to a fresh UTC day — but **only by luck at this schedule.** Does the PRD intend UTC-day or PT-day keys? The seen-list uses PT dates. **Pin one and test it**, or B3 bites at the next schedule/DST change.

3. **(Audit PII — RC3)** `pf-audit/*.json` will persist Ace's full inbound timeline (author handles + verbatim tweet text) with **no retention policy** in the spec. No secrets, but unbounded PII growth. **What's the prune policy and is the dir gitignored / out of any synced vault?** Does the durable artifact need raw `text`, or do `id`+scores+signals suffice?

4. **(AI-search provider/key auto-pick — RC4, RC5)** §5.2(b) auto-pick must (a) survive `getProvider()`'s in-process provider cache (stale after Ace fixes the DB setting), and (b) have a **deterministic precedence** when multiple keys are present. As specced ("prefer (b)") it's underdetermined and makes search results silently provider-dependent. Allowlist/fail-closed table needed.

5. **(Config-gated prompt edit risk — RC6)** G-W5-1's prompt edit (inline loop → `x-feed-fetch.ts`) is **already live in production** (the prompt already calls the script; `.bak.20260608-…-pre-cache` exists). Is that gate already cleared with Ace, or did the edit ship ahead of approval? The PRD presents P1's gate as pending. Clarify.

6. **(Cost-ceiling + 402)** 402 `CreditsDepleted` handling is present (throws in `sweep`, mapped in `realFetchPage`) and the 20-page ceiling is honored on the miss path — but **not tested on the incremental path**, and the per-page `$0.50` cost-log unit needs confirming against actual per-read billing. Does a 402 mid-incremental leave a **partially-merged cache** that a later run treats as authoritative? The incremental branch writes the merged cache *after* `sweep` returns; if `sweep` throws on 402 it won't write — good — but confirm the daily run then alerts and doesn't post an empty/short brief off a half-cache.

---

**Bottom line:** Feature 1's *architecture* is approve-worthy and the hit-path is genuinely proven, but the incremental + day-key paths have two real correctness bugs (B1, B2/B3) that the existing tests and live proof don't exercise — exactly the paths the daily 7:30 cron will hit at a day boundary. Fix B1–B3 + RC1, pin the day-key contract, and make the daily run `--force`-fresh, and Feature 1 flips to APPROVE. Features 2 & 3 are APPROVE-WITH-CHANGES on RC3/RC4/RC5. Don't dispatch the Feature 2 confirming reruns until Feature 1's incremental path is fixed, or the "free rerun" will be computed off a silently-shrunk cache.
