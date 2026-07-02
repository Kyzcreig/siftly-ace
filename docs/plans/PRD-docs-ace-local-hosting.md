# PRD — `docs.ace`: a local here.now clone for briefs & docs (with in-page X actions + optional public share)

**Status:** APPROVED v0.3 — 2 review passes converged (pass-1 BLOCK → pass-2 APPROVE-WITH-CHANGES, all folded). Ready for Phase-0 build gate.
**Author:** Apollo
**Date:** 2026-07-02
**Owner:** Apollo (Mac Studio host)
**Related:** `news-digest-cron-pipeline`, `ace-dashboard-portal-generators`, `local-dns`, `dns-block-portal-frontdoor`, `doc-share`, `xurl`, `acceptance-gate-proves-proxy-not-effect`

---

## 1. Summary & Goal

Replace here.now as the **default host** for the daily briefs with a locally-run, here.now-style
document host on Mac Studio, reachable at `*.brief.ace` (home) and served by the existing Caddy `.ace`
front door. The host — `docs.ace` — lists and **full-text-searches** every brief and shared doc
(the internal here.now analogue), renders each as a dark self-contained page, and adds two capabilities
the public here.now host structurally could not give us:

1. **In-page X actions** — Like ♥ and Bookmark 🔖 buttons on every X-sourced item in a brief, acting
   **as Ace's own X account** via a same-origin local endpoint (`xurl`). This closes a data
   flywheel: liking/bookmarking from the brief feeds the very bookmark/like corpus that `pf-score.py`
   and the preference profile learn from, improving future ranking.
2. **Optional public share** — a per-doc "Share" action on `docs.ace` that publishes a *copy* of that
   one static page to real here.now and hands back a public URL (clipboard + new tab). Private by
   default; public per-doc on demand; revocable.

**Why now:** Ace reads the briefs on his phone (on the tailnet) and wants to act on tweets inline;
here.now can't run authenticated X actions from a static page without exposing a token or a proxy, and
its slug URLs are public. A local host solves auth (network-identity), privacy (LAN/tailnet only),
the action flywheel, and a searchable internal archive in one stack — while keeping public sharing as
an explicit, opt-in projection back onto here.now.

**North-star framing:** `docs.ace` is "here.now, but ours, internal-first." The briefs are its first
content type; any doc-share HTML artifact is its second. This PRD ships the **full vision as the
contract** and a **v0.1 cut** (§0.9) that is the smallest useful slice.

---

## 2. Non-Goals

- **NOT** a here.now feature-clone (no Drives, no custom domains, no multi-tenant accounts, no
  analytics dashboards). We clone exactly: static hosting + unguessable slug URLs + a searchable index.
- **NOT** public-by-default. Every `docs.ace` page is LAN/tailnet-only unless explicitly shared.
- **NOT** a general web CMS or editor. `docs.ace` indexes/serves artifacts other pipelines produce; it
  does not author them.
- **NOT** a new pricing/scoring/rendering path for the briefs. Scoring, selection, overview, and the
  `html_report.ts` render are untouched — only the *publish/delivery* step and *button injection* change.
- **NOT** exposing the X-action endpoint to the public internet or to here.now. It listens on
  LAN + tailnet interfaces only, forever.
- **NOT** web-intent likes (visitor-session). Actions run as *Ace's account* (required for the corpus
  flywheel) — decided in the design conversation.
- **v0.1 explicitly does NOT:** implement the public "Share" button (§roadmap v0.3), implement `docs.ace`
  full-text search UI (v0.2), or index arbitrary doc-share artifacts (v0.2). v0.1 = serving + cutover +
  X action buttons.

---

## 3. Constitution / Invariants

- **Invariant I1 — X actions require ORIGIN-authorized, CSRF-preflight-protected requests, not just
  network reachability.** Reaching the socket is necessary but NOT sufficient. Because the endpoint's
  credential is the server-side `~/.xurl` token (not a browser cookie), reachability alone is a
  confused-deputy hole: any tab open in Ace's browser on his network could otherwise fire a cross-origin
  `fetch` whose *side-effect lands as Ace*. The endpoint enforces, before any spawn, and spawns `xurl`
  ONLY if all pass: (a) **Origin/Referer allow-list** — must match `https://*.brief.ace` (server-side
  filter; note a non-browser client can forge this header, so it is NOT the load-bearing control — see
  (b)). (b) **A forced CORS preflight — THE load-bearing browser control.** The endpoint requires a
  non-simple custom header `X-Docs-Ace-CSRF: 1`; because that header makes the request non-simple, a real
  browser MUST send an `OPTIONS` preflight first, and the endpoint's CORS response **withholds
  `Access-Control-Allow-Origin`/`-Headers` for any non-`brief.ace` origin**, so the browser blocks the
  real POST. This is the only control a hostile *browser tab* genuinely cannot bypass; a curl-with-forged-
  Origin only tests (a). **`X-Docs-Ace-CSRF: 1` is a preflight-forcing MARKER, not a secret token** — its
  protective value is solely that a custom header forces the preflight; do NOT "harden" it by making it a
  guessable-but-static pseudo-secret (that adds no entropy). If real per-session CSRF-token semantics are
  ever wanted, mint a per-page nonce (out of v0.1 scope; the marker is sufficient for this blast radius).
  (c) **Host pinning** — reject any request whose `Host` isn't a `*.brief.ace` name (blocks a DNS-rebind
  hit on the raw `PORT_A` LAN IP). (d) The network bind (LAN+tailnet only, no public route) remains
  defense-in-depth, NOT the primary auth.
  - *Why:* the endpoint acts as Ace on X; a malicious on-network tab, malvertising, or DNS-rebind must
    not be able to like/unlike/bookmark/unbookmark as him (which would silently poison the `pf-score.py`
    corpus per D-2).
  - *Closeout proof (two distinct tests — don't conflate them):* **(I1-preflight, the real gate)** an
    actual `OPTIONS` preflight from a disallowed origin gets a response that WITHHOLDS the
    `Access-Control-Allow-Origin`/`-Headers` (so a browser would block the follow-up POST); **(I1-origin)**
    a POST with a forged non-`brief.ace` Origin → 403 with **zero `xurl` spawns** (process-spy); a POST
    without the `X-Docs-Ace-CSRF` header → rejected; a forged `Host` → 403; a legitimate same-origin call
    from a brief page → 1 spawn. Implementing Origin-check-only would pass I1-origin but FAIL I1-preflight
    — that's why both exist.

- **Invariant I1x — the render's XSS-escaping is load-bearing for the action endpoint (same-origin
  co-location dependency).** Because the `/api/x/*` endpoint is same-process/same-origin with the served
  brief pages (OQ2), ANY script that executes *inside* a `*.brief.ace` page passes the I1 gate trivially.
  Brief content is untrusted (tweet text, overview prose, handles); therefore `html_report.ts`'s existing
  XSS-escaping is now a **security dependency of the action endpoint**, not just a cosmetic concern — a
  stored-XSS regression in a brief page becomes an act-as-Ace self-forge. The injected button JS is the
  ONLY intended same-origin script.
  - *Closeout proof:* the render's XSS battery (inherit the portal/`html_report` escaping tests) stays
    green and is explicitly tagged as guarding the action endpoint; a hostile tweet-text/overview payload
    (script/attr-breakout) renders inert; a grep confirms brief-embedded content is escaped before it
    reaches the served page. Weakening the escaping must fail this test.

- **Invariant I2 — the X token never leaves Mac Studio.** No X access/refresh token is copied to
  here.now variables, embedded in any served HTML, or logged. The served page calls a *relative* path;
  `xurl`'s `~/.xurl` token stays on-box and auto-refreshes.
  - *Closeout proof:* `grep -ri "bearer\|oauth\|token\|xurl" <served_html>` returns nothing; the
    proxy/here.now path carries no X credential; the button's `fetch()` target is a relative `/api/x/...`.

- **Invariant I3 — the briefs never fail to deliver, and never post a DEAD link.** The `ace` publisher
  must **self-verify its own minted URL** (HTTP 200 + expected `<title>`) BEFORE returning success; a
  mint-but-unreachable result (DNS/Caddy/cert/wildcard drift) is treated as a publisher FAILURE that
  falls through to the inline-render post to #daily (the existing fail-safe). So #daily is never empty
  AND never carries a dead `*.brief.ace` link.
  - *Why:* a returned URL after merely *writing a file* is not proof the link works; full cutover (D-3)
    would otherwise post a silent 404 every time serving drifts, with a green heartbeat.
  - *Closeout proof:* breaking the SERVE path (not just killing the process — e.g. remove the Caddy route
    or the cert) and running a brief still posts a working brief to #daily via inline fallback; the
    heartbeat records `publisher: fallback`; no dead link is ever posted.

- **Invariant I4 — the served brief page is a self-contained static file.** No here.now-only dependency;
  it renders identically from any static server. (Already true — `html_report.ts` build-time hydrates.)
  The ONLY dynamic calls are the injected same-origin `/api/x/*` button `fetch`es.
  - *Closeout proof:* `grep -c "fetch(\|here.now\|proxy" <brief_html>` counts only the injected
    `/api/x/*` same-origin calls; no absolute/off-origin fetch, no here.now reference.

- **Invariant I5 — the X endpoint verb allow-list is closed; blast radius is bounded even if authz
  fails.** The endpoint executes ONLY `like`/`unlike`/`bookmark`/`unbookmark` against a **numeric
  tweet_id parsed server-side** (`^\d{5,25}$`); it builds an **argv list** (never a shell string) from a
  fixed `{action → xurl subcommand}` map; it never posts/DMs/follows/deletes-tweets/reposts. Defense in
  depth: even a hypothetical authz bypass can only toggle a like/bookmark (fully reversible), never an
  irreversible or broadcast action.
  - *Why:* an injected/hostile request must not escalate to post-as-Ace or arbitrary `xurl`; and the
    worst-case forged action must be reversible.
  - *Closeout proof:* adversarial requests (`action=post`, `action=follow`, `tweet_id="1; rm -rf"`,
    `tweet_id=abc`) → 400/404 with **zero subprocess spawns** (process-spy); the argv is a list built
    from the fixed map; a scope probe confirms the token cannot post/DM/delete (I5-scope, Phase-0).

- **Invariant I6 — public share is opt-in, per-doc, and non-default.** No brief or doc is published to
  here.now unless the Share action is explicitly invoked on that one doc. The daily cron never publishes
  publicly.
  - *Closeout proof:* the cron path calls only the `ace` publisher; `grep` shows no here.now publish in
    the brief cron flow; the Share action is a separate, human-triggered code path (v0.3).

- **Invariant I7 — one publisher interface, swappable, no scoring/render coupling.** `build-report.sh`
  selects a publisher driver by parameter; each driver takes `(html, title, date, brief)` and returns a
  URL (and self-verifies per I3). Adding/removing a driver never touches scoring/selection/render code.
  There is a **single source of truth for the default publisher** (one variable in `build-report.sh`);
  the two `prompt.md`s and the two `deploy/cron-prompts/` snapshots pass the flag but do not each
  hardcode the default (avoids the 5-drift-site trap).
  - *Closeout proof:* `grep` shows the publisher dispatch is a single switch reading one default var; the
    `herenow` and `ace` drivers share the identical `(html,title,date,brief)→url` contract; flipping the
    default is a one-line change; no prompt/snapshot hardcodes a competing default.

- **Invariant I8 — X write-action budget is isolated from the ingest read budget.** Button writes and the
  daily bookmark/like INGEST share the same `siftly-ace` app/token; the endpoint rate-limits writes and
  the design confirms a button loop or forged flood cannot starve the ingest read budget or trip the
  credit-floor guard.
  - *Closeout proof:* the endpoint enforces a per-action rate cap (documented number); a burst test does
    not exhaust the app's read quota below the ingest floor; writes and reads are accounted separately in
    the audit log.

---

## 4. Resolved Decisions

- **D-1 — Host = Mac Studio.** Briefs, the `siftly-ace` X OAuth2 token (`siftly-ace` app, `angalexg`),
  and the existing `.ace`/Caddy front door all already live here. AI PC would require shipping the token
  for no benefit. *(Ace, confirmed.)*
- **D-2 — Both actions (Like + Bookmark), as Ace's account.** Both feed the bookmark/like corpus that
  drives `pf-score.py` + the preference profile → better future ranking. Web-intent (visitor-session)
  likes were rejected because they act as the *visitor*, not Ace, and never touch the corpus. *(Ace.)*
- **D-3 — Full cutover, no here.now fallback week.** Flip the default publisher to `ace` immediately;
  the inline-render fallback (I3) is the safety net, not a here.now week. *(Ace: "full cutover.")*
- **D-4 — URL scheme: `<two-random-words>.<yyyy-mm-dd>.<brief>.brief.ace`** (e.g.
  `ancient-plover.2026-07-02.x.brief.ace`, `…ai.brief.ace`). Wildcard `*.brief.ace` → Mac Studio;
  the server maps `slug.date.brief` → the dated file. Reuses the here.now two-word slug aesthetic; the
  unguessable slug is defense-in-depth even on-LAN; the date is human-readable and keeps old briefs
  addressable (the archive `docs.ace` indexes). *(Ace: "yes" to both scheme + slug aesthetic.)*
- **D-5 — Guard = ORIGIN/CSRF authorization for actions + network-identity for page reach (CORRECTED
  after pass-1).** Original framing ("reachability IS the auth") was WRONG for a state-changing endpoint:
  because the credential is the server-side xurl token (not a browser cookie), any on-network tab could
  forge a cross-origin action (pass-1 B1). Corrected: *page serving* uses network identity (LAN/tailnet
  reach); *the `/api/x/*` action endpoint* additionally requires an `Origin ∈ *.brief.ace` + a
  preflight-forcing `X-Docs-Ace-CSRF` header + `Host` pinning (I1), with the network bind as
  defense-in-depth only. No per-button PIN in v0.1 (blast radius is bounded to reversible like/bookmark by
  I5; revisit a PIN if Ace wants). *(Corrected per pass-1; the network-identity-only idea Ace accepted is
  retained for page reach, hardened for actions.)*
- **D-11 — Slug is deterministic per (brief, date) — a cron retry REUSES it.** So a re-run that replaces
  the day's brief keeps the already-posted #daily link alive rather than orphaning it. Collisions across
  different content mint a distinct slug. *(Added per pass-1 change-7.)*
- **D-12 — Archive retention.** Old dated briefs stay addressable (the "forever addressable" claim) under
  a bounded disk policy: keep N days on disk for direct `*.brief.ace` reach; `docs.ace` indexes the full
  history from a compact metadata store even after the raw HTML is pruned. Exact N is a build detail
  (default 90 days on-disk). *(Added per pass-1 change-7.)*
- **D-6 — `docs.ace` is the internal here.now clone; briefs are content type #1.** Search + list + view,
  with a per-doc Share→here.now button. Consolidates the earlier standalone "brief server" idea into one
  named portal. *(Ace: "maybe it's just called docs.ace, our here.now clone.")*
- **D-7 — Share publishes a COPY to real here.now** (reusing the existing `doc-share` `here-now.sh`
  backend), returns URL to clipboard + opens a new tab. Not a proxy-through-here.now (wrong direction,
  needs funnel). Revocable by deleting the here.now site. *(Ace: "generate share link button… publishes
  on here.now and copies a url / opens a new tab.")*
- **D-8 — here.now is NOT self-hostable.** Only its agent *skill* is open-source; the platform is closed
  SaaS. We clone the parts we use (static host + slugs + search) on infra we already run; we do NOT try
  to run here.now itself. *(Investigated this session.)*
- **D-9 — Reliability via launchd keepalive + canary.** Full cutover means a downed static server 404s
  the morning link; mitigated structurally by launchd `KeepAlive` + a `.ace` fleet canary (same pattern
  as other front doors). *(Ace: "yes that's fine.")*
- **D-10 — "already liked/bookmarked?" state is OUT of v0.1; buttons are optimistic but fail closed.** A
  persistent "already liked" indicator costs an X read per tweet per page-load — deferred. Buttons are
  optimistic (tap → ♥ fills / 🔖 fills), but on an endpoint error/`re-auth needed` the fill **reverts and
  shows a visible error state** (not a silent success) — so optimistic UI never masks a failed write.
  Undo via a second tap (unlike/unbookmark). *(Reconciled per pass-1 change-6.)*

---

## 5. Architecture / Design

### 5.1 Components

```
                          Mac Studio (.18 LAN / tailnet)
┌───────────────────────────────────────────────────────────────────────┐
│  Caddy (.ace front door, existing)                                      │
│    *.brief.ace  ──► brief static server (NEW)   :PORT_A                 │
│    docs.ace     ──► docs portal + search (NEW)  :PORT_B                 │
│                                                                         │
│  brief static server (:PORT_A)                                          │
│    • GET /<slug>.<date>.<brief>...  → serves briefs/<brief>/<date>/<slug>/index.html │
│    • POST /api/x/{like,unlike,bookmark,unbookmark}  → xurl (as Ace)     │
│        - bind: 127.0.0.1 + LAN + tailscale only (I1)                    │
│        - argv allow-list, tweet_id regex (I5)                           │
│                                                                         │
│  docs portal (:PORT_B)  [v0.2+]                                         │
│    • lists + FTS over the brief/doc archive                             │
│    • per-doc "Share" → doc-share here-now.sh → public URL (v0.3, I6)    │
└───────────────────────────────────────────────────────────────────────┘
        ▲                                   │
        │ HTTPS (trust.ace CA / wildcard)   │ xurl → X API (OAuth2 user, ~/.xurl, auto-refresh) (I2)
   Ace's browser (LAN or tailnet)           ▼
                                        api.x.com
```

### 5.2 Publisher abstraction (I7)
`build-report.sh` gains `--publisher {ace|herenow}` (default becomes `ace` at cutover). Each driver is a
small function/script with the contract `publish(html_path, title, date, brief) → prints URL`:
- `herenow` driver = today's behavior (doc-share → here.now), retained for the Share path and rollback.
- `ace` driver = writes `briefs/<brief>/<date>/<slug>/index.html` into the served webroot, mints the
  `<slug>.<date>.<brief>.brief.ace` URL, returns it. Slug = two random words (here.now-style list).

The brief cron `prompt.md` Step 7 changes only the publisher flag; the fail-safe inline fallback (I3)
is unchanged.

### 5.3 X-action button injection
`html_report.ts` (shared by both briefs) gains an optional per-item button row for items where
`source === "X"` and a numeric tweet_id is parseable from the item URL (`/status/(\d+)`). Buttons call
`fetch('/api/x/like', {method:'POST', body:{tweet_id}})` same-origin. Non-X items (HN/Reddit/GitHub)
get no buttons. Optimistic UI + toast; second tap = undo.

### 5.4 The X endpoint (the trust boundary — I1, I2, I5, I8)
A tiny local HTTP handler (same process as the static server, so the button `fetch` is same-origin):
- Binds LAN + tailnet only (I1d, defense-in-depth).
- **Authorization gate (I1), evaluated before any spawn:** (a) `Origin` (or `Referer` fallback) must
  match `https://*.brief.ace`; (b) a required custom header `X-Docs-Ace-CSRF: 1` (forces a CORS
  preflight only same-origin JS satisfies); (c) `Host` must be a `*.brief.ace` name. Any failure → 403,
  zero spawn. CORS is configured so the preflight ONLY succeeds for `*.brief.ace` origins.
- `POST /api/x/<action>` with `<action> ∈ {like,unlike,bookmark,unbookmark}` (fixed map to xurl
  subcommands); body `{tweet_id}` validated `^\d{5,25}$`.
- Spawns `xurl <subcommand> <tweet_id>` as an **argv list** (never a shell string), returns
  `{ok, action, tweet_id}` or a sanitized error. No other xurl surface reachable (I5).
- **Rate-limited** per-action (I8) so a loop/flood can't starve the ingest read budget; writes and reads
  logged separately (never the token) for a lightweight audit Ace can review.
- **Ground-truth (this session):** `xurl` DOES expose `like`/`unlike`/`bookmark`/`unbookmark <id>`
  subcommands (confirmed via `xurl --help`); auth works for reads as `angalexg`. What is NOT yet proven
  and MUST be a Phase-0 gate: that the `siftly-ace` OAuth2 token carries the **write** scopes
  (`like.write`, `bookmark.write`) — it was minted for bookmark/like *reads* — via ONE real
  like+unlike against a throwaway tweet, with Ace's go-ahead, failing closed to a re-auth flow on 403.

### 5.5 `docs.ace` portal (v0.2)
Built on the existing `ace-dashboard-portal-generators` house kit (search/filter/sort, dark theme,
mobile cards, XSS-escaped, DOM-read JS — no server-interpolated row data). Data source = the brief
archive (walk `briefs/**`) + optionally registered doc-share artifacts. FTS over titles/overview text.
Per-row "Share" button (v0.3) → `doc-share here-now.sh` on that page → public URL.

### 5.6 DNS / cert / serving
- Wildcard `*.brief.ace` + `docs.ace` AGH rewrites → Mac Studio `.18` (per `local-dns` /
  `dns-block-portal-frontdoor`).
- Wildcard cert for `*.brief.ace` from the `trust.ace` CA (already trusted on Ace's devices).
- Caddy routes `*.brief.ace`→:PORT_A, `docs.ace`→:PORT_B.
- Under launchd with `KeepAlive` (D-9) + a `.ace` canary row.

---

## 0.9 / §6. Implementation Phases

### Phase 0 — Ground-truth probe (BEFORE any build)
Confirm the serving substrate AND the write-capability the design assumes, because a wrong assumption
here reshapes phases 1–3:
- The exact Caddy config file + reload command on `.18`, and how existing `.ace` names are routed
  (reverse_proxy vs file_server) — the `ace` publisher + wildcard route slot into that pattern.
- Whether the `trust.ace` CA can mint a **wildcard** `*.brief.ace` cert (vs per-name) — decides D-4
  feasibility as-specced vs a fixed `x.brief.ace`/`ai.brief.ace` two-name fallback (OQ1).
- AGH wildcard-rewrite support for `*.brief.ace` (vs enumerating names).
- **X WRITE-SCOPE GATE (load-bearing, B2):** prove the `siftly-ace` OAuth2 token can actually WRITE, not
  just read. `xurl` subcommands exist (confirmed this session). Run — with Ace's explicit go-ahead — ONE
  real `xurl like <throwaway_id>` then `xurl unlike <throwaway_id>` and ONE `xurl bookmark`/`unbookmark`,
  and read them back. A 403/`Unsupported`/scope error here means the token lacks write scopes → Phase 3
  becomes a **re-consent/re-auth flow** (`xurl auth oauth2 --app siftly-ace`, out of session), NOT a
  build detail. Record the exact working argv (subcommand vs raw `/2/users/:id/likes` POST/DELETE) and
  fold it into §5.4.
- **I5-scope probe:** confirm the token CANNOT post/DM/delete-tweet (attempt is rejected) — defense in
  depth for I5, so a hypothetical authz bypass is bounded to reversible actions.
- **Verification:** a `PHASE-0-GROUND-TRUTH` block appended to this PRD recording each answer; any
  falsified assumption (no wildcard cert; no write scope) is folded into the design before Phase 1.
- *E2E:* the real like/unlike round-trip above. *Negative:* the post/DM/delete rejection. *Verify with:*
  the probe commands, results pasted into the PRD; a write that lands + reverts = write scope proven.

### Phase 1 — Brief static server + `ace` publisher + DNS/cert/Caddy (v0.1 core)
Ships: the static server serving `briefs/<brief>/<date>/<slug>/index.html` over `*.brief.ace` HTTPS; the
`ace` publisher driver (with I3 self-verify); wildcard DNS + cert + Caddy route; launchd keepalive + canary.
- *Unit/script check:* the `ace` publisher writes the file to the right path and returns a well-formed
  `<slug>.<date>.<brief>.brief.ace` URL; slug is two words from the list; **a retry of the same
  brief/date REUSES the slug** (idempotent — keeps a previously-posted #daily link alive; D-4/change-7).
- *E2E/integration check:* publish a real brief HTML via the `ace` driver, then
  `curl -sk --resolve <slug>.<date>.x.brief.ace:443:192.168.1.18 https://<...>/` returns the page
  (200, `<title>` matches); repeat from an on-tailnet device; **the driver's own self-verify (I3) returns
  200+title before it prints the URL.**
- *Negative/adversarial:* a request for a non-existent slug/date returns 404, not a directory listing or
  another day's file; path-traversal (`../`) in the slug is rejected; a slug collision mints a distinct
  slug (no overwrite of a different brief).
- *Verify with:* the curl above → 200 + correct title; a bogus slug → 404; a re-run reuses the slug.

### Phase 2 — Publisher cutover (v0.1)
Ships: both brief `prompt.md` Step 7 flipped to `--publisher ace` (full cutover, D-3) via the single
default var (I7); the inline fallback (I3) verified intact against a SERVE-path break, not just a killed
process.
- *Unit/script check:* Step 7 invokes the `ace` publisher; the Discord message links `…x.brief.ace`; the
  default lives in ONE place (I7 grep).
- *E2E:* run each brief end-to-end (cleared PT-day lock) → posts a `*.brief.ace` link to #daily that
  loads. Then **break the SERVE path (remove the Caddy route / cert), not just kill the process,** and
  re-run → the `ace` driver's self-verify fails → posts the inline fallback brief (I3 holds); heartbeat
  says `publisher: fallback`. **No dead link is ever posted.**
- *Negative/adversarial:* serve-path drift (mint-but-404) → fallback fires (this is the B3 fix — the old
  "kill the process" test would have missed it); no crash, no empty post, no dead link.
- *Verify with:* a live `hermes cron run` of each brief; confirm the posted link resolves; a
  serve-break run confirms fallback + no dead link.

### Phase 3 — X action buttons + local endpoint (v0.1)
Ships: `/api/x/{like,unlike,bookmark,unbookmark}` endpoint (I1/I2/I5/I8) + button injection in
`html_report.ts` for X items.
- *Unit/script check:* the endpoint enforces the I1 authz gate (Origin + CSRF header + Host) before any
  spawn; maps action→xurl subcommand; validates tweet_id regex; builds argv (not shell); button injection
  appears only on `source:X` items with a parseable id; **quote-tweets pin the PRIMARY tweet_id.**
- *E2E/integration check:* from a browser on the tailnet, tap ♥ on a real tweet in a brief → the endpoint
  runs `xurl like <id>` → `xurl likes -n 5` shows the tweet now liked as `angalexg`; tap 🔖 → appears in
  `xurl bookmarks`; second tap undoes each. **This is the empirical proof — the real like/bookmark lands
  on Ace's account, verified by reading it back, not by a 200.**
- *Negative/adversarial (the REAL threat direction — B1):* (a) **forced-preflight rejection (I1-preflight,
  the load-bearing browser control)** — an actual `OPTIONS` preflight from a disallowed origin returns a
  response that WITHHOLDS `Access-Control-Allow-Origin`/`-Headers` (a real browser would block the POST);
  this is tested SEPARATELY from (b) because Origin-check-only would pass (b) but fail this; (b)
  **on-network cross-origin forgery** — a POST to `/api/x/like` with an `Origin` NOT in `*.brief.ace`
  (simulated malicious tab) → 403, **zero `xurl` spawns** (process-spy); (c) same POST without the
  `X-Docs-Ace-CSRF` header → rejected; (d) forged `Host` / DNS-rebind to the raw LAN IP → 403; (e)
  `action=post`/`action=follow` → 404/400, zero spawn; (f) `tweet_id="1; rm -rf ~"` / `tweet_id=abc` →
  400, zero spawn; (g) off-network request → refused (I1d bind, defense-in-depth); (h) **stored-XSS
  self-forge (I1x)** — a brief rendered with a hostile tweet-text/overview payload (script/attr-breakout)
  renders inert (no same-origin script executes → no self-forged action); (i) confirm no X token in any
  served byte or log.
- *Verify with:* the tap→read-back above; the preflight/cross-origin/CSRF/host/verb/injection curls each
  returning the right rejection with a process-spy showing **zero xurl spawns** on every bad input; one
  spawn only on the legitimate same-origin call; the XSS battery green.

### Phase 4 — `docs.ace` search portal (v0.2 — roadmap, own review)
Ships: the `docs.ace` portal listing + FTS over the brief archive, house-kit UI.
- *Unit:* the generator indexes N briefs, search by a known overview phrase returns the right dated
  brief. *E2E:* `curl docs.ace` → portal with search; query a spoken phrase → correct brief link.
  *Negative:* XSS battery (hostile title/overview) stays escaped (inherit the portal dogfood). *Evals:*
  n/a.

### Phase 5 — Public Share button (v0.3 — roadmap, own review, first edit to a PUBLIC surface)
Ships: per-doc Share → `doc-share here-now.sh` publishes a copy → URL to clipboard + new tab (I6).
- *Unit:* Share invokes the `herenow` driver on exactly one doc; nothing else is published. *E2E:*
  click Share on a brief → a public here.now URL loads the same content; revoke (delete site) → 404.
  *Negative:* the daily cron path never triggers Share (grep + a run shows no here.now publish); a
  privacy-scan runs before public publish (reuse `doc-share/privacy-scan.sh`). *Verify with:* the
  click→load→revoke cycle.

---

## 7. Security, Privacy, Ops, Observability

- **Credentials:** X OAuth2 user token stays in `~/.xurl` on Mac Studio (I2), auto-refreshes. `trust.ace`
  CA signs the wildcard cert. No secret in any served byte or here.now variable.
- **Public surface:** none by default. `*.brief.ace`/`docs.ace` are LAN+tailnet only; the X endpoint
  binds those interfaces only (I1). Public exposure happens ONLY via an explicit per-doc Share (I6, v0.3),
  which publishes a static copy (no endpoint, no token) to here.now.
- **Failure alerts:** the brief retry-wrapper + safety-net already page #alerts on terminal failure; add
  a `.ace` canary row for `*.brief.ace`/`docs.ace` (silent-on-green, loud-on-down). A downed static
  server surfaces as (a) the inline-fallback heartbeat and (b) the canary — never a silent 404 morning.
  **Two endpoint-specific canaries (pass-2):** (i) a **token-health probe** — a cheap `xurl` read
  (e.g. `whoami`) that alerts #alerts if the `~/.xurl` token has silently expired, so a dead token
  surfaces BEFORE the buttons 403 all morning (the page-health canary alone wouldn't catch it); (ii) a
  **cross-origin-preflight canary** — periodically fire an `OPTIONS` preflight from a disallowed origin
  and alert LOUD if it is ever *allowed* (guards against a future Caddy/route change adding a permissive
  `Access-Control-Allow-Origin: *` that would silently reopen B1).
- **Observability:** the publisher records which driver ran (`ace` vs `fallback`) in the brief heartbeat;
  the X endpoint logs action+tweet_id+result (never the token) for a lightweight audit Ace can review.
  Note (residual, not v0.1-solved): the log records actions but does not reconcile them against *intent*,
  so a fat-finger like is undetectable — an anomaly/review affordance is a future item, not a v0.1 claim.
- **Rollback:** flip `--publisher herenow` (one line) to revert delivery to here.now; the X buttons are
  additive (remove the injection) ; DNS/cert/Caddy rows are reversible (remove the route + rewrite).

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Static server down → morning link 404s (full cutover) | launchd `KeepAlive` + `.ace` canary (D-9) + inline-render fallback (I3) so #daily still gets a brief |
| **Mint-but-404: publisher "succeeds" but the URL is dead** (B3) | `ace` driver self-verifies its own URL (200+title) before returning; a dead link is a publisher FAILURE → inline fallback (I3); Phase-2 tests a SERVE-path break, not just a killed process |
| Wildcard `*.brief.ace` cert not mintable by `trust.ace` CA | Phase-0 probe; fallback to two fixed names `x.brief.ace`/`ai.brief.ace` with the slug/date as a path, not a subdomain (OQ1) |
| **On-network cross-origin action forgery / CSRF / DNS-rebind** (B1) | Origin allow-list + preflight-forcing `X-Docs-Ace-CSRF` header + `Host` pinning (I1); the marquee Phase-3 test is the cross-origin-forgery = 0-spawn case, not the off-network bind |
| **Token lacks WRITE scopes (minted for reads)** (B2) | Phase-0 write round-trip gate; a 403 pivots Phase 3 to a re-consent flow, not a build detail |
| Corpus poisoning via forged/erroneous action | I1 blocks forgery; I5 bounds worst case to reversible like/bookmark; §7 audit log lets Ace review/undo actions |
| A leaked brief URL lets a LAN guest act as Ace on X | unguessable slug + I1 authz (a guest's own tab still can't forge cross-origin) + closed reversible verb allow-list (I5); optional per-button PIN deferred (D-5) |
| **Write actions starve the ingest read budget** (shared `siftly-ace` app) | I8: per-action rate cap + separate accounting; burst test confirms the ingest floor holds |
| here.now Share leaks private content | privacy-scan before publish (reuse `doc-share/privacy-scan.sh`); opt-in per-doc only (I6); revocable |
| xurl token expires / not authed | Phase-0 re-verifies; endpoint returns a clear "re-auth needed" error; buttons fail closed with a visible state (D-10 reconciled: optimistic fill reverts + shows error on failure) |
| Tweet_id not parseable from an item URL | button simply not injected for that item (fail-closed, no broken button) |
| Quote-tweet: which tweet_id acts? | pin the PRIMARY tweet's id (Phase-3 unit check) |
| Rollback orphans already-posted `*.brief.ace` links (unreachable off-tailnet) | accepted trade for personal briefs (D-3); the archive/`docs.ace` keeps them reachable on-network; noted, not silent |
| Corpus double-count (brief like + later ingest) | ingest dedupes by tweet id already; a like from the brief is the same id the ingester would see |

---

## 9. Open Questions

- **OQ1 — Wildcard vs two fixed names.** If the `trust.ace` CA can't mint `*.brief.ace`, do we accept two
  fixed names (`x.brief.ace` / `ai.brief.ace`) with slug+date in the *path* instead of the subdomain?
  (Phase-0 decides; both satisfy the URL-readability goal.)
- **OQ2 — Endpoint host: same process as the static server, or a separate tiny service?** Same-process is
  simpler (one launchd job, same origin for `fetch`); separate is cleaner isolation. Lean same-process
  for v0.1 (same origin is required for the button `fetch` anyway).
- **OQ3 — Undo affordance.** Second-tap-to-undo (D-10) vs a small "liked ✓ (undo)" link. Cosmetic; defer
  to build.

---

## 10. Acceptance Criteria

- [ ] A published brief loads at `https://<slug>.<date>.x.brief.ace/` over HTTPS on both LAN and tailnet,
  AND the `ace` publisher self-verified that URL (200 + title) before returning it. Evidence: Phase-1
  curl → 200 + correct `<title>`; on-phone load confirmed; driver self-verify log.
- [ ] Both briefs post a `*.brief.ace` link to #daily via the `ace` publisher; breaking the SERVE path
  (Caddy route/cert removed, not just process killed) makes them post the inline fallback instead — never
  empty, never a dead link. Evidence: Phase-2 live runs + serve-break run + `publisher: fallback` heartbeat.
- [ ] Tapping ♥/🔖 on an X item in a brief actually likes/bookmarks that tweet on Ace's account,
  confirmed by reading it back via `xurl likes`/`xurl bookmarks` (not by a 200). Evidence: Phase-3 E2E.
- [ ] **On-network cross-origin forgery is blocked:** a POST to `/api/x/like` from a non-`brief.ace`
  Origin, or without the `X-Docs-Ace-CSRF` header, or with a forged `Host`, produces ZERO `xurl` spawns
  and a 403. Evidence: Phase-3 adversarial curls + process-spy = 0 spawns; 1 spawn only on the legit
  same-origin call.
- [ ] The X endpoint rejects non-allowlisted actions and non-numeric tweet_ids with no subprocess spawned;
  the token cannot post/DM/delete (Phase-0 scope probe). Evidence: Phase-3 verb/injection curls + Phase-0
  scope probe.
- [ ] Phase-0 proves the token carries WRITE scopes via a real like/unlike round-trip (or the design
  pivots to a re-auth flow). Evidence: Phase-0 write round-trip result in the PRD ground-truth block.
- [ ] No X token appears in any served byte, log line, or here.now artifact. Evidence: grep of served
  HTML + logs (I2 closeout).
- [ ] The default publisher has a single source of truth; flipping it is one line and no prompt/snapshot
  hardcodes a competing default. Evidence: I7 grep.
- [ ] The daily cron never publishes publicly; Share is a separate human-triggered path. Evidence: grep +
  a cron run showing no here.now publish (I6). *(v0.3)*
- [ ] `docs.ace` search returns the correct dated brief for a known overview phrase. Evidence: Phase-4
  E2E. *(v0.2)*

---

## Roadmap

| Version | What ships | Trigger | PRD § |
|---|---|---|---|
| **v0.1** | Brief static server + `ace` publisher + cutover + X like/bookmark buttons | now | Phases 1–3 |
| v0.2 | `docs.ace` search/list portal over the brief archive | v0.1 stable ~1 wk | Phase 4 |
| v0.3 | Public per-doc Share → here.now button on `docs.ace` | Ace wants to share a doc externally | Phase 5 |
| Future | Index arbitrary doc-share artifacts; persistent liked/bookmarked state; per-button PIN | concrete need lands | — |

---

## Review Log

### Pass 1 (Opus, claude-bpp) — Verdict: **BLOCK** → folded to v0.2
Three critical blockers, all valid, all folded:

- **B1 — confused-deputy / CSRF hole in the X endpoint.** My "network identity IS the auth" framing was
  correct for *serving pages* but wrong for a *state-changing* endpoint: the credential is the server-side
  xurl token (not a browser cookie), so any on-network tab could fire a cross-origin `fetch` whose
  side-effect lands as Ace (poisoning the pf corpus), and the "off-network 403" test guarded the wrong
  direction. **Fold:** rewrote **I1** to require Origin allow-list + preflight-forcing `X-Docs-Ace-CSRF`
  header + Host pinning before any spawn; **D-5** corrected; Phase-3 marquee negative test is now the
  on-network cross-origin-forgery = 0-spawn case; added the AC.
- **B2 — write capability unverified.** The `siftly-ace` token was minted for bookmark/like *reads*; a
  live `xurl auth status` proves a token exists, not that it has write scopes. **Ground-truthed this
  session:** `xurl like/unlike/bookmark/unbookmark <id>` subcommands DO exist and reads work as
  `angalexg` — but write scope still needs one real mutating call. **Fold:** Phase-0 now has a
  **write-scope gate** (one real like/unlike round-trip, with Ace's go-ahead) that pivots to a re-auth
  flow on 403; recorded in §5.4 + an AC.
- **B3 — mint-but-404 posts a dead link with a green heartbeat.** The `ace` driver returned a URL after
  merely writing a file; I3 only caught publisher *errors*, so serving drift → silent 404 morning.
  **Fold:** **I3** now requires the driver to self-verify its own URL (200+title) before success; Phase-2
  tests a SERVE-path break (not just a killed process); added the AC.

Also folded the 7 required changes: added **I8** (write-budget isolation), single-source-of-truth for the
default publisher (**I7**), slug determinism/idempotency + retention (**D-11/D-12**), quote-tweet primary-id
pinning, optimistic-UI-reconciled-with-fail-closed (**D-10** + risk row), and the scope-limit/rate-cap
defense-in-depth. Version bumped v0.1 → v0.2.

### Pass 2 (Opus, claude-api-proxy) — Verdict: **APPROVE WITH CHANGES** → converged, all folded to v0.3
Confirmed the pass-1 folds are real, not cosmetic (B1 a genuine authz gate, B2 correctly a load-bearing
Phase-0 gate, B3 self-verifies before success). No blockers. Three required changes, all folded:

- **RC1 — the forced preflight is the load-bearing control; prove it with its own test.** Origin/Referer
  is curl-spoofable; the only control a hostile *browser* can't bypass is the forced CORS preflight, and
  only if the CORS response withholds ACAO/ACAH for non-`brief.ace` origins. **Fold:** rewrote **I1(b)** to
  name the preflight as THE control and added a distinct **I1-preflight** closeout test (an `OPTIONS` from
  a disallowed origin must be withheld the ACAO/ACAH headers) separate from the Origin-filter test; added
  Phase-3 negative (a).
- **RC2 — `X-Docs-Ace-CSRF: 1` is a preflight MARKER, not a secret token — name it honestly.** **Fold:**
  I1(b) now states it explicitly and warns against "hardening" it into a guessable-but-static pseudo-secret;
  per-page nonce noted as out-of-v0.1-scope.
- **RC3 — same-process co-origin makes brief-content XSS a self-forge vector.** Any script inside a
  `*.brief.ace` page passes the gate; brief content is untrusted. **Fold:** added **I1x** making
  `html_report.ts` XSS-escaping a load-bearing security dependency of the endpoint, with a Phase-3
  stored-XSS negative (h).

Also folded the two notable residuals: a **token-health canary** (surfaces an expired `~/.xurl` before the
buttons 403 all morning) and a **cross-origin-preflight canary** (alerts if a future CORS misconfig ever
*allows* a disallowed origin — a standing guard against B1 silently reopening), both in §7. The
Phase-0-write-scope-pivot-is-a-fork and corpus-poisoning-detection-absent residuals are noted as known,
accepted-for-v0.1 items. Version bumped v0.2 → v0.3. **Converged: APPROVE-WITH-CHANGES with every change
folded in-spec, no open blockers.**
