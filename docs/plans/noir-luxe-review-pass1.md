# PRD Review — Noir Luxe report theme (pass 1)

**Reviewer:** Apollo (self, Opus-equivalent critical pass — delegate sub-agent harness was non-executing)
**Verdict: APPROVE-WITH-CHANGES** — sound scope, but 6 concrete gaps must be folded into the PRD before build, or the Argus loop will thrash on under-specified surfaces.

## Required changes (fold into PRD before build)

1. **Overview bullets ≠ mockup pills — define the mapping (data-loss-adjacent).** The live overview prose is `• **Theme** — desc` lines; `ovHtml` wraps each in `<ul><li>`, and the CURRENT CSS styles `.overview li` as flex-wrap **pill chips**. The Noir mockup renders themes as a **flex-column with a gold `—` prefix** (`.themes div::before{content:"—"}`), NOT pills. Required: the Noir `.overview ul/li` must match the mockup's `.themes` column style. **Gotcha:** the bullet TEXT already contains its own `—` (`**Theme** — desc`), so the Noir `.overview li` must NOT add a `::before` dash (would double it). Style as a plain column row, gold `<strong>`.

2. **Hero needs brief detection.** The Noir hero is a fixed evocative line per brief, but `main()` only receives `title` ("Morning Digest — …" vs "X Feed Brief — …"). Required: detect morning-vs-x-feed from the title prefix, pick eyebrow ("The Morning Digest" / "Your X Feed") + hero line accordingly. Add a fallback hero line if the title matches neither.

3. **Tweet card has no mockup → spec the Noir token mapping explicitly (D-5 tighten).** The mockup has no live tweet card/avatar/media/engagement. Required: enumerate exactly how each tweet element adopts Noir — panel `var(--bg2)` + `1px var(--line)` border, name in Fraunces or Inter-Tight-600 `--fg`, handle/meta `--dim`, verified tick + "View on X" + bird in `--gold`, score badge = the mockup's `.grade` pill style, hairline separator above the footer row. Argus judges the tweet card against THIS token list (not a pixel mockup it lacks).

4. **Argus loop needs a termination bound + an objective rubric (or it loops/rubber-stamps).** Required additions to D-2/Phase-3: (a) a **retry cap (≤6 iterations)** — if not pixel-clean by then, surface the remaining deviations to Ace rather than spinning; (b) an explicit **deviation rubric** Argus scores against: palette hex match, font families (Fraunces display / Inter Tight body), hero size/weight/italic, hairline rules, section-label letter-spacing, whitespace rhythm, gold-accent usage, and **element-presence** (nothing dropped). Argus reports each deviation concretely (e.g. "`--gold` rendered #c9a25e ✓; section label letter-spacing .34em vs mockup .34em ✓; story headline using sans not Fraunces ✗"), never a vibe verdict.

5. **Element-presence diff must be a real, listed checklist, not prose.** Required: the closeout/Argus check enumerates the exact set — avatar, name, verified, handle, full tweet text, media(img/video), likes, replies, score badge, View-on-X, bird, tr-tag, ln-title, ln-sum (≤300), ln-meta(who/src/stars-today/hn-pts), overview h2+p+li, footer 3 lines. Argus confirms each is present in both a morning and an x-feed render.

6. **Keep the load-bearing CSS-class contract.** The data functions emit specific classes the behavior depends on — `.media-wrap.grid` (multi-image), `.media.video`, `.tr-tag`, footer `<br>` lines. Required invariant: the Noir STYLE must define styling for EVERY class the (unchanged) emit functions produce, or those elements render unstyled. Build step: grep the emit functions for `class="X"` and confirm each `X` has a Noir rule.

## Non-blocking notes
- Mockup `.more` ("Read →") link is decorative; the link-card's headline is already the link. Adding `.more` is optional, not a data element — don't let Argus flag its absence as a deviation.
- The radial gold hero glow (`rgba(201,162,94,.07)`) + `--goldsoft` link underline must port exactly; they're the "luxe" signal.

No blockers. With 1–6 folded in, the build + Argus loop is well-defined and terminating.
