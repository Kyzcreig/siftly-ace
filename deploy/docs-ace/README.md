# docs.ace — local here.now clone (PRD-docs-ace-local-hosting v1.3)

Deployed on Mac Studio `.18`. These are the version-controlled copies; the LIVE files run from
`~/.hermes/var/docs-portal/` and `~/Library/LaunchAgents/`.

## Phase 1 (DONE)
- `docs_host.py` — the host service (serves `<slug>.docs.ace` by Host header + CSP + health). launchd `ai.hermes.docs-host` (:8790, KeepAlive).
- `ace_publisher.py` — the `ace` publisher driver: deterministic slug (D-11 seed+salt), content-marker inject, I3 self-verify (200+marker via curl --resolve SNI).
- `issue-docs-ace-leaf.sh` — `*.docs.ace`+`docs.ace` wildcard leaf from the Ace Local Root CA. launchd `ai.hermes.docs-ace-cert-renew` (weekly Mon 04:10, idempotent).
- Caddy: `docs.ace`+`*.docs.ace` → 127.0.0.1:8790 (block in `~/.hermes/var/skills-portal/Caddyfile`).
- AGH: `*.docs.ace`+`docs.ace` rewrites → 192.168.1.18.

## Live verification (Phase 1)
- `curl --cacert <AceCA> --resolve <slug>.docs.ace:443:192.168.1.18 https://<slug>.docs.ace/` → 200 + trusted cert.
- Deterministic slug: retry same doc-id reuses; cross-identity collision salt-escalates (unit-tested).
- Negatives: bogus slug → 404, path-traversal → 404.

## Phases 3-5 + ops (DONE) — v1.0 COMPLETE
- Phase 3: `x_token.py` (flock refresh + verify-before-serve, I2), `docs_host.py` `/api/x/*` (I1 anchored-origin+CSRF-preflight+host gate), `assets/x-buttons.js` + `inject_x_buttons.py` (buttons on X items), CSP sha256 (I1x, browser-verified blocks XSS). Scoped token: like/bookmark only (POST→403).
- Phase 4: `docs_index.py` (sqlite FTS5 body search, D-13/D-12 durable), `portal.py` (docs.ace cards + live search).
- Phase 5: `doc_actions.py` — Share (button-stripped copy→here.now, I4), Revoke (here.now DELETE + marker fallback, I10), Delete (soft, single-doc scoped).
- Ops: `docs-ace-canary.py` (launchd `ai.hermes.docs-ace-canary`, every 30m): host-health + token-validity + cross-origin-preflight-refusal + cert-pre-expiry. Silent green, #alerts on degrade. Token mirror: `seed-token-mirror.sh` (0600 local SoT seeded from 1Password).

## Live launchd jobs
- `ai.hermes.docs-host` — the host service (:8790, KeepAlive)
- `ai.hermes.docs-ace-cert-renew` — weekly wildcard leaf renewal
- `ai.hermes.docs-ace-canary` — 30-min health canary

## VERIFIED (all live)
Security: cross-origin forgery 403 (incl. evil-docs.ace.attacker.com endswith bypass), missing-CSRF 403, disallowed-action 404, bad-tweet-id 400, preflight ACAO withheld for evil / present for legit, CSP blocks injected script (browser `csp_blocked:true`). Effect: real like/bookmark on Ace's account verified by read-back, net-zero. Portal: FTS body search finds "Cloudflare Workers" by body. Share: stripped copy 0 /api/x refs. Revoke: here.now 404. Delete: local 404, adjacent serves. Fallback: docs-host down → brief posts via here.now (I3).
