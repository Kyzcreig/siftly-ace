# PRD — `docs.ace`: a local here.now clone (unified doc portal, in-page X actions, share-to-here.now)

**Status:** ✅ CLOSED OUT 2026-07-05 — all phases (1–5) shipped + live-verified; v1.1 Phase-6 doc-share default flip DONE; OQ4 resolved (docs.ace is LAN-only, tailnet peers cannot reach it). Closeout report in commit message + Obsidian `AI/docs.ace — System Overview.md`. Originally APPROVED v1.3 (2 Opus passes converged + Fable-5 self-review). Supersedes v0.3.
**Author:** Apollo
**Date:** 2026-07-02
**Owner:** Apollo (Mac Studio host)
**Related:** `news-digest-cron-pipeline`, `ace-dashboard-portal-generators`, `local-dns`, `dns-block-portal-frontdoor`, `doc-share`, `xurl`, `here.now`, `acceptance-gate-proves-proxy-not-effect`

---

## 1. Summary & Goal

Replace here.now as the fleet's **default document host** with **`docs.ace`** — a locally-run here.now
clone on Mac Studio that:

1. **Hosts every doc** (briefs, PRDs, reports, any `doc-share` artifact) at `<slug>.docs.ace`, served
   over trusted HTTPS on LAN + tailnet.
2. **Is the here.now dashboard, cloned:** a portal at `docs.ace` that lists all docs as cards
   (title/description/date/type) with **full-text search over doc bodies**, plus per-doc **open**,
   **share**, **delete**, and **revoke-share** actions.
3. **Adds in-page X actions** briefs couldn't have on here.now: Like ♥ / Bookmark 🔖 buttons on every
   X-sourced item, acting as **Ace's own account** via a same-origin endpoint backed by a **scoped
   token** (like+bookmark only — cannot post/delete/DM). This feeds the bookmark/like corpus that
   `pf-score.py` learns from.
4. **Shares externally by publishing a button-stripped COPY to real here.now** — a per-doc Share action
   returns a public URL (clipboard + new tab); the copy has the X buttons removed so it can never act as
   Ace. Nothing on the LAN is ever internet-exposed.

**Why now:** Ace wants one coherent local portal instead of the closed here.now SaaS — searchable,
button-capable, private-by-default — while keeping here.now as an opt-in *external share* target. The
briefs are the first and highest-value content; `doc-share` then flips its default to docs.ace so every
doc lands there.

**This supersedes the v0.3 `*.brief.ace` design.** The `*.brief.ace` two-name scheme is replaced by one
unified `*.docs.ace` portal; briefs become content type #1, not a separate host.

---

## 2. Non-Goals

- **NOT** a here.now feature-clone: no Drives, no multi-tenant accounts, no custom domains, no analytics.
  We clone exactly: static per-slug hosting + a searchable dashboard + per-doc share/delete.
- **NOT** public-by-default. Every docs.ace page is LAN/tailnet-only unless explicitly shared.
- **NOT** a live internet proxy/tunnel of the LAN. External sharing is a *static copy* published to
  here.now — the docs.ace host is never internet-reachable.
- **NOT** a general CMS/editor. docs.ace indexes/serves artifacts other pipelines produce; it does not
  author or edit them.
- **NOT** a new scoring/selection/render path for the briefs. Only the *publish/delivery* step and
  *button injection* change; scoring/overview/render are untouched.
- **NOT** exposing the X-action endpoint publicly or to here.now. It binds LAN+tailnet only, forever.
- **v1.0 (this cut) explicitly does NOT:** migrate every doc-share caller to docs.ace on day one — that
  default flip is **v1.1** (Phase 6). v1.0 = host + `<slug>.docs.ace` serving + brief cutover + X buttons +
  the portal (cards + full-text search) + Share/Revoke/Delete (Phases 1–5). *(Within v1.0, phases are
  sequenced so the host + briefs (Phases 1–3) are proven before the portal actions (Phases 4–5) build on
  them.)*

---

## 3. Constitution / Invariants

*(I1, I1x, I2, I3, I5, I8 carry over from v0.3 essentially unchanged — the trust boundary didn't move.
I4, I6, I7 are updated for the docs.ace unification. I9–I11 are new for the portal/share/doc-share.)*

- **Invariant I1 — X actions require ORIGIN-authorized, CSRF-preflight-protected requests, not just
  network reachability.** The `/api/x/*` endpoint's credential is the server-side scoped token (not a
  browser cookie), so reachability alone is a confused-deputy hole. Before any action it enforces, and
  proceeds ONLY if all pass: (a) **Origin/Referer** must match the pattern `https://<label>.docs.ace`
  (a strict **suffix+shape** check: scheme `https`, host ends in `.docs.ace`, exactly one leading DNS
  label, no port/userinfo — NOT a fixed slug list, since slugs are unbounded; and NOT a naive
  `endswith(".docs.ace")` which `evil-docs.ace.attacker.com` would pass — anchor the full host). A
  non-browser client can forge Origin, so it's not the load-bearing control — see (b). **The CORS
  `Access-Control-Allow-Origin` reflects the request Origin ONLY when it passes this same check** (never
  a wildcard `*`, which is incompatible with credentialed/custom-header requests anyway); (b) **a
  forced CORS preflight — THE load-bearing browser control:** a required non-simple header
  `X-Docs-Ace-CSRF: 1` makes the request non-simple → a real browser MUST preflight, and the CORS
  response WITHHOLDS `Access-Control-Allow-Origin`/`-Headers` for any non-`docs.ace` origin, so the
  browser blocks the real request. `X-Docs-Ace-CSRF: 1` is a **preflight-forcing MARKER, not a secret**
  (do not "harden" it into a guessable static pseudo-secret). (c) **Host pinning** — `Host` must be a
  `*.docs.ace` name (blocks DNS-rebind to the raw LAN IP). (d) network bind LAN+tailnet only =
  defense-in-depth, not primary auth.
  - *Closeout proof (two distinct tests):* **(I1-preflight)** an `OPTIONS` from a disallowed origin gets
    a response WITHHOLDING the ACAO/ACAH headers; **(I1-origin)** a POST with a forged non-`docs.ace`
    Origin → 403, **zero token API calls** (spy); missing `X-Docs-Ace-CSRF` → rejected; forged `Host` →
    403; legitimate same-origin call → 1 action. Origin-check-only would pass I1-origin but FAIL
    I1-preflight — that's why both exist.

- **Invariant I1x — the render's XSS-escaping is load-bearing for the action endpoint, backed by a
  Content-Security-Policy.** The endpoint is same-origin with served docs, so any script executing inside
  a `*.docs.ace` page passes the I1 gate. Doc content is untrusted (tweet text, overview prose, handles),
  so `html_report.ts` + the portal generator's XSS-escaping is a **security dependency** of the endpoint.
  As **defense-in-depth that doesn't rely on the escaping being perfect forever**, every `*.docs.ace`
  response carries a strict CSP whose `script-src` uses a **`'sha256-<hash>'` source** for the fixed,
  known button JS (NOT a per-response nonce — a nonce would require injecting fresh bytes per GET,
  contradicting I4's static/identical-from-any-server property; a hash of the fixed script preserves it).
  Full policy: `default-src 'none'; script-src 'sha256-<buttonjs-hash>'; style-src 'self' 'unsafe-inline'`
  (the house-kit dark theme uses inline styles) `; img-src 'self' https://pbs.twimg.com https://*.twimg.com`
  (tweet media/avatars) `; connect-src 'self'` (the same-origin button fetch) `; base-uri 'none';
  frame-ancestors 'none'`. So a stored-XSS injected `<script>` (no matching hash) is blocked, while tweet
  media + theme still render. The CSP header is part of the 4-way config-drift surface (§7).
  - *Closeout proof:* the render/portal XSS battery stays green, tagged as guarding the endpoint; a
    hostile tweet/overview/title payload renders inert AND a **headless-browser load of a page with an
    injected non-hashed `<script>` shows it is CSP-BLOCKED** (not just grep); tweet images + dark theme
    still render under the policy.

- **Invariant I2 — the scoped X token never leaves Mac Studio; the ROTATING refresh token is
  persisted-and-verified BEFORE serving, under a cross-process lock.** No token is copied to here.now
  variables, embedded in any served/shared HTML, or logged. X `offline.access` refresh tokens are
  **single-use/rotating** — X invalidates the old refresh token the instant `/oauth2/token` returns the
  new one — so the endpoint:
  - (a) Serializes refreshes behind a **cross-process file lock** (`flock` on a lockfile, NOT an
    in-process async mutex — an in-process mutex does not cover two overlapping processes during a launchd
    graceful restart).
  - (b) On a successful token response, **persists-and-VERIFIES the new refresh token to the SoT BEFORE
    releasing the lock or serving the tap.** SoT = a **local 0600 file mirror** (`~/.hermes/state/docs-ace-x-token.json`,
    atomic temp-write+rename — a real local atomic op) as the hot path; 1Password holds the *seed* token
    and is updated best-effort as a backup (NOT the per-refresh hot path — `op item edit` is a remote
    PATCH, not atomic, and per-refresh network latency/failure is exactly the lockout vector). The local
    mirror is re-read on restart.
  - (c) If the write-back FAILS after X has rotated, fire a **LOUD #alerts immediately** (the only valid
    refresh token is now in memory — a restart would lose it) and keep serving from memory until it can
    persist; do not silently fail just the tap.
  - *Why:* without verify-before-serve + a cross-process lock, the design relocates the lockout past the
    rotation instead of closing it. There is an irreducible in-memory-only window between X's rotation and
    a verified persist — the requirement is to MINIMIZE + ALERT on it, not claim it's eliminated.
  - *Closeout proof:* `grep -ri "bearer\|oauth\|token" <served_html> <shared_copy_html>` = nothing; two
    concurrent 401s → ONE rotation, both succeed; killing+restarting after a refresh authenticates from
    the local mirror; a simulated write-back failure fires #alerts and does NOT leave a silently-stale SoT.

- **Invariant I3 — the briefs never fail to deliver, and never post a DEAD/WRONG link.** The `ace`
  publisher self-verifies its own minted URL (HTTP 200 + a **per-publish content marker** it embedded —
  e.g. the `docs-ace-id` meta or the exact title — so a 200 serving a STALE/other doc is caught, not just
  a 404) BEFORE returning success; a
  mint-but-unreachable result (DNS/Caddy/cert drift) is a publisher FAILURE that falls through to the
  inline-render post to #daily. #daily is never empty AND never carries a dead `*.docs.ace` link.
  - *Closeout proof:* breaking the SERVE path (remove the Caddy route/cert, not just kill the process) and
    running a brief still posts a working brief via inline fallback; heartbeat records `publisher:
    fallback`; no dead link posted.

- **Invariant I4 — served + shared docs are self-contained static files.** A docs.ace page renders
  identically from any static server; the ONLY dynamic calls are the injected same-origin `/api/x/*`
  button fetches. **A SHARED (here.now) copy has NO functional buttons** (stripped or swapped for
  viewer-session web-intent links) and no `/api/x/*` reference at all.
  - *Closeout proof:* served doc — `grep "fetch(\|/api/x/"` counts only same-origin button calls; shared
    copy — `grep "/api/x/\|X-Docs-Ace-CSRF"` == 0.

- **Invariant I5 — the X endpoint verb allow-list is closed AND the token is scope-limited (two layers).**
  The endpoint calls ONLY the X v2 `{like,unlike,bookmark,unbookmark}` endpoints for a numeric tweet_id
  (`^\d{5,25}$`), building the request from a fixed `{action → X API path}` map — never post/DM/delete.
  **AND** the `docs-ace-buttons` token is scoped to `like.write bookmark.write tweet.read users.read`
  only, so even a total endpoint compromise cannot post/delete/DM (proven: `POST /2/tweets` → 403).
  - *Closeout proof:* adversarial (`action=post`, `tweet_id="1; rm"`, `tweet_id=abc`) → 400/404, **zero
    API calls**; the token's `POST /2/tweets` → 403 (Phase-0, done).

- **Invariant I6 — public share is opt-in, per-doc, button-stripped, and revocable.** No doc is published
  to here.now unless Share is invoked on that one doc; the daily cron never publishes publicly; the shared
  copy has the X buttons removed (I4); Revoke-share deletes the here.now site.
  - *Closeout proof:* grep shows no here.now publish in the cron flow; Share is a separate human/portal
    action; the published copy loads with no functional buttons; revoke → the here.now URL 404s.

- **Invariant I7 — one publisher interface, swappable, no scoring/render coupling; docs.ace is the
  default, here.now stays selectable.** `doc-share`/`build-report.sh` select a publisher driver by
  parameter (`ace` | `herenow`); each takes `(html, title, date, type)` and returns a URL (and
  self-verifies per I3). The **default is `ace` (docs.ace)** with a single source of truth; `herenow`
  remains an explicit opt-in. Adding/removing a driver never touches scoring/selection/render code.
  - *Closeout proof:* grep shows one default var; the drivers share one contract; flipping the default is
    one line; no caller hardcodes a competing default; `--publisher herenow` still works.

- **Invariant I8 — scoped-token write budget is isolated from the ingest read budget.** The button token
  (`docs-ace-buttons` app) is a SEPARATE app/token from the full-scope `siftly-ace` ingest token, so
  button writes and daily ingest reads draw on separate quotas; the endpoint rate-limits writes.
  - *Closeout proof:* the two apps are distinct (done — separate 1Password items); a burst test doesn't
    touch the ingest quota; writes/reads accounted separately in the audit log.

- **Invariant I9 — the doc index is derived, never hand-maintained, and can't leak private bodies to a
  shared copy's index.** Portal metadata (title/description/type/date) is auto-derived at publish time; the
  full-text search index is built from served doc bodies and lives **only on docs.ace** (never published
  in a shared copy).
  - *Closeout proof:* publishing N docs indexes them with zero manual metadata; the search index file is
    not in any here.now manifest; a body-phrase query returns the right doc.

- **Invariant I10 — delete/revoke are the only destructive portal actions, both fail safe, and the
  share→here.now-slug mapping is durably persisted with a revoke-by-listing fallback.** A local **delete**
  removes the doc's served files + index entry (trash/soft-delete, not `rm -rf`); **revoke-share** deletes
  the here.now copy via `DELETE /api/v1/publish/<slug>`. The `(doc → here.now slug)` mapping is stored
  **durably in the D-12 index store** (not in-memory), so a restart/disk-loss can't orphan a public copy.
  **Fallback (deterministic, not fuzzy):** the published copy embeds a **`docs.ace` doc-id marker** in its
  metadata (a `<meta name="docs-ace-id" content="<doc_identity_key-hash>">`), so if the local mapping is
  ever lost, revoke enumerates the account's here.now sites (`GET /api/v1/publishes`) and correlates by the
  EXACT marker (not by fuzzy slug/title, which are random-per-publish and can near-collide) — so "public
  stays public" is not reachable and the wrong site can't be revoked. Neither action can touch a doc other
  than the one targeted; both require an explicit same-origin (I1-gated) request.
  - *Closeout proof:* delete removes exactly one slug's files (adjacent docs untouched); revoke deletes
    exactly one here.now site; after wiping the local mapping, the marker-fallback finds + revokes the
    exact copy (and refuses an ambiguous match); a cross-origin delete/revoke → 403, no effect.

- **Invariant I11 — doc-share's contract is preserved when the default flips.** After `doc-share` defaults
  to `ace`, every existing caller (prd-share, brief crons, ad-hoc shares) still gets a working URL back;
  the `herenow` behavior is reachable via an explicit flag; no caller breaks.
  - *Closeout proof:* the existing doc-share callers return a `*.docs.ace` URL that loads; `--publisher
    herenow` returns a working here.now URL; a smoke over each known caller passes.

---

## 4. Resolved Decisions

- **D-1 — Host = Mac Studio `.18`.** Briefs, the scoped token, and the `.ace`/Caddy front door all live
  here. *(Ace, v0.3.)*
- **D-2 — Both actions (Like + Bookmark), as Ace's account, feeding the pf corpus.** *(Ace.)*
- **D-3 — Full cutover: docs.ace is the default host; here.now retained as an external-share target + a
  selectable publisher option.** *(Ace: "keep using it like here.now… purely our own local portal"; "of
  course… still have here.now as an option if needed".)*
- **D-4 — URL scheme: `<two-random-words>.docs.ace` per doc; portal at `docs.ace`.** Wildcard `*.docs.ace`
  → Mac Studio; the server maps `slug` → the doc's files. here.now-parity per-doc subdomains; unguessable
  slug = defense-in-depth even on-LAN. *(Ace: Q1→a.)*
- **D-5 — Action authz = Origin + forced-CSRF-preflight + Host pinning (network identity for page reach
  only).** *(Carried from v0.3 B1 correction.)*
- **D-6 — docs.ace is the here.now clone; ALL doc types are content (briefs first, then everything via
  doc-share).** *(Ace: Q2→b, "doc-share can have this as the default… still have here.now as an option".)*
- **D-7 — Share = publish a button-STRIPPED static COPY to here.now** (reuse `doc-share`'s `here-now.sh`
  backend), URL to clipboard + new tab; revocable by deleting the here.now site. NOT a live proxy/tunnel.
  *(Ace: Q3→a + the "would people like/bookmark through our account?" safety confirm → strip buttons.)*
- **D-8 — here.now is NOT self-hostable** (closed SaaS; only its skill is OSS). We clone host+slug+search+
  share on our own infra. Reverse-engineered its surface from its docs + the live API (list/detail/
  metadata/delete all work via the stored API key). *(Investigated.)*
- **D-9 — Reliability via launchd keepalive + a `.ace` canary + token-health + cross-origin-preflight
  canaries.** *(Ace, v0.3.)*
- **D-10 — Buttons optimistic but fail closed:** tap fills ♥/🔖; on endpoint error/re-auth the fill
  reverts + shows a visible error (never a silent success). No persistent "already liked" state in v1.0
  (costs a read per item per load). *(v0.3.)*
- **D-11 — Slug is deterministic per an explicit `doc_identity_key` via a SEED+SALT-ESCALATION function.**
  **`doc_identity_key` is defined PER DOC-TYPE** so retry-reuse means the right thing: **briefs →
  `(brief_name, PT_date)`** (a same-day re-run reuses the slug → keeps the posted #daily link alive; a
  same-day content change intentionally REPLACES that day's brief at the same slug, which is the desired
  behavior — a corrected morning digest keeps its link; **note:** if that brief had already been
  *shared* to here.now, the public copy is now stale — Share is manual/rare on briefs so this is
  acceptable, but a re-Share overwrites and Revoke still works via the I10 marker); **PRDs/named docs → a stable doc path/id**
  (edits reuse the slug so a shared/linked PRD URL survives revisions); **ad-hoc doc-share → the source
  file path** (or an explicit `--doc-id`). `slug = words(hash(doc_identity_key || salt))`, salt from 0;
  on publish, if the target dir exists AND belongs to a DIFFERENT `doc_identity_key` (a true birthday
  collision), increment salt and recompute until free-or-same-identity — so two *different* docs that
  hash-collide get distinct slugs, **never overwriting each other**, while the same identity is
  byte-deterministic. The `(doc_identity_key → slug, salt, here.now-share-slug)` binding is persisted in
  the D-12 store so retries re-derive the exact prior slug across restarts. *(Fixes pass-1 B3 + pass-2 B3:
  identity key pinned per type; Phase-1's "collision → distinct slug" negative = a cross-identity
  collision, not a retry.)*
- **D-12 — Archive retention + a DURABLE index store (three invariants depend on it).** Keep N days on
  disk (default 90) for direct reach; the portal indexes full history from a compact metadata + FTS store
  (OQ1: sqlite FTS5) even after raw HTML is pruned. **This store now carries the D-11 slug/salt binding,
  the I10 share→here.now mapping, and the doc metadata — so it is load-bearing and MUST be durable:** it
  lives on the local disk, is included in the fleet backup, and its loss is recoverable (the slug binding
  can be re-derived from `doc_identity_key`; the share mapping via the I10 marker-fallback). **Pruning
  raw HTML at 90d does NOT prune the store's binding rows** — so a salt-escalated retry after a prune
  still re-derives the same slug deterministically (the pruned dir's identity is still recorded, avoiding
  a salt=0 recompute that would land on a now-free-but-historically-taken slug). *(v0.3 + pass-2
  durability fold.)*
- **D-13 — Search = metadata cards + FULL-TEXT body index** (better than here.now's title/description-only
  search; cheap locally). *(Ace: Q4→b.)*
- **D-14 — No portal login; network-identity is the auth** (matches index.ace/crons.ace); the X actions
  are separately Origin/CSRF-gated. *(Ace: Q5→a.)*
- **D-15 — Portal has per-doc DELETE + REVOKE-SHARE buttons** (full here.now parity) alongside
  auto-retention. Delete = soft/trash, single-doc scoped. *(Ace: Q6→b.)*
- **D-16 — Option-B scoped token, minted + proven** (`docs-ace-buttons`: like+bookmark+read only; POST→
  403). The endpoint calls the X API v2 directly with this token (NOT `xurl`, whose default app is the
  full-scope `siftly-ace`), refreshing via the refresh_token on 401. *(Ace chose B; done this session.)*
- **D-17 — Shared-copy button treatment = STRIP (default) with an optional viewer-session web-intent
  link.** A shared brief renders read-only; if a "like on X" affordance is wanted it's an
  `intent/like?tweet_id=` link acting as the *viewer's* session, never Ace's. *(Derived from the Q3
  safety discussion; strip is the safe default.)*

---

## 5. Architecture / Design

### 5.1 Components (all on Mac Studio `.18`, behind Caddy)
```
  Caddy (.ace front door, existing skills-portal/Caddyfile)
    docs.ace            ──► docs-portal service        (portal + search + delete/revoke/share actions)
    *.docs.ace          ──► docs-host service          (serves <slug> docs + /api/x/* endpoint)
                                                          bind 127.0.0.1 + LAN + tailscale only (I1d)

  docs-host service (one process, same origin for the button fetch):
    GET  /                         → serve briefs/docs/<slug>/index.html   (by Host = <slug>.docs.ace)
    POST /api/x/{like,unlike,bookmark,unbookmark}
         → I1 gate (Origin + X-Docs-Ace-CSRF preflight + Host) → X API v2 with the SCOPED token (I5/I8)
         → refresh on 401 (offline.access), rate-limited, audit-logged (never the token)

  docs-portal service (docs.ace):
    GET  /                         → dashboard: cards (title/desc/type/date) + full-text search box (D-13)
    POST /api/doc/{delete,revoke-share,share}   → I1-gated single-doc actions (I10)
         share       → doc-share here-now.sh on a BUTTON-STRIPPED copy → public URL (I6/I4/D-17)
         revoke-share→ here.now DELETE /api/v1/publish/<slug>
         delete      → soft-delete the local doc's files + index entry

  Publisher abstraction (doc-share / build-report.sh):
    --publisher ace      (DEFAULT) → write briefs/docs/<type>/<slug>/index.html + mint <slug>.docs.ace, self-verify (I3)
    --publisher herenow  (opt-in)  → today's here.now publish (also the share-copy engine)

  Index:  a compact metadata + full-text store (sqlite FTS5 or a JSON+inverted-index) built at publish
          time; lives ONLY on docs.ace (I9); auto-derived title/desc/type/date (D-13).
```

### 5.2 Publisher abstraction (I7, I11)
`doc-share`/`build-report.sh` gain `--publisher {ace|herenow}` with `ace` as the single-source default.
Each driver: `publish(html, title, date, type) → prints URL` and self-verifies (I3). The `ace` driver
writes to the docs-host webroot, mints `<slug>.docs.ace`, updates the index. `herenow` = today's
behavior, retained for opt-in and as the **share-copy** engine (§5.4). Brief `prompt.md` Step 7 flips its
publisher flag; the inline fallback (I3) is unchanged.

### 5.3 X-action endpoint (trust boundary — I1/I1x/I2/I5/I8)
Same-process with docs-host (same origin). I1 authz gate before any action. Maps
`{like,unlike,bookmark,unbookmark} → POST/DELETE /2/users/:id/{likes,bookmarks}` with the **scoped
`docs-ace-buttons` token** (read from the local 0600 mirror at process start — seeded from 1Password;
refreshed via refresh_token on 401 under the I2 flock + verify-before-serve).
tweet_id validated `^\d{5,25}$`; request built as structured params (no shell). Quote-tweets pin the
PRIMARY tweet_id. Rate-limited (I8); audit log records action+tweet_id+result, never the token.
**Ground-truthed working X v2 calls (Phase-0):** `POST /2/users/56282605/likes {tweet_id}` /
`DELETE …/likes/:id`; bookmarks analogous; `POST /2/tweets` → 403 (scope proof).

### 5.4 Share (I6, I4, D-7, D-17)
The portal Share action: (1) load the doc's stored HTML; (2) produce a **button-stripped variant** — via
a **DOM parse** (not a fragile regex) that removes the `/api/x/*` button block + its script, optionally
injecting `intent/like?tweet_id=` viewer-session links; (3) run `doc-share here-now.sh` on that variant →
a fresh here.now slug; (4) return the URL (clipboard + new tab); (5) durably record the here.now slug
against the doc in the D-12 index (I10) so **revoke-share** can `DELETE /api/v1/publish/<slug>` (with the
listing-fallback if the mapping is ever lost). A privacy-scan (`doc-share/privacy-scan.sh`) runs before
publish. **The origin check (I1), not the strip, is the load-bearing guarantee** that a copy can't act as
Ace — the strip is UX; the I4 grep-for-`/api/x/` on the published copy is the assertion that catches a
strip miss.

### 5.5 Portal + search (D-13, D-14, D-15, I9)
Built on the `ace-dashboard-portal-generators` house kit (dark theme, cards, mobile stacking,
XSS-escaped, DOM-read JS — no server-interpolated row data). Data source = walk `briefs/docs/**` +
the index. **Full-text search:** an FTS index (sqlite FTS5 preferred) over doc bodies, queried by a
search box (client hits a `docs.ace` search endpoint; results are doc cards). Per-doc actions: open
(→ `<slug>.docs.ace`), share, delete, revoke-share (all I1-gated, I10). No login (D-14).

### 5.6 DNS / cert / serving
Wildcard `*.docs.ace` + `docs.ace` AGH rewrites → `.18`; a `*.docs.ace` wildcard leaf from the
`trust.ace` CA (Phase-0: mintable); Caddy routes `docs.ace`→portal, `*.docs.ace`→host. Under launchd
`KeepAlive` (D-9) + `.ace` canary + the two endpoint canaries (§7).

---

## 6. Implementation Phases

### Phase 0 — Ground-truth (DONE, carried from v0.3 — re-scoped names)
✅ Serving substrate (Caddy per-name blocks, file_server/reverse_proxy). ✅ `trust.ace` CA can mint a
wildcard leaf (now `*.docs.ace`). ✅ AGH wildcard rewrite. ✅ **Scoped token minted + proven**
(`docs-ace-buttons`: like/bookmark 200 read-back, POST 403; refresh token; in 1Password). ✅ here.now
surface reverse-engineered (list/detail/metadata/delete via the live API key). **HARD Phase-0-EXIT GATE
before Phase 5 (pass-2): verify `DELETE /api/v1/publish/<slug>` live on a throwaway slug** — it now gates
BOTH revoke-share AND the I10 marker-fallback, so two folded blockers depend on it. Publish a throwaway
here.now site, DELETE it, confirm it 404s. Must pass before Phase 5 starts.

### Phase 1 — docs-host + `ace` publisher + DNS/cert/Caddy (v1.0 core)
Ships: docs-host serving `<slug>.docs.ace` over HTTPS; the `ace` publisher (with I3 self-verify);
wildcard DNS+cert+Caddy; launchd keepalive + canary.
- *Unit:* `ace` publisher writes the right path + returns a well-formed `<slug>.docs.ace` URL; slug is
  two words; a retry for the same doc identity REUSES the slug (D-11).
- *E2E:* publish a real doc → `curl --resolve <slug>.docs.ace:443:192.168.1.18` returns 200 + title;
  from a tailnet device too; the driver self-verify (I3) returns 200+title before printing the URL.
- *Negative:* bogus slug → 404 (no dir listing / no other doc); path-traversal in slug rejected;
  collision mints a distinct slug.
- *Verify:* the curls above; a re-run reuses the slug.

### Phase 2 — brief publisher cutover (v1.0)
Ships: both brief `prompt.md` Step 7 → `--publisher ace` via the single default var (I7); inline
fallback (I3) verified against a SERVE-path break.
- *E2E:* run each brief (cleared PT-day lock) → posts a `<slug>.docs.ace` link that loads; then break the
  serve path (remove the Caddy route/cert) → self-verify fails → inline fallback posts; heartbeat
  `publisher: fallback`; no dead link.
- *Negative:* serve drift (mint-but-404) → fallback fires (B3 fix); no empty post, no dead link.
- *Verify:* live `hermes cron run` of each brief; posted link resolves; serve-break run confirms fallback.

### Phase 3 — X action buttons + endpoint (v1.0)
Ships: `/api/x/{like,unlike,bookmark,unbookmark}` (I1/I1x/I2/I5/I8) with the scoped token + button
injection in `html_report.ts` for X items.
- *Unit:* I1 gate (Origin + CSRF preflight + Host) before any action; action→X-API map; tweet_id regex;
  structured request (no shell); buttons only on `source:X` items with a parseable id; quote-tweets pin
  the primary id.
- *E2E (empirical, read-back):* tap ♥ on a real tweet in a served brief → the tweet is liked as
  `angalexg` (confirm via `GET /2/users/:id/liked_tweets`); tap 🔖 → in bookmarks; second tap undoes.
- *Negative (the real threat — B1):* (a) **forced-preflight** — `OPTIONS` from a disallowed origin
  WITHHOLDS ACAO/ACAH; (b) cross-origin POST (non-`docs.ace` Origin) → 403, **zero API calls** (spy); (c)
  missing `X-Docs-Ace-CSRF` → rejected; (d) forged Host → 403; (d2) **Origin-suffix bypass** —
  `https://evil-docs.ace.attacker.com` and `https://docs.ace.evil.com` → 403, zero call (proves the
  anchored check, not `endswith`); (e) `action=post`/`follow` → 404/400, zero call; (f)
  `tweet_id="1; rm"` / `abc` → 400, zero call; (g) off-network → refused (I1d); (h)
  stored-XSS payload in a brief renders inert (I1x); (i) no token in any served byte/log.
- *Verify:* the tap→read-back; the preflight/cross-origin/CSRF/host/verb/injection tests each with a spy
  showing zero API calls on bad input, one on the legit call; XSS battery green.

### Phase 4 — docs.ace portal: cards + FULL-TEXT search (v1.0)
Ships: the `docs.ace` portal (house-kit UI) listing all docs with auto-derived metadata + an FTS index
over bodies (D-13, I9).
- *Unit:* publishing N docs indexes them with zero manual metadata; the index file is not in any here.now
  manifest (I9).
- *E2E:* `curl docs.ace` → dashboard with cards + search; a **body-phrase** query (e.g. "GLM-5.2") returns
  the correct dated brief; a title query works too.
- *Negative:* XSS battery over hostile title/description/body stays escaped (I1x); a search query with
  markup can't inject.
- *Verify:* the body-phrase query returns the right doc link; XSS battery green.

### Phase 5 — portal actions: Share (button-stripped), Revoke, Delete (v1.0)
Ships: per-doc Share → button-stripped here.now copy → URL (I6/I4/D-17); Revoke-share → here.now DELETE;
Delete → soft-delete local (I10).
- *Unit:* Share invokes `herenow` on exactly one doc; the stripped copy has NO `/api/x/*` / no
  `X-Docs-Ace-CSRF` (I4); a privacy-scan runs before publish.
- *E2E:* click Share on a served brief → a public here.now URL loads the same content **with dead/removed
  buttons** (tapping does nothing / is a viewer-intent link, never acts as Ace); Revoke → the here.now
  URL 404s; Delete → the local `<slug>.docs.ace` 404s, adjacent docs still serve.
- *Negative:* the daily cron path never triggers Share (grep + a run shows no here.now publish, I6); a
  **cross-origin** delete/revoke/share → 403, no effect (I10); the shared copy cannot act as Ace (fetch
  `/api/x/like` on the here.now origin → 404 / blocked).
- *Verify:* the Share→load→revoke cycle; the stripped-copy button is inert; cross-origin destructive call
  blocked.

### Phase 6 — flip doc-share default to docs.ace (v1.1 — own review, first edit to the shared doc-share path)
Ships: `doc-share`'s default publisher → `ace` (I7/I11); `herenow` stays an explicit option.
- *Unit:* the default is `ace` in one place; `--publisher herenow` still returns a here.now URL.
- *E2E:* each known doc-share caller (prd-share, ad-hoc share, brief crons) returns a `<slug>.docs.ace`
  URL that loads; a `herenow` opt-in returns a working here.now URL.
- *Negative:* no caller hardcodes a competing default (grep, I7); a caller that passed no publisher gets
  the new default and still works (I11).
- *Verify:* a smoke over each caller; the default grep.

---

## 7. Security, Privacy, Ops, Observability

- **Credentials + token lifecycle:** the scoped `docs-ace-buttons` token is held in a **local 0600
  mirror** seeded from 1Password (I2), refreshed under a **cross-process `flock`** with persist-and-verify
  before serving; `trust.ace` CA signs the wildcard cert; no secret in any served OR shared byte.
  **Launchd token-bootstrap gate (pass-1/2):**
  the endpoint's startup asserts it holds a **VALID** token before binding — a cheap live probe
  (`GET /2/users/me` succeeds), NOT mere presence, because a stale-but-present token after a failed
  write-back (I2) would pass a presence check and then serve 403s all morning. Fail loud on invalid/absent.
- **Cert renewal (pass-1):** the single `*.docs.ace` wildcard leaf gates every slug + the portal, so
  expiry = a total-HTTPS outage. Reuse the fleet's per-name leaf-issuance discipline
  (`issue-*-leaf.sh`: CA key in a 600 temp file, pubkey-match guard, openssl-verify, idempotent
  reissue-if-<30d) as `issue-docs-ace-leaf.sh` under a scheduled renewal + a **pre-expiry canary** (alerts
  N days before the leaf expires) + the `.ace` fleet cert-SAN canary already covering `.ace` names.
- **Public surface:** none by default. `*.docs.ace`/`docs.ace` are LAN+tailnet only; the endpoint binds
  those interfaces only (I1). Public exposure only via explicit per-doc Share (I6), which publishes a
  **button-stripped static copy** (no endpoint, no token) to here.now.
- **Rate limit (pass-1/2, concrete):** the endpoint caps X-action writes at **≤10 actions / 60s** via a
  token-bucket, keyed **per-device** (by a device cookie/identifier) so a runaway loop on one device
  can't throttle Ace's other devices — with a global ceiling as a backstop. A forged flood hits the cap
  (429) well below X's own write limits and cannot touch the ingest read budget (I8). Named constants,
  tested with a burst. *(Single-legit-origin means the per-origin bucket alone would be one shared bucket
  — per-device keying is the fix.)*
- **Failure alerts:** the brief retry-wrapper/safety-net page #alerts on terminal failure; add a `.ace`
  canary for `docs.ace`/`*.docs.ace`; a **token-health canary** (cheap read; alerts if the scoped token
  silently expired); a **cross-origin-preflight canary** (fires an `OPTIONS` from a disallowed origin,
  alerts LOUD if it's ever *allowed* — guards against a CORS misconfig silently reopening B1); the
  **cert pre-expiry canary** above; and a **4-way name-agreement check** (AGH rewrite ↔ Caddy route ↔
  cert SAN ↔ CA) for `*.docs.ace`, a class this fleet has hit before.
- **Observability:** the publisher records driver (`ace`/`fallback`) in the heartbeat; the endpoint logs
  action+tweet_id+result (never the token). Residual (not v1.0-solved): no reconciliation of actions vs
  intent, so a fat-finger like is undetectable — a future item, acceptable given the CSP hardening (I1x).
- **Rollback:** flip `--publisher herenow` (one line) to revert delivery to here.now; buttons are additive
  (remove injection); DNS/cert/Caddy rows reversible.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Shared here.now copy lets a stranger act as Ace on X** (the Ace-raised question) | I4/D-17: the copy has the X buttons STRIPPED (or swapped for viewer-session intent links); the endpoint is same-origin + Origin/CSRF/Host-gated so a here.now origin gets 404/403 — a copy can NEVER act as Ace. Phase-5 negative proves it. |
| On-network cross-origin action forgery / CSRF / DNS-rebind (B1) | Origin + forced-preflight (load-bearing) + Host pinning (I1); Phase-3 tests the preflight-withheld + zero-call cases |
| Mint-but-404 posts a dead brief link (B3) | `ace` driver self-verifies (200+title) before success → else inline fallback (I3); Phase-2 tests a serve-path break |
| Static host down → portal/links 404 (full cutover) | launchd KeepAlive + `.ace` canary (D-9) + inline fallback (I3) |
| Full-text index leaks a private doc body into a shared copy | I9: the index lives ONLY on docs.ace, never in a here.now manifest; Phase-4 asserts |
| Delete/revoke hits the wrong doc or is irreversible | I10: single-doc scoped, soft-delete (trash) local, here.now DELETE by exact slug; cross-origin destructive call → 403 |
| Token lacks write scope | DONE (Phase-0): scoped token proven like/bookmark 200, POST 403 |
| Write actions starve ingest budget | I8: SEPARATE app/token (done) + rate cap |
| here.now `DELETE` for revoke unproven | HARD Phase-0-exit gate: verify on a throwaway slug (gates BOTH revoke AND the I10 marker-fallback) before Phase 5 starts |
| doc-share default flip breaks a caller | I11: Phase-6 smokes every caller; `herenow` stays reachable; own review |
| Quote-tweet: which id acts? | pin PRIMARY (Phase-3 unit) |

---

## 9. Open Questions

- **OQ1 — Index tech: sqlite FTS5 vs a JSON inverted-index.** FTS5 is robust + fast + built into
  Python's sqlite3; a JSON index is dependency-free but hand-rolled. *Lean FTS5* (Phase-4 build detail).
- **OQ2 — docs-host + docs-portal: one process or two?** One process is simpler (shared index access, one
  launchd job); two isolates the public-facing per-doc host from the action-bearing portal. *Lean one
  process, two route groups* (the button fetch must be same-origin with the served doc anyway).
- **OQ3 — Shared-copy affordance: pure strip vs strip+viewer-intent-link.** Strip is safest/simplest;
  the viewer-intent link is a nice-to-have. *Default strip; add intent links only if Ace wants them
  later* (D-17).
- **OQ4 — Read-surface broadening (pass-1 residual — Ace-acknowledged decision).** Full cutover routes
  EVERY doc-share artifact (PRDs, reports, possibly-sensitive docs) into a **no-login, FTS-searchable**
  portal readable by any LAN/tailnet device — the portal enumerates all slugs, so "unguessable slug =
  defense-in-depth" (D-4) is weaker once D-14 (no login) + D-13 (searchable list) expose the whole
  catalog. This is a genuine broadening vs the status-quo (obscure per-doc here.now URLs, never listed).
  Ace chose D-14 (no login, network-identity = auth) knowingly; **the residual to confirm is the tailnet
  ACL scope** — i.e. exactly which tailnet devices/users can reach `docs.ace` (Ace's own devices only, or
  a wider tailnet?). *Recommend: confirm the tailnet ACL limits `docs.ace` to Ace's own nodes; if the
  tailnet ever includes shared/other-user nodes, revisit a portal PIN for the sensitive doc types. Not
  blocking v1.0 (briefs-only) — becomes load-bearing at the v1.1 doc-share cutover when PRDs/reports land
  in the portal.*

---

## 10. Acceptance Criteria

- [ ] A published doc loads at `https://<slug>.docs.ace/` over trusted HTTPS on LAN + tailnet, and the
  `ace` publisher self-verified it before returning. Evidence: Phase-1 curl + self-verify log.
- [ ] Both briefs post a `<slug>.docs.ace` link via `ace`; a serve-path break makes them post the inline
  fallback (never empty, never dead). Evidence: Phase-2 live + serve-break runs.
- [ ] Tapping ♥/🔖 on an X item likes/bookmarks it on Ace's account, verified by read-back. Evidence:
  Phase-3 E2E.
- [ ] On-network cross-origin forgery is blocked: a non-`docs.ace` Origin / missing CSRF header / forged
  Host → 0 API calls + 403; the `OPTIONS` preflight is WITHHELD ACAO/ACAH. Evidence: Phase-3 negatives +
  spy.
- [ ] The scoped token cannot post/delete/DM. Evidence: Phase-0 `POST /2/tweets` → 403 (done).
- [ ] `docs.ace` lists all docs as cards and full-text search finds a doc by a **body** phrase. Evidence:
  Phase-4 E2E.
- [ ] Share publishes a **button-stripped** copy to here.now (buttons inert, cannot act as Ace) and
  returns a URL; Revoke-share 404s it; Delete removes the local doc. Evidence: Phase-5 E2E + negatives.
- [ ] No token appears in any served OR shared byte/log. Evidence: I2 grep.
- [ ] After the v1.1 flip, every doc-share caller returns a working `<slug>.docs.ace` URL and `herenow`
  stays selectable. Evidence: Phase-6 smoke. *(v1.1)*

---

## Roadmap

| Version | What ships | Trigger | Phases |
|---|---|---|---|
| **v1.0** | docs-host + `ace` publisher + brief cutover + X buttons + portal(cards+FTS) + Share/Revoke/Delete | now | Phases 1–5 |
| v1.1 | flip `doc-share` default → docs.ace (here.now stays opt-in) | v1.0 stable ~1 wk | Phase 6 |
| Future | viewer-intent links on shared copies; persistent liked/bookmarked state; thumbnails/tags | concrete need | — |

---

## Carried-forward artifacts (unchanged, still valid)

- **PHASE-0 GROUND-TRUTH** and **OQ-P0 (Option-B scoped token)** from PRD v0.3 remain valid verbatim —
  the serving substrate, cert mintability, DNS, and the minted/proven `docs-ace-buttons` token don't
  change under the docs.ace unification. See the v0.3 doc's Phase-0 + OQ-P0 sections (same git file
  history) for the raw probe evidence. Net: **Phase-0 is DONE; the token is DONE and proven.**
- **Review history:** PRD v0.3 went BLOCK → APPROVE-WITH-CHANGES (2 Opus passes) on the same trust
  boundary (B1/B2/B3) that this v1.0 carries forward unchanged. This v1.0 adds the portal/share/delete/
  doc-share surface, which needs its own review pass.

---

## Review Log

### Pass 1 (Opus, claude-bpp) — Verdict: APPROVE WITH CHANGES → folded to v1.1
No BLOCK (the carried-forward trust boundary I1/I1x/I5 held). Three blockers + 5 required changes, all in
the NEW surface (token lifecycle, share/portal), all folded:

- **B1 — rotating refresh token unspecified → silent lockout.** X `offline.access` refresh tokens are
  single-use/rotating; "refresh on 401" never said where the rotated token is written back → concurrent
  double-refresh lockout OR stale re-read on restart. **Fold: I2** now mandates a refresh MUTEX + atomic
  write-back of the rotated token to the 1Password SoT, re-read on restart; closeout proves both the
  double-401 and restart cases.
- **B2 — share→slug mapping durability → un-revocable public share.** If the mapping isn't durably stored,
  a restart orphans it → "public stays public" (the exact privacy failure to prevent). **Fold: I10** now
  persists the mapping in the D-12 index + a revoke-by-listing fallback (`GET /api/v1/publishes`); closeout
  proves revoke works after wiping the local mapping.
- **B3 — D-11 slug determinism contradicted the Phase-1 collision negative.** **Fold: D-11** now specifies
  an exact seed+salt-escalation function — retry is byte-deterministic (reuses slug), a true cross-identity
  hash-collision salt-escalates to a distinct slug (never overwrites), binding persisted in the index.
- **RC1 CSP:** **I1x** now requires `script-src 'self' 'nonce-…'` (no inline/eval) on every `*.docs.ace`
  response — turns a stored-XSS regression from act-as-Ace into a blocked script (defense-in-depth that
  doesn't rely on escaping being perfect forever). Verified via headless-browser load, not just grep.
- **RC2 cert renewal:** §7 now specifies `issue-docs-ace-leaf.sh` (fleet leaf-issuance discipline) +
  scheduled renewal + pre-expiry canary + the 4-way name-agreement check (AGH↔Caddy↔SAN↔CA).
- **RC3 launchd token bootstrap:** §7 makes "endpoint holds a live token at startup" an asserted
  launch-contract check (Phase-3), failing loud rather than serving tokenless (the documented op/launchd
  footgun).
- **RC4 rate limit concrete:** §7 sets ≤10 actions/60s/origin token-bucket → 429, tested with a burst.
- **RC5 DOM-parse strip:** §5.4 strips buttons via a DOM parse (not regex), with the I4 grep-for-`/api/x/`
  on the published copy as the real assertion; origin check (not the strip) remains the load-bearing guard.
- **Residual → OQ4:** the no-login FTS portal broadens the read surface (all doc bodies searchable by any
  LAN/tailnet device). Ace chose D-14 knowingly; OQ4 flags the tailnet-ACL-scope confirmation, load-bearing
  at the v1.1 doc-share cutover (when PRDs/reports land), not v1.0 (briefs-only).

Version bumped v1.0 → v1.1.

### Pass 2 (Opus, claude-bpp) — Verdict: APPROVE WITH CHANGES → converged, all folded to v1.2
Confirmed the pass-1 folds are real; caught three sharp second-order issues (all pin-the-mechanism, no
redesign), all folded:
- **B1 deeper — refresh write-back failure window + wrong atomic primitive.** X invalidates the old
  refresh token the instant the new one issues; if write-back then fails, the only valid token is in
  memory → restart loses it. And "temp-write+rename on a 1Password *item*" is a category error (`op item
  edit` is a remote PATCH, not atomic). Fold: I2 now uses a **cross-process `flock`** (covers a launchd
  graceful restart, which an in-process mutex doesn't), a **local 0600 file mirror** as the atomic
  hot-path SoT (1Password = seed/backup, not per-refresh), **persist-and-VERIFY before serving**, and a
  **loud alert on write-back failure**.
- **CSP nonce contradicted I4's static property.** A per-response nonce = non-static bytes. Fold: I1x
  switches to a **`'sha256-<buttonjs-hash>'`** source (button JS is fixed/known), and specifies the FULL
  policy so tweet media (`img-src pbs.twimg.com`) + house theme (`style-src 'unsafe-inline'`) don't
  silently break; CSP added to the 4-way config-drift surface.
- **B3 — `doc_identity_key` was undefined** (its definition decides whether retry-reuse works). Fold:
  D-11 pins it per doc-type: briefs=`(brief_name, PT_date)`, PRDs=stable path/id, ad-hoc=source path/`--doc-id`.
Plus the required changes: I10 embeds a deterministic `docs-ace-id` meta marker for the revoke fallback
(not fuzzy title); D-12 states the store's durability posture (backed up, binding rows survive HTML
pruning — three invariants depend on it); the here.now DELETE is elevated to a **hard Phase-0-exit gate**
before Phase 5; the launch-contract check probes token **validity** (`GET /2/users/me`) not presence; the
rate limit is keyed **per-device**. OQ4 (read-surface / tailnet-ACL) carried unchanged, load-bearing at
v1.1. Version bumped v1.1 → v1.2. **Converged: APPROVE-WITH-CHANGES with every change folded in-spec, no
open blockers.**

### Self-review tightening pass (Fable-5, fresh model over the converged spec)
Ace switched the model and asked for a fresh critical pass. A converged spec accumulates *partial-edit
staleness* — the two Opus passes each fixed their own deltas but left older lines that those deltas
contradicted. Eight fixes, no redesign:

**Correctness contradictions (stale lines the folds left behind):**
- **A/§7** — the credentials line still described the pass-1 "mutex + atomic write-back to 1Password";
  rewritten to match the folded I2 (local 0600 mirror + cross-process `flock` + verify-before-serve).
- **B/§5.3** — still said the token is "read from 1Password at process start"; corrected to the I2 local
  mirror SoT.
- **C/§2** — Non-Goals claimed "portal is v1.2" while the Roadmap ships the portal + Share/Revoke/Delete in
  **v1.0 Phases 1–5**; reconciled to v1.0 with an intra-version sequencing note.
- **D/§8** — the here.now-`DELETE` risk row still called it an unproven "residual"; pass-2 had elevated it
  to a **hard Phase-0-exit gate** — row updated to match.

**Real gaps neither Opus pass caught:**
- **E/I1 (the important one)** — the Origin allow-list was written as `https://<slug>.docs.ace`, but slugs
  are unbounded so it must be a PATTERN match — and a naive `endswith(".docs.ace")` would let
  **`evil-docs.ace.attacker.com` pass the load-bearing Origin gate**. Tightened to a strict anchored
  suffix+shape check (scheme=https, host ends in `.docs.ace`, exactly one leading label, no port/userinfo)
  + specified CORS reflects the Origin only on that same check (never `*`).
- **F/Phase-3** — added the matching negative test (`evil-docs.ace.attacker.com` / `docs.ace.evil.com` →
  403, zero call) so the anchored check is proven, not assumed.

**Tightenings:**
- **G/I3** — self-verify checked "200 + title", which a stale/other doc served at 200 with a generic title
  could pass; tightened to a **per-publish content marker** (the `docs-ace-id` meta) so mint-but-WRONG-
  content is caught, not just mint-but-404.
- **H/D-11** — noted that a same-day brief *replace* makes an already-published here.now share stale
  (acceptable + documented; re-Share overwrites, Revoke still works via the I10 marker).

Version bumped v1.2 → v1.3. Still no open blockers; these are correctness/coverage tightenings the
convergence loop structurally tends to miss (each pass optimizes its own diff, not the whole).
