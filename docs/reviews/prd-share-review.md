# prd-share skill PRD — Senior Review

## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None. Blast radius is low and the high-risk paths (public leak, wrong-gist delete, light-mode share) are each addressed at least at design level.

## Required Changes

1. **Prune-before-publish ordering is unsafe (§4.2 steps 8→9).** Deleting the prior gist *before* the new publish succeeds means a `share.sh` failure (gh fail / network) leaves the doc with **no live link and a deleted old one** — strictly worse than a stale link. Reorder: publish new → verify URL → delete old → record state. The risk table (§7) only guards against deleting the *wrong* gist, not against deleting the *only* gist on a failed re-share.

2. **Verdict badge passes inline HTML through a public renderer — confirm the injection path and constrain values (§4.4, P3).** The badge is built from a grepped line out of `SUMMARY.md` ("grep its last verdict line"). If badge HTML is composed from that grep output rather than mapped through a fixed enum→span table, arbitrary doc content lands in the rendered HTML. Require: badge value MUST be validated against the closed P3 enum; never interpolate raw grepped text into the span.

3. **Privacy scan scope is HTML-incomplete (§4.2 step 4).** The scan runs on the source markdown, but the thing published is the *rendered HTML*. Pandoc can surface things the md grep missed (e.g. resolved link targets, embedded raw HTML blocks). Run the secret/IP scan on the **final tmp.html** (the actual gist payload), or scan both. This is the one path that leaks to a public gist, so it deserves the real surface.

4. **H1-strip + h1==1 verify can fight each other (§4.2 steps 5,7).** Step 5 strips the leading `# H1`; step 7 aborts unless `h1 count == 1`. The renderer's banner must therefore reliably emit exactly one `<h1>`. State explicitly *which* h1 the count refers to (banner only, or banner + any surviving body H2-as-H1). A doc with a second top-level `#` mid-body would fail step 7 even though the title strip worked — define behavior (strip only the *leading* H1, expect banner=1, fail loudly if body H1s exist).

## Lens Notes
- **Product:** Solid, well-scoped wrapper; the prune feature is the only genuinely new behavior and it's the riskiest — see Required Change 1.
- **Impl:** Reuses both html-share scripts verbatim (§2 non-goal honored); the obfuscated var names in the wrapped scripts are theirs, not yours — keep prd-share readable.
- **Security:** Gists are public and that's acknowledged (§2, §7), but the scan must cover the rendered payload (RC3) and badge HTML must be enum-constrained (RC2).
- **ConfigDrift:** prd-share hard-depends on `render-pretty-doc.sh`/`share.sh` interfaces (Title arg, `color-scheme: dark`, single URL on stdout) — if html-share changes those, the verify step (§4.2.7) catches dark-mode drift but nothing catches a changed share.sh stdout contract.
- **QA:** Acceptance criteria (§8) are good but missing two: a publish-failure-during-reshare test (proves RC1) and an HTML-level privacy scan test (proves RC3).

## Open Questions
- §4.3: slug = sha256(abs doc path). If a PRD is moved/renamed, the old gist orphans (new slug, no prune). Acceptable, or do you want a `prd-share --forget`/relink path?
- §4.2.9: state records the gist *id* for pruning, but `share.sh` only returns the htmlpreview URL. How is the gist id captured for the delete in step 8 — re-derived from the URL, or a separate `gh gist list` lookup? This is load-bearing for "delete the exact recorded id."
- §4.4: what happens when SUMMARY.md's last verdict line is ambiguous or contains multiple verdict tokens? Default to none, or fail?

## Strengths
- §2 firmly forbids re-rolling CSS and re-uses the solved dark-mode path — correct given the known light-mode pitfall.
- §4.2.7 explicitly verifies `color-scheme: dark` and h1 count before publishing — guards the "silently broken/light-mode share" failure mode.
- §7 keys deletion strictly on sha256(abs path)+recorded id, which is the right defense against deleting the wrong gist.
- Phased plan (§6) ties each phase to a real smoke test including the leak case in Phase 5.