# Digest HTML report — design exploration (Phase 1)

**Plan-mode artifact.** 4 divergent design directions for the daily-brief HTML report
(replaces the inline Discord brief with a one-line link → full report page). Built from
TODAY's real morning-digest pool. Sketches are throwaway; the WINNER gets promoted into
`scripts/html_report.ts` (the real builder) and wired into both crons.

## The directions

| # | Stance | Tweets shown as | Aesthetic | Best for |
|---|--------|-----------------|-----------|----------|
| 1 | **Editorial Broadsheet** | italic **pull-quotes** + byline | newspaper, serif (Fraunces/Newsreader), warm paper | least "twitter", most "read like a paper" |
| 2 | **Terminal / Bloomberg** | dense mono rows + tiny thumb | green-on-black monospace, ticker bar | power scanning, info density, dev vibe |
| 3 | **Refined Cards** | polished tweet cards, media **height-capped** | dark + subtle gradient, Sora | familiar tweet feel but elegant; fixes "too big" |
| 4 | **Magazine / Visual** | HERO lead w/ cover image + numbered items | bold editorial-tech, Instrument Serif + Space Grotesk, orange/gold | visual punch, a "lead story" hierarchy |

## Live links
- 1 Editorial Broadsheet — https://dapper-meadow-et9f.here.now/
- 2 Terminal / Bloomberg — https://coral-vow-7fcw.here.now/
- 3 Refined Cards — https://polite-pagoda-hadk.here.now/
- 4 Magazine / Visual — https://lapis-prana-8n8z.here.now/

## Key design decision baked into all of them
**Embedded tweet media is HEIGHT-CAPPED with a cover-crop** (Ace's Image #2 feedback: the
ByteDance tweet's tall GitHub-README screenshot dominated + cut off the text). On X, media
is capped + cropped; variants 3 & 4 do `object-fit:cover; max-height` so a tall screenshot
becomes a tidy banner, text stays primary. Variant 1 caps via `max-height:300px;overflow`.

## My take
- **3 (Refined Cards)** is the safe evolution of what Ace already saw — familiar, fixes the
  size bug, less "literal X". 
- **1 (Editorial Broadsheet)** best answers "it's looking a little too twitter" — tweets
  become quotes in a newspaper, zero tweet-chrome.
- **4 (Magazine)** is the most visually striking / premium, with a real lead-story hierarchy.
- **2 (Terminal)** is the power-user dark horse — densest, most scannable, most "Ace's vibe"
  but the most divergent from a "nice report".

Recommend Ace picks one (or a hybrid, e.g. "Editorial typography + Magazine's hero").

## Open items to resolve regardless of winner
1. **Weak context-less stubs** (Image #1): GitHub/Reddit gatherer items have NO summary
   (`summary=__MISSING__`) — only a repo slug / bare thread title. Fix = enrich GitHub items
   with repo description + Reddit with post selftext at gather time, OR raise the Also-Noted
   gate so context-less C-grade stubs don't qualify. Independent of design.
2. **Per-brief, fresh-slug-daily** delivery (Ace: new link each day is fine). morning + x-feed
   each build their OWN report + post their OWN one-line link.
3. **Fail-safe**: HTML build fails → fall back to the current inline brief.
