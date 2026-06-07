# siftly-ace

Working repo for several related Ace-fleet build efforts. Despite the name (it began as the
home for the *Ace X Knowledge Base* / Siftly fork), it currently hosts the **specs, reviews,
and deploy artifacts** for a cluster of projects that were specced and built together.

> **Status:** docs + deploy artifacts only (no application code yet). The Siftly application
> itself is **not yet built** — see Phase 0 in its PRD.

## What's in here

| Path | What it is |
|---|---|
| `docs/plans/PRD-ace-x-knowledge-base.md` | The **Ace X Knowledge Base** (Siftly fork) PRD — ingest X bookmarks/likes → searchable Obsidian KB + brief personalization. **Build pending (Phase 0).** |
| `docs/plans/PRD-prd-lifecycle-skill-suite.md` | The **PRD-lifecycle skill suite** PRD (v10) — 7 `prd-*` skills + `session-handoff` + the **Daedalus** GPT-5.5 coding agent. **Built & live.** |
| `docs/plans/PRD-parakeet-transcribe-skill.md` | The **parakeet-transcribe** PRD — fleet audio/video transcription service. **Built, deployed on ACE-AI `:8923`, 11 tests green.** |
| `docs/plans/PRD-prd-share-skill.md` | The **prd-share** skill PRD. **Built & live.** |
| `docs/reviews/` | Opus multi-pass review artifacts for the above. |
| `deploy/ace-ai/` | The parakeet-transcribe FastAPI service (`transcribe_server.py`), its systemd unit, and the 11-test e2e suite. |
| `deploy/daedalus/SOUL.md` | The **Daedalus** agent SOUL (authored by Opus-4-8 high). The live copy is at `~/.hermes/profiles/daedalus/SOUL.md`. |

## Where the built things actually live

This repo is the **spec/review/deploy home**; the running artifacts live elsewhere:

- **Skills** (`prd-interview`, `prd-authoring`, `prd-document`, `prd-swarm-planner`,
  `prd-swarm-plan-review`, `prd-closeout`, `session-handoff`, `prd-share`, `parakeet-transcribe`):
  `~/.hermes/skills/software-development/` and `~/.hermes/skills/media/`.
- **Daedalus profile:** `~/.hermes/profiles/daedalus/` (GPT-5.5 xhigh Kanban coder).
- **parakeet service:** ACE-AI (`192.168.1.216`) systemd `parakeet-transcribe` on `:8923`.

## Obsidian overviews (durable, human-readable homes)

- `AI/Ace X Knowledge Base — System Overview.html`
- `AI/PRD Skills & Kanban Orchestration — System Overview.html`
- `AI/Parakeet Transcription — Fleet Architecture.html`

## Lifecycle convention used here

These projects follow the PRD lifecycle the suite itself encodes:
`prd-interview → prd-authoring → prd-review-pipeline → prd-swarm-planner/writing-plans → build → prd-closeout`,
with `prd-document` for docs-only refreshes and `/session-handoff` for cross-session batons.

---
*This README is maintained docs-only (per the `prd-document` skill). For a full build close-out
with tests + memory, that's `prd-closeout`.*
