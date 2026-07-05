# Independent Senior Review (Opus)

## Verdict: BLOCK

## Critical Blockers (severity-ordered, cite section/evidence)

1. **The default flip (Phase 1) is NOT gated on the OQ4 exposure decision (Phase 0) — this directly violates INV-3.** §6 explicitly ships Phase 1 as independent ("shippable in order," Phase 2 gated on Phase 0, Phase 1 not). But INV-3 says "must not land durable PRDs there until OQ4 is resolved." The moment `doc-share` defaults to `docs-ace` (D-1), *every future ad-hoc PRD/report share Ace does* lands on the no-login, LAN-readable portal — continuously and unattended. That is a strictly larger exposure surface than the one-time curated backfill you *did* gate. You gated the small, human-reviewed set and left the continuous firehose ungated. Phase 1 must be gated on Phase 0, or scoped to non-sensitive output until OQ4 returns "accept."

2. **The auto-fallback escalates exposure in the wrong direction, silently, with no alert (5A, AC line 2).** If docs-ace is down, a publish *intended for a LAN-private target* silently falls back to **here.now — a public internet service**. privacy-scan runs before the backend (INV-2) but its threat model is IPs/secrets, not "this PRD is internal-only." So a doc that was fine for LAN-only egresses to a public host on any docs-ace flake. Worse, here.now purges on a ~5-day window (§2), so "durable" docs silently *vanish* while Ace believes they're archived in docs.ace. There is no alert-on-fallback anywhere (§7 says "no new monitoring needed" — wrong; 5A creates a new silent failure mode). Fallback from a private to a public target is a security regression, and the durable-doc-loss is a data-integrity regression.

3. **INV-2 gives false assurance: privacy-scan's threat model does not cover PRD content.** The scan blocks `.ace`/RFC-1918/tailscale IPs and literal secrets. A PRD archive is full of sensitive material that is *none of those*: 1Password item UUIDs (the parent AGENTS.md carries `n32tdp5kpvb7i4pga2thzatqwy`, `77x7lxny2xabgkuupkhkthttsy`), internal architecture, project/host names, credential *references*. "Passes the scan" ≠ "safe to expose on a no-login LAN portal." INV-2's closeout proof (fake secret → blocked) tests the scan *runs*, not that the archived content is actually safe — a proxy gate, not the real acceptance gate for the exposure risk the PRD itself flags as load-bearing (§7).

## Required Changes

- **Gate Phase 1 on Phase 0** (or split: default→docs-ace only for `type∈{report,overview}` non-sensitive until OQ4=accept; PRDs keep here.now default until the Caddy bind is decided). Reconcile §6 Phase-1 independence with INV-3.
- **Fix the fallback semantics:** on docs-ace failure, either (a) hard-fail loudly (no silent public egress) or (b) fall back only after re-running privacy-scan *with here.now's public threat model*, AND fire a #alerts notification every time fallback fires. Make "fallback occurred" observable — add it to AC and to the canary.
- **Strengthen the exposure gate beyond privacy-scan** for backfill: a content-sensitivity pass (host/1P-ID/arch-mention heuristics) or an explicit per-doc human ack in the manifest. Don't let INV-2 stand in for the OQ4 decision.
- **Pin D-4's doc_identity_key to a single deterministic rule** — the `relpath-OR-title-slug` "e.g." is a dup-card generator (same doc, two keys → two slugs, violating INV-4). Also pin the D-11 `salt` source and address rename/move → key-change → orphan card.
- **Widen the collision check (R4)** beyond "within the manifest" — the default-flip publish path and the backfill path write the same identity-key space; only one side is checked.
- **Version-control `ace_publisher.py` / `backfill.py`** or state the backup contract — they live in `~/.hermes/var/` (runtime dir), out of the repo, and `docs-ace.sh` "mirrors" here-now.sh (drift risk). State the doc-share.sh pre-edit backup per house discipline.

## Lens Notes (one line each)
- **Architecture:** Two-copy backend "mirroring here-now.sh" + logic in `var/` invites contract drift; extract a shared publish contract or lint parity.
- **Security/identity-isolation:** Load-bearing risk (LAN no-login archive of all PRDs) is correctly named but under-defended — scan ≠ exposure gate, and fallback punches a hole to the public internet.
- **DevOps/SRE:** No rollback contract for the *flip itself* (only backfill is reversible); host-down simulation for the fallback E2E is unspecified; "no new monitoring" is false given the new silent-fallback mode.
- **Implementation/maintainability:** MD→HTML reuse is sound, but 40 PRDs with mermaid/internal-links/images are untested — E2E only samples 3-5.
- **QA:** The privacy-block and fallback tests are proxy gates (proves the scan/fallback *runs*, not that content is safe / loss-visible) — not real acceptance gates for the stated top risk.
- **Config-drift:** Runtime `var/` scripts + mirrored backend + unpinned salt/identity-key are three independent drift vectors.

## Residual Risks / Open Questions
- OQ4 is framed as gating only "sensitive backfill," but the default flip makes *all future* durable shares sensitive-by-default on the same portal — is the true decision "should docs.ace ever be the default while it's LAN-no-login"?
- OQ5 scope (40 vs 199) interacts with R2 (index flood) *and* with blocker 3 (more docs = more un-scanned exposure) — settle exposure before scope.
- If Ace shares a PRD ad-hoc *today* (post-flip, pre-OQ4), where does it go? The PRD has no answer — that's the gap blocker 1 closes.
- What happens to slug stability when a backfilled PRD is later re-shared via the live default-flip path with a different derived key? Two cards, no reconciliation described.