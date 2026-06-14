# Closeout — Reddit RSS Gatherer: egress-lane multi-sub (delta)

**Status:** PASS
**Scope:** the `lanes` round-robin feature added after the initial RSS-pivot closeout
(`064025a`). This is a delta closeout for commit `7eda960`.
**PRD:** `docs/plans/PRD-reddit-rss-pivot.md` (R5 updated to SOLVED-via-lanes; the datacenter
mis-diagnosis corrected).

| Item | Status | Evidence |
|---|---|---|
| Hardening pass | PASS | New seam (curl SOCKS transport) failure path live-verified: dead SOCKS port → `[]` + warn, exit 0, no crash (catches via the existing network-throw guard). Lane round-robin shape unit-tested. Full report context in `reddit-rss-hardening-report.md` + this delta. |
| E2E tests | PASS | **Live multi-lane run:** MachineLearning via Spectrum + LocalLLaMA via Starlink → 20 candidates, both HTTP 200, zero 429, simultaneously. Independent-budget proof: spectrum 429 + starlink 200 at the same instant. |
| Acceptance criteria | PASS | Multi-sub no longer best-effort-1-sub; round-robins N subs across N residential IPs. No-new-dep invariant held (curl transport, `git diff package.json` empty). Never-throws invariant held (proxy-down → `[]`+warn). |
| Constitution/Invariants | PASS | no-new-dep (curl, not npm proxy pkg) ✓; never-throws (proxy-down live-proven) ✓; shape-unchanged (tsc clean) ✓; injected-fetchImpl still overrides lanes → tests stay hermetic ✓ |
| Project docs | PASS | `AGENTS.md` corrected (datacenter→Spectrum-residential; lanes SOLVED); PRD R5 rewritten; `reddit-rss-live-proof.md` correction section appended |
| Obsidian | PASS | `Ace X Knowledge Base — System Overview.md` gatherer-probe line corrected (per-IP budget on any IP; multi-sub SOLVED via lanes) |
| Git | PASS | `7eda960` pushed to `github.com/Kyzcreig/siftly-ace`; per-file `git cat-file -e origin/main` OK; legible WHAT/WHY commit |
| Memory/mem0 | PASS | `mem0_conclude` correction stored (datacenter mistake fixed; lanes SOLVED, MacBook-Pro not needed) |
| Cron/alerts | N/A | gatherer still NOT wired into any live brief/cron; wiring is the future live-wiring PRD |
| Loose ends | PASS | below |
| DISCOVERIES | PASS | below |

## Remaining work (deferred to the future live-wiring PRD)
- Wire gatherers into the daily brief prompt (gated `prompt.md` edit, Ace approval + ≥3 shadow runs).
- "reddit `fetched`==0 for N days" warn (handoff invariant).
- When wiring with lanes: ensure the Starlink SOCKS proxy (`192.168.1.217:1080`) is up at cron time, or
  the lane degrades to `[]`+warn for its subs (graceful). Optionally preflight via `lanectl test`.
- Cosmetic: the proxy-down warn echoes the full curl argv (incl. the UA URL) — harmless, could be
  trimmed if log noise matters.

## DISCOVERIES
- **The Mac Studio egresses Charter/Spectrum residential (`68.185.70.45`), NOT a datacenter IP.** My
  earlier "datacenter-IP" framing was a wrong carryover from the `.json` 403 analysis. The ≈1-fetch/
  window RSS limit is Reddit's normal per-IP budget on *any* single IP. Lesson: don't reuse a
  diagnosis label across a different endpoint without re-checking.
- **Independent residential egress lanes each get their own Reddit RSS budget** — proven by spectrum
  429 + starlink 200 fired simultaneously. Round-robin across lanes is the clean multi-sub scaler.
- **Node built-in `fetch` can't do SOCKS without an npm dep** — the dep-free workaround is a curl
  `--socks5-hostname` transport shelled out per proxied lane; native fetch for the direct lane. Keeps
  the no-new-dep invariant while still supporting proxied egress.
- **House lanes live in `~/Projects/youtube-notebooklm/lanes/`** (`egress-lanes.json` + `lanectl.sh`):
  spectrum (direct) + starlink (`socks5://192.168.1.217:1080`, already up) + nick + cell (MacBook tether).
