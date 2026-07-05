# PRD — doc-share → docs.ace default flip + durable-doc backfill (v1.2)

**Status:** DRAFT v1.2 (Pass-1 BLOCK folded; for Pass-2 review). **Owner:** Apollo. **Date:** 2026-07-05
**Parent PRD:** `PRD-docs-ace-local-hosting.md` (v1.3 APPROVED) — its deferred **v1.1 / Phase 6**.
**Trigger met:** docs.ace v1.0 stable; Ace asked to "backfill docs.ace with all our previous docs" +
confirmed "keep here.now as an option in doc-share, default → docs.ace portal."
**Review:** Pass-1 Opus = **BLOCK** (3 blockers, all folded below → §Changelog).

## 1. Summary & Goal
Make **docs.ace the default publish target for `doc-share`** (keeping here.now + gist as explicit
opt-in backends) and **backfill a curated set of durable local docs** into docs.ace so it becomes the
canonical "everything we made, in one place" archive. Every *new* durable doc then lands in docs.ace
natively — **subject to the exposure gate (§3 INV-3 / Phase 0), because the flip makes all future
ad-hoc shares LAN-public-by-default, which is a larger surface than the one-time backfill.**

## 2. Non-Goals
- **NOT** backfilling here.now's 200 transient publishes (daily-brief re-publishes, one-off review
  shares, test pages) — churn, not durable docs. (here.now's API retains only a ~5-day rolling window;
  no deep archive exists to recover.)
- **NOT** removing here.now/gist from doc-share — they stay as `--backend here-now|gist` (Ace's ask).
  Only the *default* changes, and only after Phase 0.
- **NOT** auto-importing all ~230 candidate docs — backfill is a **curated, per-doc-acked allow-list**.
- **NOT** changing docs.ace's auth *model* in this cut — but Phase 0 MAY change its network *binding*
  (Caddy LAN→tailnet) as the resolution of OQ4.

## 3. Constitution / Invariants
- **INV-1 (backends retained, default opt-out-able):** default backend becomes `docs-ace`, but every
  caller still reaches here.now/gist via `--backend` / `DOC_SHARE_BACKEND`. *Closeout proof:* both
  still publish to old targets; grep shows no regression in caller wiring.
- **INV-2 (secret gate runs on every path — but is NOT the exposure gate):** `privacy-scan.sh` runs
  before every backend incl. docs-ace. *This blocks literal secrets/RFC-1918/tailscale/.ace IPs only —
  it is explicitly NOT sufficient to declare content safe for a no-login LAN archive* (see INV-3b).
  *Closeout proof:* fake secret → blocked on docs-ace path.
- **INV-3 (exposure posture decided BEFORE the flip AND the backfill):** docs.ace binds
  `192.168.1.18` (LAN) with no per-node auth → readable by **any LAN host**. Neither the default flip
  (Phase 1) NOR sensitive backfill (Phase 2) lands until OQ4 (§9) returns a decision. *Closeout proof:*
  OQ4 decision recorded; Phase 1 default-flip does not merge before it.
- **INV-3b (content-sensitivity gate, distinct from the secret scan):** a durable doc reaches docs.ace
  ONLY after a **content-sensitivity check** that the literal-secret scan can't do — a heuristic pass
  (internal host/domain names, 1Password item UUIDs, credential *references*, private architecture) +
  an **explicit per-doc human ack** in the backfill manifest (and, for the live flip, a documented
  sensitivity default per `type`). *Closeout proof:* a PRD carrying a 1P item UUID (e.g. the parent
  AGENTS.md style `xxxx…`) is flagged by the sensitivity pass, not waved through by privacy-scan.
- **INV-4 (fallback never escalates exposure, never loses data, never silent):** on docs-ace publish
  failure, doc-share does **NOT** silently fall back to public here.now. It either (a) **hard-fails
  loudly** (default), or (b) falls back only if the caller explicitly allowed a public target for that
  doc AND re-runs the scan with here.now's *public* threat model — and **every fallback fires a
  #alerts notification**. *Closeout proof:* host-down + no opt-in → loud fail, no here.now publish, no
  silent data loss; host-down + opt-in → here.now URL + a #alerts line.
- **INV-5 (idempotent, single-key, collision-checked across BOTH paths):** a doc's docs.ace slug is
  `words(hash(doc_identity_key||salt))` where `doc_identity_key` follows **ONE** deterministic rule
  (D-4) — the backfill path and the live-flip path share the same key space and the collision check
  spans both. Re-publishing the same source updates in place; never a dup card. *Closeout proof:* run
  backfill twice → identical slugs; publish the same doc via the live flip → same slug as its backfill.
- **INV-6 (backfill reversible, in-docroot):** every backfilled doc is soft-deletable via
  `/api/doc/delete`; no write outside docroot. *Closeout proof:* delete → 404 + neighbor serves.

## 4. Resolved Decisions
- **D-1:** Default `doc-share` backend → `docs-ace`; here.now + gist stay as `--backend` opts (Ace).
  **Gated on Phase 0** (INV-3).
- **D-2:** Backfill = curated allow-list with a **per-doc human ack** column, human-approved before it
  runs. NOT auto-sweep.
- **D-3:** Backfill source = local durable artifacts (siftly PRDs, reports, Obsidian overviews) via
  `ace_publisher.py`. NOT here.now scraping.
- **D-4 (pinned, single rule):** `doc_identity_key = "docshare|" + sha1(canonical_source_path)[:12]`
  where `canonical_source_path` is the repo-relative path for repo docs / vault-relative for Obsidian.
  Title/relpath "e.g." from v1.1 is **removed** — one rule only, so the same source always maps to one
  slug. A **rename/move changes the key → orphans the old card**; the importer emits a
  `renamed_from→to` note so the stale card can be deleted (INV-6). `salt` = the existing docs.ace salt
  in `~/.hermes/var/docs-portal/` (same D-11 salt the briefs use; pinned, not per-run).
- **D-5:** `type` taxonomy: `prd` / `report` / `overview` / `doc`. **Default sensitivity per type:**
  `prd` = sensitive (never auto-flips to docs-ace pre-OQ4); `report`/`overview` = per-doc ack; briefs
  keep `briefs`.
- **D-6 (fallback default):** hard-fail-loud is the default (INV-4a); public fallback is opt-in per
  publish (`--allow-public-fallback`), never automatic.

## 5. Architecture / Design

**5A. doc-share `docs-ace` backend + gated default flip.**
- New `scripts/backends/docs-ace.sh`: rendered HTML + title + derived doc-id → `ace_publisher.py`,
  prints `https://<slug>.docs.ace/` on stdout, non-zero on fail. **To avoid the two-copy drift the
  reviewer flagged:** factor the shared publish contract (arg parsing, scan invocation, URL echo) so
  `docs-ace.sh` and `here-now.sh` don't diverge — or add a parity lint asserting both expose the same
  flags. Pre-edit backup of `doc-share.sh` per house discipline (`.bak-<ts>-pre-docsace-default`).
- Default flip: `here-now` → `docs-ace`, **only for types whose default sensitivity permits it
  pre-OQ4** (D-5). Until OQ4=accept (or the Caddy re-bind lands), `prd`-type shares keep here.now
  default; `report`/`overview` default to docs-ace with the per-doc ack. Post-OQ4=accept (or
  tailnet-restricted), everything defaults to docs-ace.
- Fallback: INV-4 — hard-fail-loud default; `--allow-public-fallback` re-scans (public threat model)
  + fires #alerts; **NO silent private→public egress, NO silent durable-doc loss.**

**5B. Curated backfill importer.**
- `~/.hermes/var/docs-portal/backfill.py` (+ committed copy in `deploy/docs-ace/`, so it's not a
  single-copy-on-disk runtime script — reviewer point): takes an **allow-list manifest** (JSON:
  `[{path, type, title, doc_id, acked_by, sensitivity}]`), renders MD→HTML (reuse
  `render-pretty-doc.sh`), runs the **INV-3b sensitivity pass** per doc, calls `ace_publisher.py`,
  reports slugs. **Idempotent, dry-run default, cross-path collision check.**
- Manifest generation (Phase 2): a helper scans candidate dirs, emits a *proposed* manifest with a
  one-line summary + a **sensitivity flag** per doc → Ace acks/trims → importer runs only acked rows.

## 6. Implementation Phases

- **Phase 0 — OQ4 exposure decision (HARD PRECONDITION for BOTH Phase 1 flip AND Phase 2).**
  Ground-truthed: Caddy binds `192.168.1.18` (LAN), no per-node auth. Present Ace the options (§9 OQ4).
  *Verify with:* recorded decision. **The default flip and any sensitive backfill BLOCK until this
  returns.** If "restrict to tailnet," the Caddy re-bind is part of Phase 0 and is itself verified
  (docs.ace reachable from a tailnet node, refused from a non-tailnet LAN host).

- **Phase 1 — docs-ace backend + gated default flip (5A).** *Gated on Phase 0 (blocker 1 fix).*
  - *Unit/script:* `doc-share.sh --backend docs-ace <md>` → `*.docs.ace` URL; doc appears + FTS-searchable.
  - *E2E:* three-backend matrix (default→per-D-5, `--backend here-now`→here.now, `--backend gist`→gist);
    **host-down → loud fail (no here.now) by default; `--allow-public-fallback` → here.now URL + a real
    #alerts line** (INV-4).
  - *Negative:* fake secret → privacy-scan blocks on docs-ace path; a `prd`-type share pre-OQ4=accept
    → stays here.now (does NOT silently land on the LAN portal); `--backend bogus` → clean error.
  - *Verify with:* the matrix + the fallback-alert capture + the pre-OQ4 prd-routing check.

- **Phase 2 — curated backfill (5B), gated on Phase 0.**
  - *Unit/script:* `backfill.py --manifest <acked.json> --dry-run` lists intended publishes; real run
    publishes; re-run → same slugs, no dup cards (INV-5); cross-path collision check passes.
  - *E2E:* backfill 3-5 real durable docs **including one with mermaid/internal-links/an image** (not
    only plain PRDs — reviewer point) → each renders at its slug + body-searchable + right `type`.
  - *Negative:* a manifest doc carrying a 1P item UUID / internal host → flagged by the INV-3b
    sensitivity pass (NOT waved through by privacy-scan); delete a backfilled doc → 404 + neighbor serves.
  - *Verify with:* dry-run + live render of the set + idempotency re-run + the sensitivity-flag catch.

## 7. Security, Privacy, Ops
- **Load-bearing gate = Phase 0 (OQ4).** LAN-readable no-login archive of PRDs is materially more
  sensitive than two daily briefs. Resolve exposure before the flip AND the backfill.
- **Two distinct gates, not one:** INV-2 secret scan (literal secrets/IPs) + INV-3b content-sensitivity
  (host names, 1P UUIDs, cred refs, architecture) + per-doc human ack. Neither alone is sufficient.
- **New failure mode acknowledged (reviewer point):** the flip creates a docs-ace-down path. It
  **hard-fails loud** by default (no silent public egress, no durable loss); public fallback is opt-in
  and **alerts on every fire**. The docs.ace canary gains a **"fallback-fired" signal**.
- Backfill reversible (soft-delete) + idempotent + dry-run default. Scripts committed to
  `deploy/docs-ace/` (not single-copy runtime).

## 8. Risks & Mitigations
- **R1: default flip breaks a here.now-expecting caller.** → INV-1 + three-backend E2E + retained flags.
- **R2: continuous ad-hoc PRD shares silently go LAN-public post-flip (the real top risk).** → INV-3
  (gated on Phase 0) + D-5 per-type sensitivity default (prd stays here.now pre-OQ4=accept).
- **R3: fallback egresses LAN-private content to public here.now / loses durable docs.** → INV-4
  hard-fail-loud default + opt-in-public-with-alert.
- **R4: backfill floods the clean index.** → D-2 curated, per-doc-acked, dry-run default.
- **R5: doc_identity_key collisions / dup cards across the two write paths.** → D-4 single rule +
  INV-5 cross-path collision check.
- **R6: MD→HTML fails on rich PRDs (mermaid/images/links).** → Phase-2 E2E includes a rich doc.

## 9. Open Questions
- **OQ4 (load-bearing, Phase 0) — 1-3-1 for Ace:**
  - *Problem:* docs.ace is LAN-readable, no login. Making it the default share target + a full-text PRD
    archive exposes all internal PRDs to any device on the home LAN.
  - *Options:* **(a) Accept LAN-readable** — simplest, but every PRD is readable by any LAN guest/IoT
    device. **(b) Restrict Caddy bind to Ace's tailnet IP** — only Ace's own tailnet nodes reach
    docs.ace; LAN devices get refused; robust, ~one Caddy edit + AGH/routing check (recommended).
    **(c) Add a light auth gate** (basic-auth / a shared cookie) — most work, defends even a
    compromised tailnet node, likely overkill for a personal homelab.
  - *Recommendation:* **(b) tailnet-restrict** — matches "private, yours," keeps no-login convenience
    for Ace's devices, closes the LAN-guest hole, and is cheap. Then default-flip everything safely.
- **OQ5:** backfill scope — PRDs+reports (~40) first, or also Obsidian overviews (~199)? Recommend:
  start PRDs+reports, add overviews only if the portal proves useful. (Interacts with R4 + exposure.)

## 10. Acceptance Criteria
- [ ] OQ4 decided + (if "restrict") Caddy re-bind verified (tailnet reaches, non-tailnet LAN refused)
  BEFORE the flip. Evidence: recorded decision + the reach/refuse probe.
- [ ] `doc-share` defaults per D-5; `--backend here-now|gist` still reach old targets. Evidence: matrix.
- [ ] docs-host-down → **loud fail by default**, no here.now, no loss; `--allow-public-fallback` →
  here.now + a #alerts line. Evidence: both host-down runs.
- [ ] privacy-scan blocks a secret AND the INV-3b sensitivity pass flags a 1P-UUID/internal-host doc.
  Evidence: both catches.
- [ ] Curated backfill of the acked manifest renders (incl. a rich doc) + body-searchable + typed;
  idempotent re-run → no dup cards; cross-path slug identical; a backfilled doc is deletable. Evidence:
  Phase-2 E2E.

## Changelog
- **v1.2 (2026-07-05):** folded Pass-1 Opus BLOCK — (blocker 1) gated the default flip on Phase 0 +
  added D-5 per-type sensitivity so PRDs don't silently go LAN-public pre-OQ4; (blocker 2) rewrote
  fallback (INV-4) to hard-fail-loud default + opt-in-public-with-#alerts, no silent private→public
  egress or durable loss; (blocker 3) added INV-3b content-sensitivity gate + per-doc ack, distinct
  from the literal-secret scan; pinned D-4 to a single key rule + INV-5 cross-path collision check;
  committed scripts to `deploy/docs-ace/`; Phase-2 E2E now includes a rich doc.
