# PRD — `prd-share` skill

**Version:** v2 (review APPROVE WITH CHANGES applied: publish-before-prune, HTML-level scan, enum-constrained badge, h1 rule, OQs resolved)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo
**Type:** Hermes skill (wraps `html-share`)
**Location:** `~/.hermes/skills/software-development/prd-share/`

---

## 1. Summary & Goal

A thin, opinionated wrapper around the existing `html-share` skill that encodes "how Apollo ships a PRD/spec/plan for Ace to review." Today, sharing a PRD as a gist is a multi-step manual dance (strip the leading H1, render, publish, remember to prune the old gist). `prd-share` makes it one command that produces a consistently-branded, dark-mode, review-aware shareable link — and stops stale links from piling up.

**Goal:** `prd-share <doc.md>` → returns one htmlpreview URL with a standard PRD header banner (title, version, status, owner, review verdict), dark mode, sidebar TOC, and automatic pruning of the previous version's gist for the same doc.

**Why now:** Ace explicitly asked for it after the Siftly PRD share. It's a repeatable pattern we'll use for every future spec.

---

## 2. Non-Goals

- **No new rendering engine.** Reuse `html-share`'s `render-pretty-doc.sh` + `share.sh` verbatim. Do not hand-roll CSS (the dark-mode pitfall is already solved there).
- **No private hosting.** Gists are public (inherits `html-share`'s constraint). PRDs shared this way must contain no secrets/private hostnames — same rule as `html-share`.
- **No PRD authoring/templating of content.** It shares an existing doc; it does not write the PRD.
- **Not a replacement for `html-share`.** General HTML sharing still uses `html-share` directly. `prd-share` is the PRD-specific path.
- **No multi-file docs.** One markdown file in → one gist out (inherits gist one-file limit).

---

## 3. Resolved Decisions

| # | Decision | Value |
|---|---|---|
| P1 | Build-vs-buy | Wrap `html-share`; do not reimplement rendering/publishing. |
| P2 | Metadata source | Parse from the PRD's own header block (Version/Date/Author/Owner/Status lines) — no duplicate entry. Override via flags. |
| P3 | Review verdict badge | Optional. Pulled from a `--verdict` flag OR auto-detected from a sibling `docs/reviews/SUMMARY.md` if present. Values: APPROVED / APPROVE WITH CHANGES / BLOCK / DRAFT / IN REVIEW. |
| P4 | Stale-gist pruning | Track shared PRDs in a small state file keyed by doc identity (stable slug). On re-share, delete the prior gist for that slug, then publish the new one. |
| P5 | Leading H1 | Auto-strip the leading `# Title` line (renderer injects the banner; a source H1 would duplicate it). |
| P6 | Output | One line: the htmlpreview URL (same contract as `html-share`'s `share.sh`). |
| P7 | Privacy guard | Pre-publish scan for obvious secrets/private hostnames; warn + require `--force` if found. |

---

## 4. Design

### 4.1 Invocation

```bash
prd-share <doc.md> [--title "..."] [--verdict APPROVED] [--status "..."] [--no-prune] [--force]
```

- `<doc.md>` — path to the PRD/spec markdown.
- `--title` — override; default = parsed from doc's `# H1` or first `**Title:**`-style line, else filename.
- `--verdict` — override the review badge; default = auto-detect (P3) or none.
- `--status` — override; default = parsed from a `**Status:**` line.
- `--no-prune` — keep the prior gist (default: prune it).
- `--force` — publish even if the privacy scan flags something.

Implemented as a script in the skill: `scripts/prd-share.sh` (bash, consistent with `html-share`'s script style).

### 4.2 Pipeline

```
1. Resolve doc path; read it.
2. Parse metadata: title, version, date, author, owner, status (from header lines).
3. Resolve verdict: --verdict flag → else sibling docs/reviews/SUMMARY.md scan → else none.
   The resolved value MUST be mapped through the fixed P3 enum→span table; raw grepped
   text is NEVER interpolated into the badge HTML (RC2).
4. Build a temp markdown:
   - strip ONLY the leading `# ...` H1 (P5). Body-level `#` H1s are left alone but flagged.
   - prepend a standard metadata block the renderer surfaces as the banner subtitle:
       **Version:** ... | **Status:** ... | **Verdict:** <badge> | **Owner:** ... | <date>
5. Render: html-share/render-pretty-doc.sh <tmp.md> <tmp.html> "<title>"
6. Verify dark mode landed: grep -c "color-scheme: dark" >= 1. h1 count: expect exactly 1
   (the banner). If >1, a body H1 survived — abort loudly and tell the user to demote it to `##`.
7. **Privacy scan on the RENDERED `tmp.html`** (the actual gist payload — RC3), not just the
   source md: grep for secret-ish patterns (API keys, tokens, private IPs 10./192.168./
   100.64-127., 1Password refs, .env). Optionally scan the source md too. If hit and not
   --force: print findings, exit non-zero (nothing published).
8. **Publish FIRST: html-share/share.sh <tmp.html> "prd-share: <title> <version>"**.
   Capture the htmlpreview URL; derive the gist id from it (see §4.3). Verify the URL is
   non-empty. If publish fails → exit non-zero, leave any prior gist UNTOUCHED (RC1).
9. **Prune AFTER successful publish:** if state has a prior gist id for this doc slug and
   not --no-prune → `gh gist delete <prior_id> --yes`. (New link is already live, so a
   prune failure is non-fatal — log it.)
10. Record new gist id + url + timestamp + version in state, keyed by doc slug.
11. Print the htmlpreview URL (only line on stdout).
```

### 4.3 Doc identity / slug + gist-id capture (P4)

Stale-pruning needs a stable key so re-sharing the *same* PRD replaces its gist, but a *different* PRD doesn't. Slug = sha256 of the sanitized absolute doc path (path is stable across versions; the file is edited in place).

**Gist-id capture (resolves OQ2):** `share.sh` returns only the htmlpreview URL, which embeds the gist id in the form `.../gist.githubusercontent.com/<user>/<gist_id>/raw/...`. The wrapper parses `<gist_id>` from that URL with a fixed regex — no separate `gh gist list` lookup needed. State stores that id for the exact-id delete.

**Moved/renamed doc (resolves OQ1):** if a PRD is moved, its slug changes, so the old gist orphans (no auto-prune). Acceptable for v1. A `prd-share --forget <doc.md>` subcommand (deletes the recorded gist + state entry) is a documented future add, not v1 scope.

State file: `~/.hermes/state/prd-share/shared.json`:

```json
{
  "<sha256(abs_doc_path)>": {
    "doc_path": "/Users/.../PRD-ace-x-knowledge-base.md",
    "title": "Ace X Knowledge Base — PRD",
    "gist_id": "b8612103...",
    "url": "https://htmlpreview.github.io/?...",
    "shared_at": "2026-06-07T...",
    "version": "v5"
  }
}
```

### 4.4 Verdict badge (P3)

Rendered as a colored span in the banner subtitle (the renderer passes inline HTML through):
- APPROVED → green
- APPROVE WITH CHANGES → amber
- BLOCK → red
- DRAFT / IN REVIEW → grey

Auto-detect: if `<doc_dir>/../reviews/SUMMARY.md` or `<doc_dir>/reviews/SUMMARY.md` exists, grep its last verdict line (e.g. `APPROVED to build`, `APPROVE WITH CHANGES`, `BLOCK`). **Ambiguity rule (resolves OQ3):** match against the closed enum, longest-token-first (so "APPROVE WITH CHANGES" wins over "APPROVE"). If the line contains multiple distinct verdict tokens or none match cleanly → default to **no badge** (never guess). The value is always mapped through the fixed enum→span table (RC2); raw text never reaches the HTML.

---

## 5. SKILL.md contents

Frontmatter + body covering: when to use (sharing a PRD/spec/plan for Ace review), the one-command usage, the metadata-parsing rules, the prune behavior, the privacy guard, and an explicit "this wraps html-share — never hand-roll CSS" pointer. Includes a worked example.

---

## 6. Implementation Phases

- **Phase 0 — Scaffold.** Create skill dir, SKILL.md skeleton, `scripts/prd-share.sh` stub. Smoke: `skill_view` loads it.
- **Phase 1 — Metadata parse + H1 strip + temp-md build.** Smoke: run on the Siftly PRD, verify banner block has version/status/owner, no duplicate H1.
- **Phase 2 — Render + verify + publish via html-share.** Smoke: produces a working htmlpreview URL, dark mode confirmed.
- **Phase 3 — Verdict badge (flag + auto-detect).** Smoke: `--verdict APPROVED` shows green badge; auto-detect from SUMMARY.md works.
- **Phase 4 — State + stale-gist prune.** Smoke: share twice, confirm the first gist is deleted and state updated.
- **Phase 5 — Privacy scan.** Smoke: a doc with a fake `192.168.x` + token → blocked without `--force`, allowed with.
- **Phase 6 — SKILL.md finalize + real end-to-end** on the Siftly PRD.

Each phase: real smoke test, then commit.

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Metadata parse misses non-standard header formats | Banner incomplete | Fall back to filename/flags; never crash |
| Privacy scan false-negative leaks a secret to a public gist | High | Conservative patterns; `--force` required to override a hit; document that gists are public |
| Prune deletes the wrong gist | Medium | Key strictly on sha256(abs path); only delete the id recorded in state for that exact slug |
| `gh` not authed | Can't publish | Inherit html-share's failure; surface gh error clearly |
| Renderer regression (light mode) | Ugly share | Phase 2 verify-step aborts if `color-scheme: dark` missing |

---

## 8. Acceptance Criteria

- [ ] `prd-share <doc.md>` returns one working htmlpreview URL, dark mode, single H1 (banner only).
- [ ] Banner shows version/status/owner/date parsed from the doc.
- [ ] `--verdict` flag and SUMMARY.md auto-detect both render the correct colored badge.
- [ ] Re-sharing the same doc prunes the prior gist (verified deleted) and updates state.
- [ ] Sharing a different doc does NOT prune the first.
- [ ] Privacy scan blocks a doc with secrets/private IPs unless `--force`.
- [ ] `--no-prune` keeps the old gist.
- [ ] SKILL.md is loadable and documents usage + the html-share dependency.
- [ ] **Publish-failure-during-reshare:** if `share.sh` fails on a re-share, the prior gist is left intact (no orphaned doc) — RC1.
- [ ] **HTML-level privacy scan:** the scan runs on the rendered tmp.html and catches a secret that only appears post-render — RC3.
- [ ] End-to-end smoke on the real Siftly PRD passes.
