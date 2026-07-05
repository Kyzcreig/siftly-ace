# PRD — doc-share → docs.ace default flip + durable-doc backfill (v1.3)

**Status:** DRAFT v1.3 (OQ4=A accepted; sensitivity tower removed; identity-key + fallback fixed).
**Owner:** Apollo. **Date:** 2026-07-05
**Parent PRD:** `PRD-docs-ace-local-hosting.md` (v1.3 APPROVED) — its deferred **v1.1 / Phase 6**.
**Reviews:** Pass-1 BLOCK + Pass-2 BLOCK folded. **Ace decisions (2026-07-05):** OQ4 = **(A) accept
LAN-readable** (auth deferred to a future add if he cares); keep the identity-key fix + the
fallback data-integrity fix.

## 1. Summary & Goal
Make **docs.ace the default publish target for `doc-share`** (keeping here.now + gist as explicit
opt-in backends) and **backfill a curated set of durable local docs** into docs.ace so it becomes the
canonical "everything we made, in one place" archive. New durable docs then land in docs.ace natively.

## 2. Exposure decision (was the load-bearing gate; now RESOLVED)
docs.ace binds LAN `192.168.1.18`, no per-node auth → readable by any LAN host. **Ace accepted this
(2026-07-05):** LAN-readable is fine for now; auth is a future add if he decides he cares. This is
**strictly less exposed than today's default** — doc-share currently defaults to **here.now (public
internet)**, so the flip to a LAN-only portal *reduces* exposure. Consequently the entire per-share
content-sensitivity/ack machinery from v1.2 is **removed** (nothing to gate once exposure is accepted).

## 3. Non-Goals
- **NOT** backfilling here.now's ~200 transient publishes (daily-brief re-publishes, one-off review
  shares, test pages) — churn, and here.now retains only a ~5-day window anyway.
- **NOT** removing here.now/gist — they stay as `--backend here-now|gist` (Ace's ask). Only the
  *default* changes.
- **NOT** auto-importing all ~230 candidate docs — backfill is a **curated allow-list** (dry-run
  default, human-approved manifest).
- **NOT** adding auth / tailnet-restriction in this cut (explicitly deferred by Ace; future work).
- **NOT** a per-share content-sensitivity heuristic or ack prompt (removed — exposure accepted).

## 4. Constitution / Invariants
- **INV-1 (backends retained, default opt-out-able):** default backend → `docs-ace`, but every caller
  still reaches here.now/gist via `--backend` / `DOC_SHARE_BACKEND=here-now`. **The automated callers
  of doc-share are enumerated and proven unbroken** (see D-3). *Closeout proof:* `--backend here-now`
  and `--backend gist` still publish to old targets; the enumerated automated callers run unchanged.
- **INV-2 (secret scan runs on every path):** `privacy-scan.sh` runs before every backend incl.
  docs-ace (its `.ace`/RFC-1918/tailscale/secret patterns still apply). *Closeout proof:* fake secret
  on the docs-ace path → blocked. (No longer claimed as an *exposure* gate — exposure is accepted.)
- **INV-3 (fallback never silently loses a durable doc):** on docs-ace publish failure, doc-share does
  **NOT** silently fall back to public here.now (which purges in ~5 days → silent durable loss). Default
  = **hard-fail loudly** with the reason; `--allow-public-fallback` opts into a here.now fallback AND
  **fires a #alerts notification that is proven to DELIVER** (not just emitted). *Closeout proof:*
 host-down + no opt-in → loud non-zero exit, no here.now publish; host-down + opt-in → here.now URL +
 a #alerts message **verified by reading it back from the #alerts channel by message ID** (round-trip
 the content — the discord fetch, not a `notify.py exited 0` — matching the fleet's
 alert-delivery-path-integrity discipline).
- **INV-4 (deterministic dedup for real source files; fresh slug for transient — never a dup card):**
  see D-2. A re-share of the **same on-disk source file** maps to the **same** docs.ace slug and
  updates in place; a **generated/transient** input (`/tmp/*`, stdin, `--fresh`) gets a fresh
  timestamp slug (today's behavior) and carries **no** dedup contract. The collision check spans both
  the backfill and live paths. *Closeout proof:* share the same file twice → identical slug, one card;
  share a `/tmp` render twice → two fresh slugs (documented, expected).
- **INV-5 (briefs' slugging is untouched):** the briefs publish via `build-report.sh`'s own
  `DOCS_PUBLISHER` path calling `ace_publisher.py --doc-id "…|<date>"` **directly** — they do NOT use
  doc-share's default backend or key derivation. The flip cannot change how briefs slug. *Closeout
  proof:* grep shows `build-report.sh` calls `ace_publisher.py` directly; a brief run pre/post-flip
  yields the same deterministic per-day slug.
- **INV-6 (backfill reversible, in-docroot, idempotent, orphans reconciled):** every backfilled doc is
  soft-deletable via `/api/doc/delete`; no write outside docroot; re-run yields identical slugs; **a
  rename/move that changes a doc's key auto-soft-deletes the orphaned old slug** (D-2 RC-4) — not a
  dangling log note. *Closeout proof:* delete → 404 + neighbor serves; re-run → no dup cards; rename a
  tracked source → old card gone, new card present (one card, not two).

## 5. Resolved Decisions
- **D-1:** Default `doc-share` backend → `docs-ace`; here.now + gist stay as `--backend` opts (Ace).
  No sensitivity gating (exposure accepted, D-0/§2). Global override `DOC_SHARE_BACKEND=here-now` works.
- **D-2 (identity key — the pinned rule, covers the firehose):**
  - **Real on-disk source** (an arg that resolves to an existing file that is NOT under a temp root):
    `doc_identity_key = "docshare|" + sha1(logical_id)[:12]` where `logical_id` is, in priority order,
    the **repo-relative path** (if the file is inside a git work-tree: `git -C <dir> rev-parse
    --show-toplevel` + relpath), else the **vault-relative path** (if under the Obsidian vault root),
    else `os.path.realpath(src)` as the fallback. Using a *logical* id first means the SAME doc dedups
    even when reached via a different absolute mount on a second host (RC-1); realpath is only the
    last-resort key for files outside any known root. **Documented limitation:** a file outside any
    repo/vault root dedups per-host/per-absolute-path only. A rename/move within a root changes the key
    → the importer/CLI **auto-soft-deletes the old slug** when it can resolve the prior key (RC-4), not
    just log a note.
  - **Generated / transient input:** a fresh timestamp slug (`docshare|<epoch_ms>`), **no dedup**.
    *Transient is detected by:* the resolved path is under ANY temp root — `$TMPDIR` (macOS
    `/var/folders/…`), `/tmp`, `/private/tmp`, `/var/tmp` (all realpath-normalized so the `/tmp`→
    `/private/tmp` symlink is handled) — OR the input is stdin — OR `--fresh` is passed. This makes the
    common macOS `mktemp`→`/var/folders/…` render correctly transient (RC-2) instead of getting a
    realpath key on an ephemeral path that orphans next run.
  - A caller may always override with an explicit `--doc-id` (what the briefs do via ace_publisher).
  - `salt` = the existing docs.ace D-11 salt in `~/.hermes/var/docs-portal/` (pinned, not per-run).
- **D-3 (automated-caller safety):** enumerate every automated `doc-share.sh` caller and confirm the
  flip is safe for each: `build-report.sh` bypasses doc-share's default (uses `ace_publisher.py`
  directly, INV-5) — unaffected; any cron/skill that calls `doc-share.sh` for an internal artifact now
  lands on docs.ace (a *tightening*, LAN vs public) and keeps working (URL still printed on stdout).
  No interactive prompt is introduced (would break non-interactive callers), consistent with removing
  the ack machinery.
- **D-4:** Backfill = curated allow-list manifest, human-approved, dry-run default. Source = local
  durable artifacts via `ace_publisher.py`. `type` ∈ `prd`/`report`/`overview`/`doc`.
- **D-5 (fallback default):** hard-fail-loud (INV-3); `--allow-public-fallback` opt-in + delivered
  #alerts. Never automatic silent public egress.

## 6. Architecture / Design
**6A. doc-share `docs-ace` backend + default flip.**
- New `scripts/backends/docs-ace.sh`: rendered HTML + title + derived doc-id (D-2) → `ace_publisher.py`,
  prints `https://<slug>.docs.ace/` on stdout, non-zero on fail. **Shared-contract discipline:** factor
  the common arg/scan/echo path so `docs-ace.sh` and `here-now.sh` don't drift, or add a parity check
  asserting both expose the same flags. Pre-edit `.bak-<ts>-pre-docsace-default` of `doc-share.sh`.
- Default flip: `here-now` → `docs-ace`; add `docs-ace` to the `--backend` allow-list; `privacy-scan.sh`
  unchanged (runs before backend). No per-type routing (exposure accepted).
- Fallback: INV-3 — hard-fail-loud default; `--allow-public-fallback` → re-scan (public model) +
  here.now + **delivered** #alerts.

**6B. Curated backfill importer.**
- `~/.hermes/var/docs-portal/backfill.py` **+ a committed copy in `deploy/docs-ace/`** (not
  single-copy-on-disk runtime): manifest (JSON `[{path,type,title,doc_id?}]`) → render MD→HTML (reuse
  `render-pretty-doc.sh`) → `ace_publisher.py` per entry → report slugs. **Idempotent, dry-run default,
  cross-path collision check.**
- Manifest helper scans candidate dirs → proposed manifest with a one-line summary per doc → Ace
  trims/approves → importer runs only approved rows.

## 7. Implementation Phases
- **Phase 1 — docs-ace backend + default flip + fallback (6A).**
  - *Unit/script:* `doc-share.sh --backend docs-ace <file.md>` → `*.docs.ace` URL; doc in portal +
    FTS-searchable; re-share same file → same slug (D-2 dedup); share a `/tmp` render → fresh slug.
  - *E2E:* three-backend matrix (default→docs-ace, `--backend here-now`→here.now, `--backend gist`→gist);
    **host-down → loud fail, no here.now (INV-3); `--allow-public-fallback` → here.now URL + a RECEIVED
    #alerts message**; the enumerated automated callers (D-3) still work.
  - *Negative:* fake secret → privacy-scan blocks on docs-ace path; `--backend bogus` → clean error.
  - *Verify with:* the matrix + dedup/fresh check + the delivered-alert capture + caller smoke.
- **Phase 2 — curated backfill (6B).**
  - *Unit/script:* `backfill.py --manifest <m.json> --dry-run` lists intended; real run publishes;
    re-run → identical slugs, no dup cards (INV-6); cross-path collision check passes.
  - *E2E:* backfill 3-5 real durable docs **including one rich doc (mermaid/internal-links/an image)**
    → each renders at its slug + body-searchable + right `type` facet.
  - *Negative:* delete a backfilled doc → 404 + neighbor serves (INV-6).
  - *Verify with:* dry-run + live render of the set + idempotency re-run + delete.

## 8. Security, Privacy, Ops
- Exposure **accepted** (§2) — LAN-readable, no login; less exposed than today's public-here.now
  default. Auth is future work if Ace wants it.
- INV-2 secret scan still runs on every path (defense-in-depth, not the exposure gate).
- **Fallback data-integrity (INV-3):** loud-fail default; opt-in public fallback with a *delivered*
  alert; the docs.ace canary gains a **"fallback-fired" signal**. No silent durable-doc loss.
- Backfill reversible + idempotent + dry-run default; scripts committed to `deploy/docs-ace/`.

## 9. Risks & Mitigations
- **R1: flip breaks a here.now-expecting caller.** → INV-1 + D-3 enumerated callers + three-backend E2E.
- **R2: docs-ace-down silently loses a durable doc to here.now's purge.** → INV-3 loud-fail + opt-in.
- **R3: dup cards / collisions across backfill + live paths.** → D-2 single rule + INV-4 cross-path check.
- **R4: backfill floods the clean index.** → D-4 curated, dry-run default.
- **R5: MD→HTML fails on rich PRDs.** → Phase-2 E2E includes a rich doc.
- **R6: brief slugging changes on the flip.** → INV-5 (briefs bypass doc-share entirely); proven by grep.

## 10. Acceptance Criteria
- [ ] `doc-share` defaults to docs.ace; `--backend here-now|gist` still reach old targets; enumerated
  automated callers unbroken. Evidence: matrix + caller smoke.
- [ ] Same on-disk file re-shared → identical slug (one card); `/tmp` render → fresh slug. Evidence:
  the dedup/fresh check.
- [ ] docs-host-down → loud fail, no here.now, no loss; `--allow-public-fallback` → here.now + a
  #alerts message **read back from the channel by message ID** (round-tripped content, not a notify
  exit code). Evidence: both host-down runs + the fetched alert message.
- [ ] Briefs slug identically pre/post-flip (bypass doc-share). Evidence: grep + a brief run.
- [ ] privacy-scan blocks a secret on the docs-ace path. Evidence: fake-secret doc → blocked.
- [ ] Curated backfill of the manifest renders (incl. a rich doc) + body-searchable + typed; idempotent
  re-run → no dup cards; a backfilled doc is deletable. Evidence: Phase-2 E2E.

## Changelog
- **v1.3-AWC (2026-07-05):** Pass-3 = APPROVE-WITH-CHANGES; folded 4 required changes — (RC-1) D-2
  keys on a LOGICAL id (repo-relative → vault-relative → realpath fallback) so a doc dedups across the
  fleet's multi-mount Obsidian topology, realpath only for files outside any known root (per-host
  limitation documented); (RC-2) transient-detection predicate pinned to ALL temp roots incl. macOS
  `$TMPDIR`/`/var/folders` (realpath-normalized) so `mktemp` renders don't orphan; (RC-3) the
  delivered-alert AC now names its capture method (read back from #alerts by message ID, not a notify
  exit code); (RC-4) rename-orphan is AUTO-soft-deleted, not a dangling note (INV-6). NOTE: the whole
  sensitivity-tower removal is *conditional on OQ4=(A) accept* — a future reversal to restrict/auth
  must re-add it. **APPROVED for implementation.**
- **v1.3 (2026-07-05):** Ace decided OQ4=(A) accept LAN-readable → **removed the entire per-share
  content-sensitivity + ack tower** (Pass-2 blocker 1 dissolves: nothing to gate once exposure is
  accepted; and the flip is a *tightening* vs today's public-here.now default). Fixed the identity key
  (Pass-2 blocker 2): D-2 now covers generated/`/tmp` inputs (fresh slug, no dedup) vs real on-disk
  files (deterministic dedup), and INV-5 proves briefs bypass doc-share entirely so their fresh-slug
  behavior is structurally untouched. Kept the fallback data-integrity fix (INV-3 loud-fail +
  opt-in-with-*delivered*-alert) and the automated-caller enumeration (D-3). Net: the spec got
  **smaller**, and the two remaining fixes are bounded (a key rule + a fallback branch), not new towers.
- **v1.2:** folded Pass-1 BLOCK (gate flip on exposure, fallback semantics, secret-vs-sensitivity split).
