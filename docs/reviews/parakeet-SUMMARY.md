# parakeet-transcribe skill PRD — Review Summary

Opus (F1 bridge — main sub weekly-exhausted), 2 passes.
- Pass 1: APPROVE WITH CHANGES — 5 RCs (GPU contention contract, server-side fetch not LAN upload, lazy-load/idle-unload, validated Whisper-first fallback w/ shape parity, verified bind/firewall). Artifact: parakeet-pass1.md.
- v2: all 5 RCs applied.
- Pass 2: APPROVE WITH CHANGES — all 5 RESOLVED; 4 cleanups (stale risk-table VRAM row, bogus CUDA_MPS token, port placeholder, 429 contract) — all fixed in v2. Artifact: parakeet-pass2.md.
APPROVED to build. Phase 0 = Blackwell/NeMo compat hard gate on ACE-AI.
