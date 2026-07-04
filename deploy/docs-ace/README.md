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
