# parakeet-transcribe PRD — Senior Review

## Verdict
APPROVE WITH CHANGES

## Critical Blockers
None that block design approval. The Blackwell gate is correctly fenced as a Phase 0 hard gate, which is the right structure. Below are required changes before build proceeds past Phase 1.

## Required Changes

1. **GPU contention model is hand-waved (§9, §K3).** "0.6B model is small; queue/serialize" understates the issue. The contention risk is not VRAM — RTX PRO 6000 has 96GB, the model load is trivial. The real risk is *compute contention*: a long-video transcribe will saturate SM/tensor-core throughput on the same card that serves RAG (8765) and may share with Agora/Clanker inference. State the actual concurrency control: single-flight queue, max-concurrent=1, and whether you nice/MPS-partition. "Monitor VRAM" is the wrong metric — measure SM utilization and RAG p95 latency under a concurrent transcribe job. Add an acceptance criterion that a long transcribe does NOT degrade the RAG/voice-adjacent workloads.

2. **Audio upload over LAN is unbounded (§5.2, §K8).** `POST /transcribe` multipart with a 90-min (`max_duration_s: 5400`) audio file = hundreds of MB per request, fetched/converted on the *Mac* then shipped over LAN. Specify: max request body size, streaming upload vs. in-memory, and whether yt-dlp/ffmpeg should run on ACE-AI instead (URL → service-side fetch) to avoid the round-trip. Currently the Mac does the heavy fetch/transcode and re-uploads — wasteful and a failure surface.

3. **systemd model warm-start vs. "can cold-start" contradiction (§2 table vs. §5.2).** §5.2 says model resident at startup; §2 says cold-start OK. If the model is always resident on the PRO 6000, it permanently holds GPU memory/context on a card you intend to *free* — that undercuts the K3 migration rationale (you're adding a persistent resident process to a "shared, always-on" box). Decide: lazy-load + idle-unload (frees GPU when not transcribing) vs. always-resident. For a bursty batch workload on a contended card, lazy/idle-unload is the correct default. Specify it.

4. **Fallback realism (§5.4, OQ3).** The fallback chain assumes Mac `parakeet-mlx` works; OQ3 admits it may not install. A fallback you haven't validated is not a fallback. Either gate v1 on confirming `parakeet-mlx` (Phase 3) or declare Whisper-CLI the v1 Mac fallback and treat mlx as enhancement. Also: timestamp/output-shape parity across the three backends is unaddressed — Whisper segments ≠ Parakeet TDT word timestamps. Siftly consumes one JSON shape (§K9); fallbacks must produce it or degrade declared fields.

5. **Port 8923 collision check is deferred to Phase 1 but listed as a blocker risk (OQ1).** Trivial to resolve now: `ss -ltnp` on ACE-AI before approval. Also confirm firewall rule actually scopes to the fleet /24 and not 0.0.0.0 — §7 asserts "LAN only" but no rule is specified. "No auth on trusted subnet" is acceptable *only* if the bind + firewall is verified, not assumed.

## Lens Notes
- **Product:** Standalone-skill rationale (§1, §2) is sound; the two-Parakeet justification is genuinely well-argued, not redundant.
- **Arch:** Mac-does-fetch/transcode + uploads to ACE-AI is the wrong split; push URL handling server-side (RC2).
- **Infra:** Adding a resident GPU process to a box already running voice-adjacent agents + RAG needs a stated contention/concurrency contract, not "monitor VRAM" (RC1, RC3).
- **SRE:** systemd auto-restart is fine, but no behavior defined for restart-during-transcribe (in-flight job lost? caller retries?) — define.
- **Security:** §7 is adequate IF the bind/firewall is verified rather than asserted (RC5); no auth on a fleet subnet is reasonable here.
- **Impl:** Python 3.14 system + pinned 3.11/3.12 venv is correct; NeMo-on-Blackwell is the real risk and is correctly gated (§Phase 0).
- **QA:** Acceptance criteria are solid but missing: contention test (RC1), fallback output-shape parity (RC4), restart-mid-job behavior.
- **ConfigDrift:** §5.5 config-driven host is good; but the systemd unit, venv path, and firewall rule are per-host artifacts — the "flip service_url" runbook must also cover redeploying those, not just config.
- **Cost/Perf:** Always-resident model on a 96GB card is wasteful given bursty load (RC3); idle-unload reclaims the card and strengthens the K3 migration story.

## Open Questions
1. Concurrency policy on ACE-AI: max-concurrent transcribes, and interaction with RAG/Agora/Clanker scheduling — MPS, nice, or naive queue?
2. Does a sustained transcribe measurably degrade voice/RAG latency on the shared card? (Must be measured, not assumed — RTX 5090 voice is on Skynet, but RAG is co-resident on ACE-AI.)
3. Is the RTX 3090 (24GB, Ampere sm_86) actually validated for the v3 model + your throughput target, or just assumed to "fit"? Memory fits; throughput/long-audio-chunking time on a 3090 vs PRO 6000 is a real regression risk for the Siftly tier.
4. Where do yt-dlp/ffmpeg run — Mac or ACE-AI? (Determines LAN traffic and failure surface.)
5. What is the in-flight-job behavior on systemd restart / boot?

## Strengths
- §2 is the standout: the two-Parakeet decision is rigorously justified (different model/mode/host/latency), Option B correctly rejected on voice-contention grounds, Option C parked sensibly.
- §Phase 0 correctly identifies Blackwell/NeMo/torch as the true hard gate and references the voice README's documented pitfalls rather than assuming compat.
- §5.5 GPU portability is genuinely config-driven and the 3090-frees-the-PRO-6000 logic is coherent.
- Non-Goals (§3) are crisp; transient-audio/no-retention is the right privacy posture.
- Fallback intent (never crash, structured error so Siftly degrades to thumbnail/frames) is the right reliability philosophy — it just needs validation (RC4).