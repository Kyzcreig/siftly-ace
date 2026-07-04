# PRD — `docs.ace`: a local here.now clone (unified doc portal, in-page X actions, share-to-here.now)

**Status:** DRAFT v1.0 — supersedes PRD v0.3 (`*.brief.ace`); pre-review. Carries forward the v0.3 Phase-0 ground-truth + the minted Option-B scoped token (both unchanged and still valid).
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
- **v1.0 (this cut) explicitly does NOT:** migrate every doc-share caller to docs.ace on day one
  (v1.1 flips the default); implement the full portal delete/revoke UI before the host + briefs are
  proven (portal is v1.2). v1.0 = host + `<slug>.docs.ace` serving + brief cutover + X buttons +
  share-copy.

---

## 3. Constitution / Invariants

*(I1, I1x, I2, I3, I5, I8 carry over from v0.3 essentially unchanged — the trust boundary didn't move.
I4, I6, I7 are updated for the docs.ace unification. I9–I11 are new for the portal/share/doc-share.)*

- **Invariant I1 — X actions require ORIGIN-authorized, CSRF-preflight-protected requests, not just
  network reachability.** The `/api/x/*` endpoint's credential is the server-side scoped token (not a
  browser cookie), so reachability alone is a confused-deputy hole. Before any action it enforces, and
  proceeds ONLY if all pass: (a) **Origin/Referer** must match `https://<slug>.docs.ace` (server-side
  filter; a non-browser client can forge this, so it's not the load-bearing control — see (b)); (b) **a
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

- **Invariant I1x — the render's XSS-escaping is load-bearing for the action endpoint.** The endpoint is
  same-origin with served docs, so any script executing inside a `*.docs.ace` page passes the I1 gate.
  Doc content is untrusted (tweet text, overview prose, handles), so `html_report.ts` + the portal
  generator's XSS-escaping is a **security dependency** of the endpoint — a stored-XSS regression becomes
  an act-as-Ace self-forge.
  - *Closeout proof:* the render/portal XSS battery stays green, tagged as guarding the endpoint; a
    hostile tweet/overview/title payload renders inert.

- **Invariant I2 — the scoped X token never leaves Mac Studio.** No X access/refresh token is copied to
  here.now variables, embedded in ANY served or shared HTML, or logged. Served pages call a *relative*
  path; the token lives in 1Password/on-box and is read only by the endpoint process.
  - *Closeout proof:* `grep -ri "bearer\|oauth\|token" <served_html> <shared_copy_html>` returns nothing;
    the button's `fetch()` target is relative `/api/x/...`.

- **Invariant I3 — the briefs never fail to deliver, and never post a DEAD link.** The `ace` publisher
  self-verifies its own minted URL (HTTP 200 + expected `<title>`) BEFORE returning success; a
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

- **Invariant I10 — delete/revoke are the only destructive portal actions and both fail safe.** A local
  **delete** removes the doc's served files + index entry (trash/soft-delete, not an irreversible
  `rm -rf`); **revoke-share** deletes the here.now copy via the here.now API. Neither can touch a doc
  other than the one targeted; both require an explicit same-origin (I1-gated) request.
  - *Closeout proof:* delete removes exactly one slug's files (adjacent docs untouched); revoke deletes
    exactly one here.now site; a cross-origin delete/revoke → 403, no effect.

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
- **D-11 — Slug deterministic per (doc identity); a cron retry of the same brief/date REUSES the slug**
  (keeps a posted #daily link alive). *(v0.3.)*
- **D-12 — Archive retention:** keep N days on disk (default 90) for direct reach; the portal indexes
  full history from a compact metadata store even after raw HTML is pruned. *(v0.3.)*
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
`docs-ace-buttons` token** (read from 1Password at process start; refreshed via refresh_token on 401).
tweet_id validated `^\d{5,25}$`; request built as structured params (no shell). Quote-tweets pin the
PRIMARY tweet_id. Rate-limited (I8); audit log records action+tweet_id+result, never the token.
**Ground-truthed working X v2 calls (Phase-0):** `POST /2/users/56282605/likes {tweet_id}` /
`DELETE …/likes/:id`; bookmarks analogous; `POST /2/tweets` → 403 (scope proof).

### 5.4 Share (I6, I4, D-7, D-17)
The portal Share action: (1) load the doc's stored HTML; (2) produce a **button-stripped variant** —
remove the `/api/x/*` button block (and its script), optionally inject `intent/like?tweet_id=` viewer-
session links; (3) run `doc-share here-now.sh` on that variant → a fresh here.now slug; (4) return the
URL (clipboard + new tab); (5) record the here.now slug against the doc so **revoke-share** can
`DELETE /api/v1/publish/<slug>`. A privacy-scan (`doc-share/privacy-scan.sh`) runs before publish.

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
surface reverse-engineered (list/detail/metadata/delete via the live API key). *One residual to confirm
at build: the here.now `DELETE /api/v1/publish/<slug>` for revoke-share (documented; verify live on a
throwaway slug).*

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
  missing `X-Docs-Ace-CSRF` → rejected; (d) forged Host → 403; (e) `action=post`/`follow` → 404/400, zero
  call; (f) `tweet_id="1; rm"` / `abc` → 400, zero call; (g) off-network → refused (I1d); (h)
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

- **Credentials:** the scoped `docs-ace-buttons` token stays in 1Password/on-box (I2), auto-refreshes;
  `trust.ace` CA signs the wildcard cert; no secret in any served OR shared byte.
- **Public surface:** none by default. `*.docs.ace`/`docs.ace` are LAN+tailnet only; the endpoint binds
  those interfaces only (I1). Public exposure only via explicit per-doc Share (I6), which publishes a
  **button-stripped static copy** (no endpoint, no token) to here.now.
- **Failure alerts:** the brief retry-wrapper/safety-net page #alerts on terminal failure; add a `.ace`
  canary for `docs.ace`/`*.docs.ace`; a **token-health canary** (cheap read; alerts if the scoped token
  silently expired before the buttons 403 all morning); a **cross-origin-preflight canary** (fires an
  `OPTIONS` from a disallowed origin, alerts LOUD if it's ever *allowed* — guards against a CORS
  misconfig silently reopening B1).
- **Observability:** the publisher records driver (`ace`/`fallback`) in the heartbeat; the endpoint logs
  action+tweet_id+result (never the token). Residual (not v1.0-solved): no reconciliation of actions vs
  intent, so a fat-finger like is undetectable — an anomaly/review affordance is a future item.
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
| here.now `DELETE` for revoke unproven | Phase-0 residual: verify on a throwaway slug before Phase 5 |
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
