# PRD — `parakeet-transcribe` skill

**Version:** v2 (review APPROVE WITH CHANGES applied: server-side fetch, lazy-load/idle-unload, single-flight concurrency, Whisper-first fallback w/ shape parity, verified bind/firewall, restart-mid-job)
**Date:** 2026-06-07
**Author:** Apollo
**Owner:** Apollo
**Type:** Hermes skill + ACE-AI transcription service
**Skill location:** `~/.hermes/skills/media/parakeet-transcribe/`
**Service host:** ACE-AI (`192.168.1.216`, RTX PRO 6000 Blackwell 96GB) — *future: move to RTX 3090*

---

## 1. Summary & Goal

A reusable, composable transcription skill: **audio/video → text transcript** using NVIDIA Parakeet, served on a fleet GPU. It is the canonical "transcribe this" tool for the fleet — called by the Siftly-Ace video tier, and available for YouTube ingestion, meeting summaries, voice-memo capture, or any future audio-to-text need.

**Goal:** `parakeet-transcribe <audio-or-video-file-or-URL>` → clean transcript text (+ optional word/segment timestamps), produced on ACE-AI's GPU, callable from the Mac Studio over the LAN, with graceful fallback.

**Why a standalone skill (not inline in Siftly):** transcription is a general capability. Burying Parakeet logic inside Siftly would force every other consumer to reimplement it. One skill owns "media → transcript"; consumers are thin callers.

---

## 2. The "don't run two Parakeets" question (central design decision)

**Ground truth:** the voice stack (`pipecat-house-voice`) ALREADY runs Parakeet — but a *different* deployment for a *different* workload:

| Dimension | Voice stack (existing) | This skill (batch) |
|---|---|---|
| Model | Parakeet **1.1B CTC streaming** | Parakeet **TDT 0.6B v3** (offline, timestamps, 25-lang) |
| Mode | `str` (streaming, low-latency real-time) | `ofl` (offline batch) |
| Host | **Skynet / ACE-MEDIA** (RTX 5090, WSL2) | **ACE-AI** (RTX PRO 6000) |
| Serving | Riva NIM (gRPC `:50051`, REST `:9000`) | TBD — see options |
| Latency need | ~100–200ms TTFS, always-warm | seconds-to-minutes OK, can cold-start |
| Workload | continuous, interactive | bursty, queued, batch |

So they are NOT redundant today — different model, mode, host, and latency profile. **But** we should not naively stand up a *third* thing without considering reuse. Three options:

**Option A — Separate batch service on ACE-AI (RECOMMENDED for v1).**
Stand up Parakeet TDT 0.6B v3 offline on ACE-AI via NeMo (or a small FastAPI wrapper). Pros: clean separation, ACE-AI has 96GB headroom, offline TDT model gives timestamps + better batch accuracy, doesn't touch the latency-critical voice path, survives Skynet/WSL reboots independently. Cons: a second Parakeet *deployment* (but different model/host — justified).

**Option B — Reuse Skynet Riva NIM in offline mode (`ofl`/`all`).**
Riva NIM supports offline mode; we could send batch jobs to the existing Skynet endpoint. Pros: one GPU model deployment. Cons: couples batch work to the voice-critical GPU (a long video job could contend with live voice latency); Skynet is WSL2 (more fragile, the README documents a libcuda shim hack); 1.1B CTC lacks the TDT timestamp quality; ACE-AI sits idle. **Rejected for v1** — contention with live voice is the dealbreaker.

**Option C — Consolidate voice ONTO ACE-AI later.**
Longer-term, both could live on ACE-AI (96GB fits both models). Not in scope now (voice stack is working on Skynet; don't destabilize it). Noted as a future convergence path.

**Decision:** Option A for v1. The skill talks to a dedicated **ACE-AI batch transcription service**. Document the voice-stack Parakeet explicitly so the fleet knows there are two *intentional* deployments, why, and the future convergence path (Option C). Shared-model-registry / single-service consolidation is a documented future item, triggered if/when GPU pressure or maintenance burden justifies it.

---

## 3. Non-Goals

- **Not a streaming/real-time STT.** That's the voice stack's job (Riva NIM on Skynet). This is batch/offline.
- **Not a diarization or speaker-ID system** (v1). Transcript only; speaker labels are a future add.
- **No audio storage.** Audio/video is transient — fetch → transcribe → discard. Only transcript text persists (caller's responsibility to store).
- **Not tied to Siftly.** Siftly is one consumer; the skill is general.
- **No model training/fine-tuning.** Use the released `parakeet-tdt-0.6b-v3`.

---

## 4. Resolved Decisions

| # | Decision | Value |
|---|---|---|
| K1 | Model | `nvidia/parakeet-tdt-0.6b-v3` (offline, word+segment timestamps, auto punctuation, 25 langs) |
| K2 | Host (now) | **ACE-AI** `192.168.1.216`, RTX PRO 6000 Blackwell 96GB |
| K3 | Host (future) | **Move to RTX 3090** when Ace adds it — frees the RTX PRO 6000 for other work. GPU is a config value, not hardcoded (see §5.5). |
| K4 | Deployment model | Option A — dedicated ACE-AI batch service, separate from the voice-stack Parakeet on Skynet |
| K5 | Voice integration | Documented as two intentional deployments; convergence onto one host = future item (Option C). This skill does NOT touch the live voice path. |
| K6 | Serving interface | Small **FastAPI HTTP service** on ACE-AI (`POST /transcribe`) + a systemd unit. Skill calls it over LAN. **URL fetch + ffmpeg transcode happen SERVER-SIDE on ACE-AI** (caller sends a URL or a path; the service does yt-dlp/ffmpeg) — avoids shipping hundreds of MB of audio over the LAN (RC2). Local-file callers may POST the file (bounded, see §5.2). |
| K6a | Model lifecycle | **Lazy-load + idle-unload** (RC3): the service loads the model on first request and unloads it after an idle timeout, freeing the GPU when not transcribing. NOT always-resident — this keeps the shared card free for RAG/triton/voice-adjacent work and strengthens the K3 migration story. First-request cold-start (~seconds) is acceptable for batch. |
| K6b | Concurrency | **Single-flight queue, max-concurrent = 1** (RC1). Transcribe jobs serialize; a long video cannot fan out and saturate the SMs. The card already runs `tritonserver` (~5GB, Agora/Clanker) + RAG (`:8765`) — measured, not assumed (Phase 0/1). |
| K7 | Fallback | If ACE-AI service unreachable: **Whisper-CLI on the Mac Studio is the v1 fallback** (already installed, proven). `parakeet-mlx` is an *enhancement* added only if it installs cleanly (Phase 3) — an unvalidated fallback is not a fallback (RC4). All backends MUST emit the §K9 JSON shape; backends lacking word-level timestamps (Whisper) populate segment-level + null the word field (declared degradation, not a crash). |
| K8 | Input | Local file path OR URL. URLs (incl. X/Twitter) fetched via `yt-dlp -x` (audio-only). `x.com`→`twitter.com` rewrite. |
| K9 | Output | JSON: `{text, segments:[{start,end,text}], language, duration_s, model, backend}` |
| K10 | Long audio | Parakeet v3: ~24min full-attention / ~3hr local-attention. Configurable cap + chunking for longer. |
| K11 | Compute env | Python venv on ACE-AI (system py is 3.14; NeMo needs a pinned venv, likely 3.11/3.12) |

---

## 5. Design

### 5.1 Components

```
Caller (Siftly video tier / Apollo / YouTube pipeline / Mac Studio)
   │
   │  parakeet-transcribe.sh <file|url> [--timestamps] [--lang xx] [--json]
   ▼
Skill wrapper (Mac Studio) — scripts/parakeet-transcribe.sh
   ├─ URL input → POST {"url": ...} to ACE-AI (service fetches/transcodes — RC2)
   ├─ local file → POST file (bounded size) to ACE-AI
   ├─ POST to ACE-AI service ─────────────────────► ACE-AI FastAPI :8923
   │                                                  ├─ (URL) yt-dlp -x + ffmpeg 16k mono  [server-side]
   │                                                  ├─ single-flight queue (max-concurrent=1)
   │                                                  ├─ lazy-load NeMo Parakeet TDT 0.6b v3 (idle-unload)
   │                                                  └─ offline transcribe + timestamps
   ├─ on failure/unreachable → fallback: Whisper-CLI (Mac), parakeet-mlx if validated
   └─ emit §K9 JSON transcript; discard any temp audio
```

**Why server-side fetch (RC2):** a 90-min clip is hundreds of MB. Having the Mac fetch+transcode+re-upload doubles the transfer and adds a failure surface. The service (which is already next to the GPU) does the yt-dlp/ffmpeg work; the caller sends a tiny URL. Local-file callers POST the file with a bounded body size (reject > a configured max; large local media is rare for our use).

### 5.2 ACE-AI service (`deploy/ace-ai/`)

- **FastAPI** app `transcribe_server.py`: `POST /transcribe` (accepts `{"url": ...}` for server-side fetch, OR a multipart audio upload with a **bounded body size**, e.g. reject > 200 MB), `GET /health`.
- **Lazy-load + idle-unload (K6a):** model loaded on first request, unloaded after a configurable idle timeout (e.g. 10 min). Frees the GPU for triton/RAG when idle.
- **Single-flight queue (K6b):** `max-concurrent = 1`; requests serialize. **Contract:** the service **queues and long-polls** a waiting request (holds the connection until its turn or a configurable max-wait), rather than hard-429-looping. If max-wait is exceeded it returns 503 with a `Retry-After`; the skill wrapper then retries with backoff. Avoids a second caller tight-looping while a long job runs.
- Server-side `yt-dlp -x` + `ffmpeg` 16kHz mono for URL inputs.
- Offline transcription with timestamps; chunking for long audio (K10).
- **systemd unit** `parakeet-transcribe.service` (auto-restart, starts on boot). **Restart-mid-job behavior (SRE):** an in-flight transcribe is lost on restart; the service returns a clear error and the caller (Siftly queue) re-enqueues — jobs are idempotent by `tweetId`/input hash, so a re-run is safe. Document this.
- **Bind to the fleet LAN interface explicitly** (`192.168.1.216:8923`, NOT `0.0.0.0`), plus a `ufw`/firewall rule scoping `:8923` to the `192.168.1.0/24` subnet. Verified at Phase 1 (`ss -ltnp` shows the bound IP; a probe from off-subnet is refused) — not asserted. Port `8923` confirmed free on ACE-AI (RAG occupies `8765`).
- venv at `/opt/parakeet-transcribe/venv` (pinned Python + NeMo + torch/CUDA for Blackwell).

### 5.3 Skill wrapper (Mac Studio)

`scripts/parakeet-transcribe.sh`:
- Accepts a local path or URL. URL → `yt-dlp -x --audio-format wav` to a temp file.
- Convert to 16kHz mono (Parakeet input spec) via `ffmpeg`.
- POST to ACE-AI `/transcribe`; parse JSON.
- Health-check ACE-AI first (`GET /health`, short timeout); if down → fallback chain (K7).
- Emit transcript JSON to stdout (or `--text` for plain text).
- Discard temp audio (trap cleanup).

### 5.4 Fallback chain (K7)

1. **ACE-AI service** (primary).
2. **Whisper-CLI on the Mac** (v1 fallback — already installed, proven) if ACE-AI is unreachable.
3. **`parakeet-mlx` on the Mac** — *enhancement only*, inserted ahead of Whisper if and only if it's validated to install cleanly (Phase 3). Until then, Mac fallback = Whisper directly.

**Output-shape parity (RC4):** every backend emits the §K9 JSON. Parakeet (ACE-AI/mlx) provides word+segment timestamps; Whisper provides segment-level only → it populates `segments[]` and sets word-level fields to null. The `backend` field records which served. Siftly's video tier consumes `text` (always present) + optional segments — so a Whisper fallback degrades gracefully, never crashes. If ALL backends fail, return a structured error so Siftly falls back to thumbnail/frames.

### 5.5 GPU portability (K3 — the RTX 3090 move)

The service must not hardcode the GPU host. Externalize:
- ACE-AI service host:port in skill config (`~/.hermes/state/parakeet-transcribe/config.json` → `{"service_url": "http://192.168.1.216:8923"}`).
- When the RTX 3090 lands: deploy the same service (systemd unit + venv) on the 3090's host, flip `service_url`, verify health, retire the ACE-AI instance. Documented as a runbook step. **No skill code changes** — just config + redeploy.
- Note: RTX 3090 has 24GB — ample for the 0.6B model (it'll fit easily; the 96GB on the PRO 6000 is overkill for this single model, which is exactly why moving it frees that card).

### 5.6 Config & state

`~/.hermes/state/parakeet-transcribe/config.json`:
```json
{
  "service_url": "http://192.168.1.216:8923",
  "max_duration_s": 5400,
  "fallback_order": ["ace-ai", "mac-mlx", "whisper"]
}
```

---

## 6. Implementation Phases

- **Phase 0 — ACE-AI env + model smoke.** SSH to ACE-AI, create pinned venv, `pip install nemo_toolkit[asr]` + torch for Blackwell, download `parakeet-tdt-0.6b-v3`, transcribe the NeMo sample WAV. Smoke: sample audio → correct text on GPU. **Verify GPU + CUDA + Blackwell (sm_120) compatibility — this is the hard gate** (the voice-stack README documents Blackwell/TensorRT version pitfalls; confirm NeMo+torch path works on this card before building the service).
- **Phase 1 — FastAPI service + systemd.** `transcribe_server.py`, `/transcribe` + `/health`, systemd unit, LAN bind. Smoke: `curl` a WAV from the Mac → transcript JSON.
- **Phase 2 — Skill wrapper + yt-dlp + ffmpeg.** `parakeet-transcribe.sh`: file + URL input, 16kHz mono convert, POST, JSON out. Smoke: transcribe a local clip AND a real X video URL from the Mac.
- **Phase 3 — Fallback chain.** parakeet-mlx on Mac + whisper last-resort; backend logging. Smoke: stop ACE-AI service, confirm Mac fallback transcribes; force both off, confirm whisper.
- **Phase 4 — Long-audio chunking + timestamps.** Smoke: a >24min audio chunks correctly; timestamps present.
- **Phase 5 — SKILL.md + Obsidian doc.** Document architecture, the two-Parakeet rationale, the RTX 3090 future move, and the voice-convergence path. Obsidian page under Engineering or AI.
- **Phase 6 — Integration contract for Siftly.** Confirm the JSON output shape Siftly's video tier consumes; a tiny adapter if needed.

Each phase: real smoke test, then commit/push.

---

## 7. Security & Privacy

- Service binds to the **LAN/fleet subnet only**; not exposed publicly. No auth needed within the trusted subnet, but document that it must never be port-forwarded.
- Audio is transient; no retention.
- Transcripts may contain anything that was said — caller owns storage/sensitivity (for Siftly, that's the local bookmark DB).
- No secrets in the service or skill; SSH to ACE-AI uses existing fleet keys.

## 8. Observability & Ops

- Service `/health` endpoint; systemd auto-restart; journald logs.
- Skill logs which backend served each request.
- Failure to reach ACE-AI is non-fatal (fallback) but logged.
- Document start/stop/restart + model-cache location in the runbook.

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Blackwell (sm_120) torch/NeMo incompatibility | High (blocks Phase 0) | Phase 0 hard gate; the voice README documents Blackwell/TensorRT pitfalls — budget time; worst case use a container with known-good CUDA |
| ACE-AI Python 3.14 too new for NeMo | Medium | Pinned venv with 3.11/3.12 |
| Batch job contends with other ACE-AI GPU work (Agora/Clanker triton ~5GB, RAG :8765) | Medium | Single-flight queue (max-concurrent=1, K6b); idle-unload (K6a); monitor **SM utilization + RAG/triton p95 latency** (NOT VRAM — VRAM is ample); measured contention AC; if degradation seen, lower priority (see §10 OQ1) |
| Service down → no transcription | Medium | Fallback chain (Mac mlx → whisper) |
| Long video OOM/timeout | Low | Duration cap + chunking (K10) |
| RTX 3090 move breaks things | Low | Config-only swap (§5.5); redeploy runbook; verify health before retiring old |
| yt-dlp can't fetch protected X video | Low | Caller falls back (Siftly → thumbnail/frames) |

## 10. Open Questions

**Resolved during review:** OQ1 port → **8923 confirmed free** on ACE-AI (RAG on 8765). Concurrency → single-flight max-1 (K6b). Mac fallback → Whisper-CLI v1, mlx enhancement-only (K7). yt-dlp/ffmpeg → **server-side on ACE-AI** (RC2). Restart-mid-job → job lost, caller re-enqueues, idempotent (§5.2).

**Still open (resolve in Phase 0/1):**
1. **Measured contention:** does a sustained transcribe degrade RAG (`:8765`) or triton (Agora/Clanker, ~5GB resident) p95 latency on the shared card? Must be **measured** in Phase 1, not assumed. If it does, lower priority via MPS active-thread limiting (`CUDA_MPS_ACTIVE_THREAD_PERCENTAGE`), GPU compute-mode, or `nice`/`ionice` on the service process.
2. **NeMo vs HF Transformers** serving path on Blackwell — whichever proves stable in Phase 0.
3. **RTX 3090 throughput (not just fit):** 24GB easily holds the 0.6B model, but a 3090 (Ampere) is slower than the PRO 6000 (Blackwell). Confirm long-audio chunk throughput on a 3090 is acceptable for the Siftly tier before the migration — it's a possible regression, not a free move. (Memory fits; speed is the question.)
4. `parakeet-mlx` clean install on M3 Ultra? (Phase 3; else Mac fallback stays Whisper.)

## 11. Acceptance Criteria

- [ ] Phase 0 hard gate: `parakeet-tdt-0.6b-v3` transcribes the sample WAV correctly on ACE-AI's GPU.
- [ ] ACE-AI FastAPI service serves `/transcribe` + `/health`; systemd auto-starts on boot.
- [ ] `parakeet-transcribe.sh <local-file>` returns correct transcript JSON from the Mac over LAN.
- [ ] `parakeet-transcribe.sh <x.com-video-url>` fetches + transcribes a real X video.
- [ ] Fallback: ACE-AI down → Mac backend transcribes; backend recorded in output.
- [ ] Long audio (>24min) chunks correctly; word/segment timestamps present.
- [ ] SKILL.md loadable; documents the two-Parakeet rationale + RTX 3090 future move + voice-convergence path.
- [ ] Obsidian doc published.
- [ ] Output JSON shape confirmed compatible with Siftly's video tier.
- [ ] GPU host is config-driven (§5.5) — no hardcoded `192.168.1.216` in skill logic.
- [ ] **Contention test:** a sustained long transcribe does NOT degrade RAG/triton p95 latency beyond an acceptable threshold (measured, RC1).
- [ ] **Fallback output-shape parity:** Whisper fallback emits §K9 JSON (segment-level, word=null); Siftly consumes it without error (RC4).
- [ ] **Idle-unload verified:** GPU memory is released after the idle timeout (RC3).
- [ ] **Bind/firewall verified:** service bound to `192.168.1.216:8923` (not 0.0.0.0); off-subnet probe refused (RC5).
- [ ] **Restart-mid-job:** in-flight job lost cleanly, caller re-enqueues, re-run is idempotent.
