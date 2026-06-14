# PRD — Reddit Discovery Gatherer: API→RSS Pivot

- **Status:** v3 (Pass-2 APPROVE WITH CHANGES cleared — CR-1/2/3 applied; CR-4 no-change-needed)
- **Project:** siftly-ace (`Kyzcreig/siftly-ace`)
- **Owner:** Apollo
- **Component:** `scripts/gather/reddit.ts` (discovery gatherer; NOT wired into any live brief yet)
- **Supersedes:** the app-only OAuth approach (commit `f4af53a`) — dead end, see §1.

---

## 1. Summary & Goal

**What changes:** Replace the Reddit discovery gatherer's data source from the Reddit Data API
(OAuth/JSON) to Reddit's **public RSS/Atom feeds** (`/r/<sub>/hot.rss`).

**Why now:** The API path is dead for our use case, verified live:
- Reddit's "Responsible Builder Policy" (Nov 2025) **closed self-service API access** — every new
  app requires manual approval; personal "script" apps do not qualify (documented, widespread; the
  `prefs/apps` create form rejects with the policy link — Ace hit this directly).
- Anonymous `.json` reads return **403** from the Mac Studio host (datacenter-IP block, since
  2026-05-30) on every User-Agent and every egress lane (Starlink included).
- **But `/r/<sub>/hot.rss` returns HTTP 200** from the same blocked IP — live-verified: 60 KB Atom,
  25 entries parsed clean (title, link, author, summary, published).

RSS gives exactly what a *discovery gatherer* needs (what's hot in N subs today). The gatherer's job
is candidate **inflow** for the morning brief, not deep data mining — RSS is sufficient by design.

**Goal:** `gatherRedditPosts()` returns real candidates again, with no API/OAuth/credential
dependency, surviving Reddit's per-IP RSS rate-limiting via polite sequential fetching + retry.

## 2. Non-Goals

- Comment trees, full-text post bodies beyond the RSS `<content>`/`<summary>`, vote manipulation, or
  any write action. (RSS is read-only metadata; that's all we need.)
- Wiring the gatherer into a live brief prompt — that remains a **separate, gated** step (out of
  scope here; this PRD only restores the gatherer + its probe).
- A third-party scraping API (e.g. FetchLayer) — adds a paid external dependency + API key for no
  benefit over free RSS at our volume. Explicitly rejected.
- Authenticated RSS (private/multireddit feeds with a token) — not needed for public subs.
- Changing `github-trending.ts` — it's healthy (HTTP 200, ~14 net-new/run), untouched.

## 3. Constitution / Invariants

- **Invariant: the gatherer NEVER throws into a caller.** A failed/throttled/malformed source logs a
  warning and contributes `[]`; the brief/probe pipeline must not break on Reddit being down.
  - *Why:* the morning brief is load-bearing; a discovery source must degrade, never cascade.
  - *Closeout proof:* unit tests for 429/403/5xx/malformed/network-throw all resolve (no throw);
    existing "returns [] and warns" test still green.
- **Invariant: output contract unchanged (shape); engagement values intentionally degrade.** The
  `RedditCandidate` **shape** (title, url, summary, source:'reddit', authorHandle, engagement_raw{
  score,upvotes,comments,normalized}, created_at) is byte-identical so zero downstream *type* changes.
  **But the engagement *values* intentionally change**: JSON carried real score/upvotes/comments; RSS
  carries none, so they become honest `0` + neutral `normalized` (see Invariant "honest engagement").
  This is a deliberate behavioral degrade, not a parse bug — a future reader must not treat a
  zero-engagement reddit candidate as broken. (F2-3.)
  - *Why:* `gatherer_probe.ts` + cross-brief dedup consume this shape; brief scoring tolerates a
    neutral-engagement source.
  - *Closeout proof:* `tsc` clean; probe runs against live RSS; a code comment + AC-3 state the
    intentional engagement degrade.
- **Invariant: `authorHandle` canonical form is `u/<name>` (no leading slash), matching the prior
  bare-handle shape.** RSS Atom gives `<author><name>/u/<name></name>` (or sometimes bare `<name>`);
  the parser MUST normalize to exactly `u/<name>` — strip a leading `/u/` or `/`, then ensure a single
  `u/` prefix — identical to what the old JSON path produced from bare `data.author`. (RC-3.)
  - *Why:* §"byte-identical output" forbids silent handle drift; dedup/display may key on it.
  - *Closeout proof:* unit test asserts the exact `authorHandle` string from the fixture.
- **Invariant: no new runtime dependency.** Parse Atom with the same regex/string approach
  `github-trending.ts` already uses for HTML. No `fast-xml-parser`/`cheerio`/etc.
  - *Why:* keep the gatherer dependency-free and consistent with the existing house style.
  - *Closeout proof:* `package.json` diff adds no dependency; `npm ls` unchanged.
- **Invariant: polite to Reddit, cadence derived from MEASURED spacing (not guessed).** Sequential
  per-sub fetches with a delay between them; bounded retry on 429 that **honors `Retry-After` /
  `x-ratelimit-reset` response headers when present**, else exponential backoff; a hard cap on total
  requests per run. No parallel hammering. The default `delayMs` MUST be set from the spacing that
  empirically produced repeatable 200s (measured during Phase-2 closeout, recorded in the doc) — a
  guessed 2 s is explicitly the "back-to-back" cadence the evidence shows gets 429'd. (RC-1.)
  - *Why:* Reddit per-IP rate-limits RSS hard (proven: back-to-back probes 429'd). A fixed-2 s retry
    re-hits a throttled endpoint and 429s again.
  - *Closeout proof:* unit test asserts sequential ordering + delay invoked + 429-retry honors a
    `Retry-After` header (mocked); a live spaced 2-sub run returns 200/200 with the recorded delay.
- **Invariant: an empty feed is observable, not silent-success.** A 200 with valid Atom but **zero
  `<entry>`** (quarantined/typo'd/private sub — reachable via `--subreddit`) returns `[]` with a
  **distinct** warn (`reddit gather <sub>: empty feed (0 entries)`), separate from the 429/error
  warns, so "bad sub name" is distinguishable from "throttled" in logs. (RC-4.)
  - *Why:* §"never throw" already gives `[]`; without a distinct signal a typo looks like a throttle.
  - *Closeout proof:* unit test: 200 + zero entries → `[]` + the empty-feed warn (not the 429 warn).
- **Invariant: engagement signal degrades honestly.** RSS Atom does NOT carry score/upvotes/
  comments. The gatherer must NOT fabricate them — emit `0`/neutral-normalized and document it, or
  parse only what RSS genuinely provides.
  - *Why:* fake engagement numbers would silently corrupt brief scoring.
  - *Closeout proof:* test asserts engagement fields are `0` (or genuinely-parsed) for an RSS entry
    with no metrics; a code comment states RSS has no engagement metrics.

## 4. Resolved Decisions

- **D-1 — RSS over API.** Reddit API is closed to us (policy + 403). RSS `hot.rss` works live. Pivot.
- **D-2 — `hot.rss` feed.** `https://www.reddit.com/r/<sub>/hot.rss?limit=<n>` returned 200; the
  bare `/.rss` and `old.reddit` variants 429'd more readily. Use `www` + `hot.rss`.
- **D-3 — Regex Atom parse, no dep.** Match the `github-trending.ts` style (regex + entity-decode).
  Atom is simple and stable enough; a dep is unjustified for 5 fields.
- **D-4 — Sequential + delay + bounded 429 retry; cadence is MEASURED, not defaulted.** Per-IP rate
  limit is the real constraint. There is **no hardcoded `delayMs` default** — it is set from the
  spacing that empirically yields repeatable 200s, measured during Phase-2 and recorded in
  `docs/reviews/reddit-rss-live-proof.md`. A guessed ~2 s is explicitly forbidden (it's the
  back-to-back cadence the evidence shows 429s). On 429: honor `Retry-After`/`x-ratelimit-reset` if
  the live response carries one (to be observed in Phase-2 — see CR-2), else exponential backoff off
  the measured base; retries capped (≤2). (CR-1/CR-2.)
- **D-5 — Engagement = honest zeros.** Atom carries no score/comments. Emit `0`s + neutral
  normalized; do not fabricate. (If `hot.rss` ever includes a metric, parse it; otherwise zeros.)
- **D-6 — Rip out the dead OAuth + cred plumbing.** Remove the app-only token code from `reddit.ts`,
  the Reddit block from `with-secrets.sh`, and the Reddit vars from `.env.example`. Drop the 3 OAuth
  unit tests; replace with RSS tests. (Keeps the codebase honest — no dead "set these creds" paths
  that will never work.)
- **D-7 — Default subs unchanged.** `['LocalLLaMA', 'MachineLearning']` stays the default; CLI
  `--subreddit` still overrides. `--limit` still honored (clamped 1–100).
- **D-8 — User-Agent stays descriptive.** Keep a real descriptive UA string (Reddit asks for one);
  it doesn't fix the API 403 but is correct etiquette for RSS and avoids the generic-UA throttle.

## 5. Architecture / Design

```
gatherRedditPosts({ subreddits, limit, fetchImpl?, logger?, delayMs?, maxRetries? })
  for each subreddit (SEQUENTIAL):
    url = https://www.reddit.com/r/<safe-sub>/hot.rss?limit=<n>
    resp = fetchWithRetry(url, { UA, retries on 429 w/ backoff, cap })
      ├─ 200 → parseAtom(xml) → RedditCandidate[]   (regex extract <entry>: title, link, author,
      │                                                content/summary→summary, published→created_at;
      │                                                engagement = honest 0s + neutral normalized)
      ├─ 429 after retries → logger.warn, contribute []   (no throw)
      ├─ 403/4xx/5xx → logger.warn, contribute []          (no throw)
      └─ network throw / malformed XML → logger.warn, []   (no throw)
    if not last sub → await sleep(delayMs)        # politeness gap
  return candidates   # union across subs, never throws
```

- **Atom shape (verified live):** `<feed><entry><title>…</title><link href="…"/><author><name>
  /u/…</name></author><content type="html">…</content><published>ISO8601</published>…`. The post URL
  is the `<link href>` (permalink to the comments page); `author` is `/u/<name>` →
  `authorHandle = u/<name>` after stripping the leading `/u/` if Reddit prefixes it.
- **`parsePost` replacement:** today it reads JSON `data.{title,url,score,...}`. New `parseAtomEntry`
  reads the Atom fields. Same `RedditCandidate` out. `engagement_raw.{score,upvotes,comments}=0`,
  `normalized = normalizeEngagement('reddit', 0, 1)` (neutral). Keep `redditUrl()` normalization.
- **`fetchWithRetry`:** small local helper (no dep). On `status===429`, sleep backoff and retry up to
  `maxRetries`; any other non-ok → return it (caller warns + skips). Injectable `sleepImpl` for
  hermetic tests (no real timers).
- **Reuse:** `decodeHtmlEntities`/`stripTags`-style helpers — factor the shared ones or duplicate the
  tiny entity-decoder locally (it already exists in github-trending; a shared `lib/html-text.ts` is
  optional cleanup, not required — keep diff minimal per coding-guardrails).

## 5a. Testing Strategy — CI is hermetic, live is a manual spaced artifact (RC-2, RC-5)

The live `hot.rss` endpoint is rate-limited (429 under any CI/retry cadence). Putting it on the
`npm run verify`/CI critical path would either flake (→ people re-run until green = fake approval) or
get silently swapped for the fixture. So the split is **explicit and load-bearing**:

- **CI / `npm run verify` (AC-8) = HERMETIC.** Only the captured-Atom **fixture** test + **mocked-
  fetch** unit tests (retry/backoff/empty-feed/malformed/handle). No network. This is the gate that
  must be green to merge.
- **Live e2e (AC-1, AC-5, AC-9) = MANUAL, SPACED, COMMITTED ARTIFACT.** Run by hand at closeout with
  real spacing, capture the real 200 + parsed titles into a committed evidence file
  (`docs/reviews/reddit-rss-live-proof.md`, like the existing `docs/reviews/*` proofs). NOT in CI.
- **Fixture provenance + staleness catcher (RC-5/CR-3):** the committed Atom fixture carries a header
  comment with its capture **date + source URL**. The fixture proves the *parser*; the live run
  proves the *feed still matches the fixture's shape*. A header comment is inert, so name the catcher
  explicitly: the manual live-proof artifact **records the fixture's capture date next to the live
  capture date** so the gap is visible at closeout, and the **staleness trigger is concrete** —
  re-capture the fixture when the live run's entry shape diverges from it OR the fixture is >90 days
  old. CI (hermetic) cannot catch drift by design; the closeout/periodic live run is who/when catches
  it.

- **Phase 1 — RSS fetch + Atom parse (core swap).** Replace JSON fetch/parse with `hot.rss` fetch +
  `parseAtomEntry`. Keep signature + `RedditCandidate` shape. Honest-zero engagement.
  - *Unit/script check:* feed a captured real Atom fixture (header: capture date + source URL) →
    asserts N candidates with correct title/url/author/created_at; engagement all 0; `authorHandle`
    exact-string assertion (`u/<name>`, no leading slash).
  - *E2E/integration check:* **required, MANUAL+SPACED (not CI)** — live `tsx scripts/gather/
    reddit.ts --subreddit MachineLearning --limit 10` returns ≥1 real candidate; capture to
    `docs/reviews/reddit-rss-live-proof.md`.
  - *Negative/adversarial:* malformed XML body → `[]` + warn (no throw); empty `<feed>` → `[]` + warn.
  - *Verify with:* `npx vitest run reddit` (fixture) + the live CLI run above → real titles printed.

- **Phase 2 — Rate-limit politeness (sequential + delay + 429 retry).** Add `delayMs` gap between
  subs and `fetchWithRetry` (bounded backoff, cap), both injectable for tests.
  - *Unit/script check:* mock fetch returns 429 (with `Retry-After`) twice then 200 → asserts it
    retried, honored the header delay, and succeeded; assert `sleepImpl` called between subs
    (sequential, not parallel).
  - *E2E/integration check:* **required, MANUAL+SPACED (not CI)** — live 2-sub run returns 200 for
    both with the **measured** delay (no 429); record the delay used in the live-proof artifact.
  - *Negative/adversarial:* 429 on every attempt → after `maxRetries`, `[]` + warn (no throw, no
    infinite loop).
  - *Verify with:* `npx vitest run reddit`; live two-sub CLI run shows both parsed.

- **Phase 3 — Remove dead OAuth/cred plumbing.** Delete OAuth token code + `__resetRedditTokenCache
  ForTests` from `reddit.ts`; remove Reddit block from `with-secrets.sh`; remove Reddit vars from
  `.env.example`; delete the 3 OAuth tests (replaced by RSS tests).
  - *Unit/script check:* `grep -rniE "REDDIT_CLIENT|REDDIT_SECRET|REDDIT_APP_ITEM|oauth.?reddit|
    access_token|__resetRedditTokenCache" scripts/ .env.example` (INCLUDING the test dir) → no
    matches; `bash -n scripts/with-secrets.sh` clean. (F2-5: broadened beyond `REDDIT_CLIENT`.)
  - *E2E/integration check:* `Not applicable: deletion of dead config; covered by grep + tsc + full
    suite.`
  - *Negative/adversarial:* `Not applicable: removing an unreachable code path.`
  - *Verify with:* `npm run verify` exit 0 (tsc + lint + unit + e2e).

- **Phase 4 — Probe + docs alignment.** Confirm `gatherer_probe.ts` still classifies reddit inflow
  live; update AGENTS.md (root cause + RSS pivot, retire the OAuth note) and `.env.example` header.
  - *Unit/script check:* `Not applicable: doc + live probe.`
  - *E2E/integration check:* **required** — `tsx scripts/gatherer_probe.ts --dry-run` shows a nonzero
    `reddit` `fetched` count from live RSS, github-trending still healthy.
  - *Negative/adversarial:* `Not applicable.`
  - *Verify with:* probe dry-run output shows reddit `fetched>0`, `error: null`.

## 7. Security, Privacy, Ops, Observability

- **Credentials:** none — net removal of a credential surface (Reddit creds no longer referenced
  anywhere). Strictly safer than the status quo.
- **Egress:** unauthenticated GET to `www.reddit.com` RSS only. Public data.
- **Failure alerts:** the gatherer logs warnings; the *consumer* (probe/cron) owns alerting. No new
  alert path. If later wired into the daily cron, failures route to `#alerts` per existing routing
  (out of scope here).
- **Observability:** per-sub warn lines name the sub + HTTP status (`reddit gather <sub>: HTTP 429
  after retries; returning []`), so a throttle is visible in logs.
- **Rollback:** single-file logic + tests; `git revert` of the pivot commit restores prior state.
  Nothing is wired live, so rollback is zero-blast-radius.

## 8. Risks & Mitigations

- **R1 — Reddit tightens RSS rate limits / blocks RSS too.** *Mitigation:* graceful `[]` (brief
  unaffected); github-trending remains a healthy source; the polite cadence (daily, few subs, spaced)
  is the lightest possible footprint. Monitor probe `fetched` count.
- **R2 — Atom schema drift (Reddit changes feed format).** *Mitigation:* parser is defensive
  (missing fields → skip entry, never throw); fixture test catches a shape change on next run;
  malformed → `[]` + warn.
- **R3 — False "it works" from a unit fixture while live RSS is 429'd.** *Mitigation:* e2e checks are
  **live** (real `hot.rss` fetch), spaced to respect the limit; closeout requires a real 200 + parsed
  titles, not just the fixture.
- **R4 — Engagement-zero degrades brief scoring quality** (if/when wired). *Mitigation:* documented
  honest-zero; brief scoring already tolerates a source with neutral engagement; revisit only if a
  metric becomes available. Not a blocker for the gatherer itself.
- **R5 — Per-IP 429 during the daily cron window.** *Mitigation:* sequential + delay + bounded retry.
  **MEASURED LIMITATION (live, 2026-06-14, see `docs/reviews/reddit-rss-live-proof.md`):** from the
  Mac Studio datacenter IP, Reddit RSS allows ≈ **1 successful fetch per rolling window (~minutes)** —
  the inter-sub gap (tested 4 s, 8 s) does NOT buy a second 200; whichever sub leads gets its data,
  the other 429s and degrades to `[]`+warn. The graceful-degrade invariant held in every run. The
  durable multi-sub fix is a **residential egress lane** for Reddit RSS (`egress-lanes` skill; the
  residential macbook-pro lane would dodge the datacenter throttle) — scoped as a handoff to the
  live-wiring PRD, NOT built here (this PRD restores the gatherer; it does not wire it). Treat the
  gatherer as **best-effort, ≥1 sub/run**; github-trending is the resilient source.

## 9. Open Questions

- **OQ-1:** Final cadence values (`delayMs`, `maxRetries`, backoff base) — **measured in Phase-2**,
  not pre-defaulted (CR-1). The Phase-2 live run also **records whether the live RSS 429 response
  carries a `Retry-After`/`x-ratelimit-reset` header** (free to observe — a 429 must be triggered to
  verify the cap anyway); if it doesn't, the measured backoff base is the load-bearing tunable, not a
  header that never arrives (CR-2). Both recorded in `reddit-rss-live-proof.md`.
- **OQ-2:** Should `summary` carry the RSS `<content>` HTML stripped to text, or a compact
  `r/<sub> • <author>` line when content is just the post body? (Lean: stripped content text,
  truncated ~600 chars, matching today's `cleanSummary`.)

## 10. Acceptance Criteria

- [ ] **AC-1** WHEN `gatherRedditPosts` fetches a live `hot.rss` feed THEN it returns ≥1
  `RedditCandidate` with real title+url+author+created_at. Evidence: **manual spaced** live `tsx
  scripts/gather/reddit.ts --subreddit MachineLearning --limit 10` prints real Reddit titles,
  captured in `docs/reviews/reddit-rss-live-proof.md` (NOT in CI).
- [ ] **AC-2** WHEN a source returns 429/403/5xx/malformed/network-error THEN the gatherer returns
  `[]` and warns, never throws. Evidence: `npx vitest run reddit` negative-path cases green.
- [ ] **AC-3** The `RedditCandidate` **shape** is unchanged; engagement **values** intentionally
  degrade to honest-zero (per Invariant). Evidence: `tsc --noEmit` clean; probe consumes output
  without change; a code comment + this AC state the intentional engagement degrade (F2-3).
- [ ] **AC-4** No new runtime dependency. Evidence: `package.json` dependencies diff empty.
- [ ] **AC-5** Multi-sub fetch is sequential with a **measured** delay (not a guessed default) and
  bounded 429 retry honoring `Retry-After` when present. Evidence: unit test asserts header-honored
  retry-then-success + inter-sub sleep; **manual spaced** live 2-sub run returns both 200 with the
  **measured delay recorded** in `reddit-rss-live-proof.md` (and whether the live 429 carried a
  rate-limit header).
- [ ] **AC-6** No Reddit credential/OAuth references remain (broadened). Evidence: `grep -rniE
  "REDDIT_CLIENT|REDDIT_SECRET|REDDIT_APP_ITEM|oauth.?reddit|access_token|__resetRedditTokenCache"
  scripts/ .env.example` (incl. test dir) → no matches.
- [ ] **AC-7** Engagement fields are honest (0, not fabricated) for RSS entries. Evidence: unit test
  asserts `engagement_raw.{score,upvotes,comments}===0`.
- [ ] **AC-8** Full **hermetic** gate green (fixture + mocks only; no network). Evidence: `npm run
  verify` exit 0 (tsc + lint + unit + e2e).
- [ ] **AC-9** Live probe shows reddit inflow restored. Evidence: **manual spaced** `tsx scripts/
  gatherer_probe.ts --dry-run` → reddit `fetched>0`, `error:null`, github-trending still healthy
  (captured in the live-proof artifact).
- [ ] **AC-10** A 200 with zero `<entry>` → `[]` + a **distinct** empty-feed warn (not the 429/error
  warn). Evidence: unit test asserts the empty-feed warn string (RC-4).
- [ ] **AC-11** `authorHandle` canonical form is exactly `u/<name>` (no leading slash), matching the
  prior bare-handle shape. Evidence: unit test asserts the exact string from the fixture (RC-3).
- [ ] **AC-12** The captured Atom fixture records its capture date + source URL, and the live-proof
  artifact records the fixture's capture date next to the live capture date (visible drift gap) with
  the concrete staleness trigger (>90 days or shape divergence). Evidence: fixture header comment +
  live-proof artifact present (RC-5/CR-3).

### Handoff invariant to the (future, separate) live-wiring PRD (F1-2)
When the gatherer is eventually wired into the daily cron, that PRD MUST add a **"reddit `fetched`
== 0 for N consecutive days" warn** so a silent RSS block (the same death the JSON path died) is
detectable — a `[]` from "Reddit is blocking us" must not look identical forever to "nothing hot
today." Recorded here so it isn't lost at the seam. The gatherer is **best-effort, never
load-bearing**; github-trending remains the resilient source.

## 11. Rollback

`git revert <pivot-commit>` restores the prior gatherer. Nothing is wired into a live brief, so the
blast radius is zero. The captured Atom fixture remains useful for regression either way.
