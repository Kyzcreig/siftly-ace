# SPEC — `x.ace` LAN nice-name for the Siftly app

**Status:** DRAFT · **Author:** Apollo · **Date:** 2026-06-28 · **Owner sign-off:** low-risk, additive
**Host:** Mac Studio M3 Ultra = `192.168.1.18` (this box; Siftly runs here on `:3000`).
**Companion runbook:** `local-dns` skill → `references/lan-nice-name-on-macos-host.md` (the proven
macOS `.ace` frontdoor pattern — skills.ace/cron.ace/tokens.ace/… all use it).

## 1. Summary & Goal
Put the Siftly app (currently `http://mac-studio-m3u:3000/`, "Not Secure") behind a clean, trusted-HTTPS
LAN name: **`https://x.ace/`** (bare alias `https://x/` too). One more site block on the existing
`ai.hermes.skills-caddy` LaunchDaemon — a **reverse_proxy to `127.0.0.1:3000`** (NOT a static
file_server like the other 5 `.ace` portals — Siftly is a live Next.js app).

**Why `x.ace`:** Ace's ask; it's the X-bookmarks knowledge base. (Confirm the name in Open-Q1 — `x.ace`
vs `siftly.ace`.)

## 2. Non-Goals
- NOT exposing Siftly off-LAN / to the internet (no tunnel, no port-forward — `.ace` is LAN-only).
- NOT moving/restarting the Siftly Node process or changing how it's launched.
- NOT a `www.x.ace` alias in v1 (trivial to add later via `add-www-alias.sh` if wanted).
- NOT touching the other 5 `.ace` site blocks except the shared `:80` redirect matcher (append only).

## 3. Constitution / Invariants
- **INV-1 (no regression to existing `.ace` sites).** Adding `x.ace` must not break skills.ace /
  cron.ace / tokens.ace / greenhouse.ace / index.ace. The add-site flow validates + verifies the PRIMARY
  (skills.ace) stays green, with wholesale rollback if it regresses.
  - *Closeout proof:* after reload, all 5 existing `.ace` names return their prior HTTP code with
    `verify=0`; `skills.ace` = 200 (the primary safety gate).
- **INV-2 (single-entry AGH rewrite — the rewrite list is ONE shared object).** Add `x.ace → 192.168.1.18`
  via the single-entry `/control/rewrite/add` endpoint; never a whole-list PUT. The ~49 other rewrites
  (mostly → `.216`) must survive byte-identical.
  - *Closeout proof:* rewrite count goes +1 (or +2 with bare `x`); a diff shows 0 existing entries
    removed/changed.
- **INV-3 (web-root isolation N/A — reverse_proxy, not file_server).** Because Siftly is proxied, there's
  no static web root exposing the cert/key/Caddyfile (the file_server trap doesn't apply). The leaf
  key stays `alexgierczyk`-owned `0600`.
- **INV-4 (cert SAN lists every served name).** The leaf's `subjectAltName` must carry exactly the names
  the block serves (`x.ace`, `x`), or the browser throws `ERR_CERT_COMMON_NAME_INVALID` even when DNS
  resolves.
  - *Closeout proof:* `openssl x509 -in x.crt -text` shows `DNS:x.ace, DNS:x`; `openssl verify -CAfile
    <Ace-CA> x.crt` → OK.
- **INV-5 (`:80` redirect matcher lists the new name, or it 421s).** The shared `http://:80` block must
  add `x.ace x` to its `@ace host …` list, or a browser hitting bare `http://x.ace` first gets HTTP 421.
  - *Closeout proof:* `curl -I http://x.ace` (resolved to `.18`) → 308 → `https://x.ace`.

## 4. Resolved Decisions
- **D-1 — reverse_proxy, not file_server.** Siftly is a live app on `:3000`. The site block is
  `reverse_proxy 127.0.0.1:3000`. (Bind to `127.0.0.1` not `0.0.0.0:3000` so the proxy hop stays
  loopback; the app already listens on `*:3000`.)
- **D-2 — Reuse the existing LaunchDaemon + Caddyfile.** Add one site block to
  `~/.hermes/var/skills-portal/Caddyfile` + the `:80` matcher; no new daemon. Restart via
  `sudo launchctl kickstart -k system/ai.hermes.skills-caddy` (NOT `caddy reload` — `admin off`).
- **D-3 — New portal dir for the cert.** `~/.hermes/var/x-portal/certs/` (0700) holds `x.crt`/`x.key`
  (no `public/` needed — reverse_proxy). Mirrors the per-portal layout.
- **D-4 — WebSocket pass-through.** Next.js dev/HMR + the app's AI-search streaming may use WebSockets;
  Caddy `reverse_proxy` handles WS upgrade automatically, but verify the live AI-search "Searching…"
  streaming works through the proxy (AC-4).
- **D-5 — Leaf cert via the Ace Local Root CA** (the proven recipe: CA key from 1Password
  `Ace Local Root CA — Private Key`, `--format json` unwrap, pubkey-match assert, scrub `ca.key` after).
  `auto_https off` → no auto-renew → add to the existing cert-expiry watch (or note `notAfter`).

## 5. Architecture / Design
```
Brave →  x.ace  → AGH rewrite (x.ace → 192.168.1.18)
       → Caddy (skills-caddy LaunchDaemon, bind 192.168.1.18:443)
         https://x.ace:443 { tls x.crt x.key; reverse_proxy 127.0.0.1:3000 }
       → Siftly Next.js (node, *:3000)
http://x.ace → Caddy :80 @ace matcher → 308 → https://x.ace
```
New Caddyfile block (model — adapt from skills.ace, swap file_server→reverse_proxy):
```
https://x.ace:443, https://x:443 {
    bind 192.168.1.18
    tls /Users/alexgierczyk/.hermes/var/x-portal/certs/x.crt /Users/alexgierczyk/.hermes/var/x-portal/certs/x.key
    reverse_proxy 127.0.0.1:3000
}
```
…plus `x.ace x` appended to the `@ace host …` list in the `http://:80` block.

## 6. Implementation Phases
- **Phase 1 — Leaf cert.** Issue `x.crt`/`x.key` (SAN `x.ace,x`) under the Ace CA into
  `~/.hermes/var/x-portal/certs/`; scrub the CA key; `openssl verify` → OK.
  - *Verify:* `openssl verify -CAfile <Ace-CA> x.crt` → OK; `x509 -text` shows both SANs.
- **Phase 2 — AGH rewrite.** Single-entry add `x.ace → 192.168.1.18` (and bare `x` if AGH accepts it;
  bare-name rewrites are how `skills`/`cron` resolve). Snapshot-verify the other ~49 survive.
  - *Verify:* `dig +short x.ace @192.168.1.208` → `192.168.1.18`; rewrite count +1/+2, 0 removed.
- **Phase 3 — Caddyfile block + `:80` matcher + reload.** Backup the Caddyfile; add the reverse_proxy
  block + the matcher token; `caddy validate`; atomic swap; `launchctl kickstart -k`.
  - *Unit:* `caddy validate --config <candidate>` → "Valid configuration".
  - *Negative/adversarial:* the add must NOT regress skills.ace (INV-1) — verify it's still 200 post-reload.
  - *Verify:* `curl --cacert <Ace-CA> https://x.ace/ -w '%{http_code} verify=%{ssl_verify_result}'` →
    `200 verify=0`; the 5 existing names still green.
- **Phase 4 — Live app proof (the real deliverable).** The Siftly UI loads over `https://x.ace/`, the
  trusted-cert padlock shows (no "Not Secure"), and the **AI-search streaming actually works through the
  proxy** (submit a query → "Searching…" → results render).
  - *E2E:* open `https://x.ace/ai-search`, run a real search, confirm results + the images-analyzed card
    render; check WebSocket/stream isn't broken by the proxy.
  - *Verify:* a real browser round-trip (vision-confirm the padlock + a working search), AND
    `curl --cacert <CA> https://x.ace/ai-search -o /dev/null -w '%{http_code}\n'` → 200.
- **Phase 5 — index.ace auto-discovery + reboot survival.** `index.ace` re-renders nightly from the live
  AGH rewrite list, so `x.ace` auto-appears (no edit). Confirm the LaunchDaemon `KeepAlive` survives a
  Caddy crash (`sudo kill <caddy pid>` → respawns) — reboot survival is inherited from the existing daemon.
  - *Verify:* `x.ace` shows in `index.ace` after the nightly render (or force-render); kill-respawn works.

## 7. Security, Privacy, Ops, Observability
- LAN-only; no new external exposure; no creds beyond the one-time CA-key read (scrubbed after).
- **Rollback (seconds):** restore the backed-up Caddyfile + `launchctl kickstart -k`; delete the AGH
  rewrite (single-entry `/control/rewrite/delete`); `rm -rf ~/.hermes/var/x-portal`. The Siftly app and
  the other `.ace` names are untouched.
- **Cert expiry:** `auto_https off` → manual leaf, 825-day validity; add to the existing `.ace`
  cert-expiry watch so it alerts <30d.
- **Blast radius:** one Caddy reload on a daemon that also serves 5 other `.ace` sites — the add-site
  flow's "verify primary (skills.ace) green or roll back wholesale" gate contains it (INV-1).

## 8. Risks & Mitigations
- **R-1 (Caddy reload with a referenced-but-missing cert crash-loops ALL `.ace` routes).** Mitigation:
  issue + `openssl verify` the leaf BEFORE adding the block; `caddy validate` the candidate before the
  atomic swap; verify skills.ace stays 200 after.
- **R-2 (bare `x` browser-navigation quirk).** Browsers may treat a bare `x` as a search, not a host
  (the `.ace`-isn't-a-real-TLD issue). `x.ace` with the dot works; bare `x` is a convenience alias only.
  Not a blocker; documented.
- **R-3 (Siftly app not always running → 502).** If the Node process is down, `x.ace` returns a Caddy
  502. That's correct/honest (the name works, the app is just down) — not a frontdoor bug. Optionally
  note whether Siftly should be a managed service (out of scope for v1).
- **R-4 (WebSocket/streaming broken by the proxy).** Mitigation: Phase 4 explicitly tests live AI-search
  streaming through `x.ace`, not just a static page load.

## 9. Open Questions
1. **Name: `x.ace` or `siftly.ace`?** Ace said `x.ace/` (matches the X-bookmarks domain, short). *Rec:*
   `x.ace` per the ask; could add `siftly.ace` as a second SAN+matcher for free if wanted. (Bare `x` is
   the only iffy part — R-2.)
2. **Should Siftly be a managed/always-on service?** Today it's a manually-run `node` on `:3000`. If
   `x.ace` should always work, Siftly itself needs a LaunchAgent/KeepAlive. *Rec:* out of scope for the
   domain v1; flag separately if "x.ace must always be up" matters.

## 10. Acceptance Criteria
- [ ] **AC-1.** `dig +short x.ace @192.168.1.208` → `192.168.1.18`; the other ~49 AGH rewrites survive
  (INV-2).
- [ ] **AC-2.** `curl --cacert <Ace-CA> https://x.ace/` → `HTTP 200 verify=0 remote=192.168.1.18`.
- [ ] **AC-3.** `curl -I http://x.ace` (resolved `.18`) → 308 → `https://x.ace` (INV-5).
- [ ] **AC-4 (the real one).** A real browser loads `https://x.ace/ai-search`, shows the trusted padlock
  (no "Not Secure"), and a live AI-search returns results (streaming works through the proxy). Evidence:
  vision-confirmed screenshot.
- [ ] **AC-5.** All 5 existing `.ace` sites unchanged (INV-1); `skills.ace` = 200.
- [ ] **AC-6.** `openssl verify -CAfile <Ace-CA> x.crt` → OK; SAN = `x.ace, x` (INV-4); CA key not left
  on disk.
- [ ] **AC-7.** `x.ace` appears in `index.ace` after the nightly render; Caddy kill→respawn works.

### Verification command summary
- `dig +short x.ace @192.168.1.208`
- `curl -s -o /dev/null -w 'HTTP %{http_code} verify=%{ssl_verify_result} remote=%{remote_ip}\n' --cacert ~/Projects/dns-block-portal/certs/Ace-Local-Root-CA.crt https://x.ace/`
- `caddy validate --config ~/.hermes/var/skills-portal/Caddyfile --adapter caddyfile`
- Browser: open `https://x.ace/ai-search`, run a search, vision-confirm padlock + results.
