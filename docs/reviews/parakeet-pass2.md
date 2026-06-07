# parakeet-transcribe PRD — Senior Review (Pass 2)

## Verdict
APPROVE WITH CHANGES

## RC Resolution Map
- **RC1 (GPU compute contention):** RESOLVED — K6b states single-flight max-concurrent=1; §10 OQ1 + AC reframe the metric correctly to RAG/triton **p95 latency** (not VRAM), measured in Phase 1. Good fix. (Stale residue: §9 risk table still says "monitor VRAM" — see New Issues.)
- **RC2 (unbounded LAN upload):** RESOLVED — K6 + §5.1/§5.2 move yt-dlp/ffmpeg **server-side** (caller sends URL); local-file POST bounded at 200MB. The wasteful Mac-fetch-then-reupload path is gone for the common case.
- **RC3 (warm-start contradiction):** RESOLVED — K6a explicitly chooses **lazy-load + idle-unload**, removes the always-resident claim, and §2 table "can cold-start" is now consistent with it. AC adds idle-unload verification.
- **RC4 (fallback realism + shape parity):** RESOLVED — K7/§5.4 demote `parakeet-mlx` to validated-only enhancement, make **Whisper-CLI the v1 fallback**, and specify §K9 shape parity (Whisper → segment-level, word=null). AC covers parity.
- **RC5 (bind/firewall verification):** RESOLVED — §5.2 specifies explicit bind to `192.168.1.216:8923` (not 0.0.0.0), ufw scoped to `/24`, verified via `ss -ltnp` + off-subnet probe; port 8923 confirmed free. AC enforces it.

All five RCs genuinely addressed in design — not rubber-stamped, the fixes change the actual architecture (server-side fetch, idle-unload, single-flight), not just prose.

## New Issues
1. **§9 risk table is stale and contradicts the fixes (minor, but fix before build).** The contention row still reads "0.6B model is small; queue/serialize requests; **monitor VRAM**" — this is the exact RC1 language the review rejected. K6b/§10/AC fixed it everywhere *except* the risk table. Update the row to reference SM/p95-latency monitoring and the measured contention AC. Leaving the wrong metric in the canonical risk register invites the wrong test later.

2. **§10 OQ1 cites an unexplained magic token.** "lower priority via `nvidia-smi` compute-mode / `CUDA_MPS` or nice the process." `CUDA_MPS` is not a real nvidia-smi/MPS concept — it reads like a hallucinated/placeholder identifier. Replace with the actual mechanism (MPS active-thread-percentage, `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE`, or compute-mode EXCLUSIVE_PROCESS / nice). Don't ship a runbook pointer to a token that doesn't exist.

3. **Config drift: `service_url` port mismatch with K6a idle-unload UX (cosmetic).** §5.1 still shows `POST to ACE-AI FastAPI :8923` while §5.5's config example uses `"service_url": "http://192.168.1.216:PORT"` (literal `PORT`) in one place and `:8923` in §5.6. Pick the concrete port consistently now that 8923 is confirmed free.

4. **429/queued contract underspecified (carryover, not a blocker).** §5.2 says single-flight "Returns 429/queued if busy (caller waits or retries)." With max-concurrent=1 and minutes-long jobs, a second caller could 429-loop for a long time. State the intended behavior: does the service queue-and-block (long-poll) or hard-429-and-caller-retries-with-backoff? The skill wrapper's retry/backoff isn't specified. Minor — resolve in Phase 1.

## Verdict Rationale
All five required changes are genuinely resolved at the design level, and the fixes are substantive (server-side fetch, idle-unload, single-flight queue, Whisper-first fallback with declared shape degradation, verified bind/firewall) rather than cosmetic. No new blockers. The remaining items are a stale risk-table row carrying the rejected RC1 metric (#1), a bogus-looking `CUDA_MPS` token that must not enter a runbook (#2), and two cosmetic/contract cleanups (#3, #4). None block build past Phase 1, but #1 and #2 should be corrected in this revision because they actively mislead the implementer. APPROVE WITH CHANGES — proceed to Phase 0/1; clean up the risk table and the magic token in the same commit.