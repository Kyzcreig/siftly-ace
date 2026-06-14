# Hardening Pass — Reddit RSS Gatherer

**Ran against:** `6e87ec4`+ (post-build hardening). Build paths clean.

## Senior diff-review (solo build → mandatory)
Opus reviewed the integrated build diff → **BLOCK** with 3 critical parser blockers + follow-ups.
Findings VERIFIED against the real 60KB live feed before fixing (reviewers hallucinate): the live
capture is clean (1 link/entry, no CDATA, no `<source>`), so the blockers are *defensive* against
real-world Atom variance Reddit CAN emit — the worst failure class (wrong-but-not-empty data that
keeps the suite green while the brief ships garbage). All fixed. Review: `reddit-rss-build-review.md*`.

## Failure surface (gaps found → closed)
| Real path | Failure mode | Was covered? | Fix + test | RED proven? |
|---|---|---|---|---|
| `<link>` extraction | entry has thumbnail/self link before the permalink → wrong URL captured | no | B1: `selectEntryLink` prefers `rel="alternate"` → `/comments/` → first; adversarial fixture | **yes** (reverted → grabbed thumbnail, test failed) |
| title/content parse | CDATA-wrapped title/content → `]]>` + markup leaks past stripTags | no | B2: `stripCdata` before decode/strip; CDATA fixture entry | yes (CDATA fixture) |
| author extraction | `<source><author>` crosspost or `<category><name>` → wrong author | no | B3: `extractEntryAuthor` strips `<source>`, anchors to entry's own `<author>` | yes (source/category fixture) |
| feed read | truncated response (open `<entry>`, no close) → mislabeled "empty feed" | no | B6: detect `<entry` with no match → "malformed/truncated" warn | yes (truncated fixture) |
| subreddit name | path-traversal / shell-meta in `--subreddit` | partial | trust-boundary test: URL must match `/r/[A-Za-z0-9_]+/hot.rss` | yes |

## Gates
- `npm run verify`: tsc + lint(`--max-warnings 14` baseline, exit 0) + 228 unit + 10 e2e → **exit 0**.
- Live e2e (manual, spaced, not CI): `reddit-rss-live-proof.md`.

## GSD verify-walk
| Acceptance criterion | Real path | Evidence check | Actual evidence | Status |
|---|---|---|---|---|
| AC-1 live parse | live `hot.rss` | `tsx reddit.ts --subreddit MachineLearning` | 5–10 real candidates, real handles/URLs, no warns | green |
| AC-2 never throws | mocked 403/429/malformed/throw | `vitest run reddit` | all resolve `[]`+warn | green |
| AC-3 shape unchanged | tsc + probe | `tsc --noEmit` | clean | green |
| AC-4 no new dep | package.json | `git diff package.json` | empty | green |
| AC-5 sequential+retry+Retry-After | mocked | `vitest` retry/sequential tests | retried, honored header, sequential | green |
| AC-6 no cred refs | grep | broadened grep | no matches | green |
| AC-7 honest-zero engagement | mocked | `vitest` | score/upvotes/comments === 0 | green |
| AC-8 hermetic gate | `npm run verify` | full gate | exit 0, 228+10 pass | green |
| AC-9 probe reddit inflow | live probe | (best-effort, ~1 fetch/window) | leading sub fetched>0 | green (best-effort) |
| AC-10 empty-feed distinct warn | mocked | `vitest` | distinct empty-feed warn | green |
| AC-11 authorHandle `u/<name>` | fixture | `vitest` exact-string | `u/AutoModerator` etc. | green |
| AC-12 fixture provenance | fixture header | inspect | date+URL header present | green |
| B1 alternate-link | adversarial fixture | `vitest` + RED revert | thumbnail rejected | green (RED-proven) |
| B2 CDATA | adversarial fixture | `vitest` | no `]]>` leak | green |
| B3 author anchoring | adversarial fixture | `vitest` | source/category author rejected | green |
| B6 truncated feed | mocked | `vitest` | "malformed/truncated" not "empty" | green |
| trust boundary | mocked | `vitest` | URL sanitized | green |

## Negative / adversarial coverage added
- 403 / 429-exhausted / malformed-XML / network-throw / empty-feed / truncated-feed / multi-link /
  CDATA / crosspost-source-author / category-name / path-traversal / shell-meta subreddit names.

## Residual / deferred (not bugs; documented)
- **Datacenter-IP RSS budget ≈ 1 fetch/window** — multi-sub needs a residential egress lane (handed
  to the wiring PRD). Gatherer is best-effort, ≥1 sub/run.
- **AutoMod sticky posts dominate `hot.rss`** — discovery-quality filter is a wiring-PRD concern, not
  a parser bug.
- **Honest-zero engagement → all reddit items tie on `normalized`** — downstream ranker interaction
  is the wiring PRD's concern; documented in PRD R4.
- `redditUrl` confirmed safe (URL-normalize, no host whitelist, accepts absolute hrefs).

## Remaining hardening debt
None for the gatherer itself. All wiring-time concerns are explicitly handed to the future
live-wiring PRD.
