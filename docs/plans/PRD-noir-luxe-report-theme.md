# PRD — Noir Luxe report theme for siftly-ace briefs

**Status:** DRAFT v0.1 · Owner: Apollo · 2026-06-25
**Mockup (source of truth for pixel-perfect):** `sketches/v2-003-noir-luxe/index.html` (published: https://pure-glacier-36j5.here.now/)

## 1. Summary & Goal
Reskin the brief HTML report (`scripts/html_report.ts`) from the current "Refined Cards / dark-Twitter" look to the **Noir Luxe** design Ace picked: deep-charcoal background, single warm-gold accent, large italic Fraunces serif hero + Inter Tight body, generous whitespace, hairline section rules, premium-magazine calm. The report must render BOTH brief shapes (morning-digest multi-source + x-feed X-only) and keep every existing data behavior intact (tweet hydration with full untruncated text/media, story link-cards, overview block with `[[N]](url)` links, unified 3-line footer, translation tag, 300-char story cap). **Visual target: pixel-faithful to the mockup, judged by Argus until it finds zero deviations.**

## 2. Non-Goals
- NOT changing any data/selection/scoring/overview/footer/translation logic — purely the render layer (CSS + HTML structure in `html_report.ts`).
- NOT changing the Discord post format (the one-line link + footer text Apollo posts is unchanged).
- NOT changing `build-report.sh`, `inject_overview.py`, `footer_build.py`, the prompts, or any Python.
- NOT a new framework/build step — stays a single self-contained inline-`<style>` HTML document.
- NOT redesigning the mockup further; the mockup is frozen as the visual contract.

## 3. Constitution / Invariants
- **Invariant: tweet text is never truncated by the reskin.** Long/note tweets still render full body (the `renderItem` "prefer stored full tweet_text over hydrated" logic is untouched).
  - *Closeout proof:* a long-tweet fixture renders its full >280-char body in the Noir output; `npm run verify` green.
- **Invariant: every data element the current report shows still shows.** Avatar, name, verified tick, @handle, full tweet text, inline media (img/video), engagement counts, score badge, "View on X" link, story summary (≤300, translated-if-foreign + tag), source label / stars-today / hn-points, overview prose + `[[N]](url)` links + theme bullets, 3-line footer.
  - *Closeout proof:* element-presence diff of old vs new render on the same `_render_input.json` — no element class/datum dropped.
- **Invariant: per-item fail-safe preserved.** A tweet that won't hydrate still falls back to a link-card; any single item error never blanks the page.
  - *Closeout proof:* feed a bogus tweet id → renders a link-card, page still complete.
- **Invariant: self-contained artifact.** Output is one HTML file, inline `<style>`, only Google Fonts via `<link>` — no JS framework, no build, no external CSS. (doc-share publishes it as-is.)
  - *Closeout proof:* `grep` confirms no `<script src=` framework tags; doc-share publish succeeds.
- **Invariant: both brief shapes render.** morning (X + reddit + github + HN + Perplexity link-cards) and x-feed (all tweet cards) both produce a complete Noir page.
  - *Closeout proof:* build report from a real morning render-input AND a real x-feed render-input; both visually complete.

## 4. Resolved Decisions
- **D-1 — Noir Luxe is the winner** (Ace, 2026-06-25), chosen over Editorial Broadsheet / Terminal / Neo-Brutalist.
- **D-2 — Pixel-perfect gate via Argus.** Apollo builds, renders the live report, and dispatches Argus to compare the live render against the mockup screenshot. Argus is the judge; the loop repeats (Argus finds deviation → Apollo fixes → re-render → Argus re-judges) until Argus reports **zero** pixel/visual deviations. Argus verifies, never edits the code. **Termination:** retry cap of **6 iterations** — if not pixel-clean by then, surface the remaining deviation list to Ace rather than spinning. **Argus scores against an objective rubric, not vibes** (see Phase 3): palette hex, font families/sizes/weights/italic, hairline rules, section-label letter-spacing, whitespace rhythm, gold-accent usage, and element-presence. Each deviation is reported concretely (observed-vs-expected), e.g. "story headline rendered in sans, expected Fraunces ✗".
- **D-3 — Fonts:** Fraunces (display, the italic-300/400 hero + serif headlines) + Inter Tight (body/labels/meta). Loaded via Google Fonts `<link>`, matching the mockup exactly.
- **D-4 — Palette (from mockup CSS, frozen):** `--bg:#0c0c0e`, `--bg2:#141417`, `--fg:#ece8e1`, `--dim:#8a857c`, `--line:#26262b`, `--gold:#c9a25e`, `--goldsoft:rgba(201,162,94,.14)`, hero radial `rgba(201,162,94,.07)`.
- **D-5 — Real tweet cards must be RE-THEMED to Noir, not left as the old card style.** The mockup's "story" rows are the visual target; hydrated tweet cards (avatar/media/engagement) must adopt the Noir palette + type while keeping their richer content. This is the one spot the mockup doesn't fully show (it has no live tweet card), so: tweet cards inherit Noir tokens (charcoal panel, gold accents, Inter Tight, hairline separators), styled to sit seamlessly among the serif story headlines.
- **D-6 — `_render_input.json` contract unchanged.** The reskin only changes how fields render, never which fields are read.

## 5. Architecture / Design
`html_report.ts` has: `renderTweetText`, `mediaHtml`, `tweetCard`, `linkCard`, `badge`, `renderItem`, `ovHtml`, the `STYLE` constant, the `FONT` constant, and the final `body` template. The reskin touches:
- **`FONT`** → Fraunces + Inter Tight `<link>`.
- **`STYLE`** → replace wholesale with the Noir Luxe CSS (ported from the mockup, extended to cover tweet-card + media + badge + overview-links classes the mockup didn't include).
- **`tweetCard` / `linkCard` / `badge` / `ovHtml` / body template** → adjust class names + structure to match the Noir CSS (hero header, eyebrow, hairline `.sec` section labels, serif `.art h2` headlines, gold `.rank`/grade pills, `.more` links). Keep all data wiring (hydration, media, fail-safe, translation tag, 300-cap) byte-for-byte in behavior.
- The header gains the Noir **hero**: eyebrow ("The Morning Digest" / "Your X Feed") + big italic Fraunces line. Map the existing `title` ("Morning Digest — Thursday, June 25") → eyebrow + date; the hero headline is a fixed evocative line per brief (morning: "What moved in *AI* while you slept." / x-feed: "What your feed was *really* saying.").

### Implementation Phases
- **Phase 1 — Port the Noir CSS + fonts into `html_report.ts`.** Replace `FONT` + `STYLE`; add the extra classes (tweet card, media, badge, overview links/bullets) in the Noir idiom.
  - *Unit/script check:* `npm run typecheck` clean; `grep` shows `Fraunces` + `Inter Tight` in FONT, gold `#c9a25e` in STYLE.
  - *E2E:* build report from `/tmp/live-m-render.json` → opens, Noir palette visible.
  - *Verify with:* `bash scripts/build-report.sh /tmp/live-m-render.json "..." /tmp/noir-m.html` → non-empty, dark+gold.
- **Phase 2 — Re-theme tweetCard/linkCard/badge/ovHtml/body to the Noir structure.** Match mockup hero, section labels, serif headlines, gold rank/grade, `.more` links; tweet cards adopt Noir tokens.
  - *Unit/script check:* renderer behavior tests still green (full text preserved, fail-safe link-card, 300-cap, translation tag).
  - *E2E:* build from real morning + real x-feed render-inputs; both complete.
  - *Negative:* bogus tweet id → link-card fallback; foreign summary → translated + tag, still Noir-styled.
  - *Verify with:* `npm run verify` EXIT=0.
- **Phase 3 — Argus pixel-perfection loop.** Render live → Argus judges vs mockup → fix → repeat until Argus PASS (zero deviations).
  - *E2E:* Argus verdict file says PASS / no remaining deviations.
  - *Verify with:* Argus's final report.

### Review fold-in (pass 1 — see `noir-luxe-review-pass1.md`)
APPROVE-WITH-CHANGES; the 6 required changes are now build requirements:
1. **Overview bullets render as a gold-`—` column (mockup `.themes`), NOT pills.** The current CSS styles `.overview li` as flex-wrap chips; Noir must style them as a column. **Critical gotcha:** the bullet text already contains its own `—` (`**Theme** — desc`), so the Noir `.overview li` must NOT add a `::before` dash (double-dash bug). Plain column row, gold `<strong>`.
2. **Hero brief-detection:** `main()` only gets `title`. Detect morning vs x-feed from the title prefix → pick eyebrow ("The Morning Digest" / "Your X Feed") + hero line ("What moved in *AI* while you slept." / "What your feed was *really* saying."). Fallback hero if neither matches.
3. **Tweet-card Noir token map (D-5 made concrete, Argus judges against THIS, not a pixel mockup):** panel `--bg2` + `1px var(--line)`; name Inter-Tight-600 `--fg`; handle/meta/eng `--dim`; verified tick + "View on X" + bird `--gold`; score badge = mockup `.grade` pill (`--bg2`/`--line`/pill-radius/`--dim`); hairline `1px var(--line)` separator above the foot row; media keeps height-cap+cover-crop.
4. **Argus rubric (objective, terminating, ≤6 iters):** per render Argus checks — (a) palette hex matches D-4; (b) Fraunces on hero+headlines, Inter Tight on body/meta; (c) hero is large italic; (d) hairline section rules + `.sec` letter-spacing ≈.34em; (e) gold accent only (no leftover blue/teal from old theme); (f) generous whitespace; (g) **element-presence** (checklist below). Reports observed-vs-expected per item; PASS only when the deviation list is empty.
5. **Element-presence checklist (must all be present in BOTH a morning and an x-feed render):** avatar · name · verified tick · @handle · full tweet text · media(img/video) · likes · replies · score badge · View-on-X · bird · tr-tag (when translated) · ln-title · ln-sum(≤300) · ln-meta(who/src/stars-today/hn-pts) · overview h2 · overview p · overview bullets · footer 3 lines.
6. **No unstyled class:** grep the emit functions (`tweetCard`/`linkCard`/`mediaHtml`/`badge`/`ovHtml`/body) for every `class="X"`; the Noir STYLE must define a rule for each `X` (esp. `.media-wrap.grid`, `.media.video`, `.tr-tag`, `.foot`). Build-time check before Argus.

## 6. Security, Privacy, Ops
- No new surfaces, creds, or network calls (translation path unchanged). doc-share publishes public links exactly as today. Rollback = `git revert` the reskin commit (single render-layer change) or restore `html_report.ts.bak.*-pre-noir`.

## 7. Risks & Mitigations
- **R1: tweet card has no mockup reference** → could drift. *Mitigation:* D-5 + Argus judges the tweet card against the Noir token system (palette/type/spacing consistency), not a pixel mockup it lacks.
- **R2: reskin silently drops a datum** (the real danger of a big STYLE/markup rewrite). *Mitigation:* element-presence invariant + behavior tests + Argus visual check.
- **R3: font load failure → ugly fallback.** *Mitigation:* CSS fallback stack (`"Fraunces",Georgia,serif` / `"Inter Tight",system-ui,sans-serif`).
- **R4: Argus "pixel-perfect" is subjective.** *Mitigation:* give Argus the mockup screenshot + live screenshot + the frozen palette/type/spacing spec; it reports concrete deviations (color hex, font, spacing, missing element), not vibes.

## 8. Acceptance Criteria
- [ ] Live report renders in Noir Luxe (charcoal+gold, Fraunces hero, Inter Tight body) for BOTH briefs. Evidence: two published links, vision-confirmed.
- [ ] Every data element from the current report still present. Evidence: element-presence diff.
- [ ] Long tweet renders full body; bogus tweet → link-card; foreign summary → translated+tagged. Evidence: `npm run verify` green + fixture renders.
- [ ] `npm run verify` EXIT=0 (tsc, eslint 0-err, vitest, py selftests, gold-set 4/4).
- [ ] **Argus judges the live render pixel-perfect vs the mockup and can find no remaining deviations.** Evidence: Argus final verdict = PASS with an empty deviation list, after ≥1 fix iteration.
