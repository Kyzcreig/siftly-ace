# Evidence Pack — Reddit RSS Pivot (ground truth; trust this)

## Live-verified facts (Apollo, this session, from the Mac Studio host)
- Anonymous Reddit `.json` reads → **HTTP 403** on every User-Agent (default, browser, custom) AND
  every egress lane tested (direct WAN, Starlink SOCKS). Datacenter-IP block.
- Reddit `access_token` endpoint → **HTTP 401** (reachable; IP fine for auth, only anon reads blocked).
- Reddit API self-service registration CLOSED (Responsible Builder Policy, Nov 2025). Ace hit the
  `prefs/apps` create-form rejection (policy link) directly; personal "script" apps do not qualify.
- **`https://www.reddit.com/r/MachineLearning/hot.rss?limit=25` → HTTP 200, 60 KB Atom, 25 entries
  parsed clean** (title, link href, author /u/<name>, published ISO8601). Reproduced after a pause.
- Back-to-back RSS probes → **429** (Reddit per-IP rate-limits RSS hard). A single spaced request →
  200 every time. Implication: daily cron over a few subs with delay is fine; parallel hammering is not.
- Atom entry shape (real): `<entry><title>…</title><link href="https://www.reddit.com/r/…/comments/…"/>
  <author><name>/u/<name></name></author><content type="html">…</content><published>…</published></entry>`
- Atom carries NO score/upvotes/comment-count. (JSON did; RSS does not.)

## Current code (the real paths under change)
- `scripts/gather/reddit.ts` — `gatherRedditPosts({subreddits,limit,fetchImpl?,logger?})`. Currently:
  JSON fetch of `/r/<sub>/hot.json`, `parsePost` reads JSON `data.{title,url,score,ups,num_comments,
  author,created_utc,selftext}`, plus a (now-useless) app-only OAuth token layer + 3 OAuth tests +
  `__resetRedditTokenCacheForTests`. Returns `RedditCandidate[]`, never throws (warn + [] on failure).
- `RedditCandidate` = { title, url, summary, source:'reddit', authorHandle, engagement_raw{score,
  upvotes,comments,normalized}, created_at }.
- `scripts/gather/github-trending.ts` — HEALTHY (HTTP 200, ~14 net-new/run). Parses HTML via REGEX +
  a local `decodeHtmlEntities`/`stripTags` (NO xml/html dep). Sets the house parsing style.
- `package.json` — NO xml/rss parser dependency installed (confirmed).
- `scripts/gatherer_probe.ts` — consumes `gatherRedditPosts` + `gatherGitHubTrending`, classifies
  net-new vs overlap, writes artifact. NOT wired into any live brief prompt (grep-confirmed).
- `scripts/with-secrets.sh` + `.env.example` — currently contain a Reddit cred block (from the dead
  OAuth attempt) to be removed.
- Verify gate: `npm run verify` = tsc + lint + unit (vitest) + e2e. Baseline before this work: 224 TS
  pass / 8 skip, 42 py pass, 10 e2e pass, exit 0.

## Constraints
- Gatherer must NEVER throw into a caller (morning brief is load-bearing).
- No new runtime dependency (parse Atom with regex, matching github-trending.ts).
- Output `RedditCandidate` shape must stay byte-identical (probe + dedup consume it).
- Engagement must be honest (RSS has no metrics → 0 / neutral, NOT fabricated).
- Polite to Reddit: sequential + delay + bounded 429 retry + per-run request cap.
- Reddit gatherer is NOT wired into a live brief → zero blast radius; this PRD does not wire it.
