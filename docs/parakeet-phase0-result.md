# parakeet-transcribe — Phase 0 result (Blackwell hard gate)

**PASSED 2026-06-07.** Real evidence on ACE-AI (RTX PRO 6000 Blackwell, sm_120):

- Env: uv-managed Python 3.12 venv at `/opt/parakeet-transcribe/venv`.
- **Critical pin:** torch==2.8.0 + torchaudio==2.8.0, index cu128. (torch 2.11 "latest" FAILED — torchaudio ABI mismatch: `libtorchaudio.abi3.so` won't load. Must use the ALIGNED 2.8.0 pair.)
- `nemo_toolkit[asr]` + numpy + soundfile installed clean.
- torch sees GPU: capability (12,0), cuda True, GPU matmul OK.
- `nvidia/parakeet-tdt-0.6b-v3` loaded + transcribed sample WAV correctly.
  - Model load: ~28s (cold). Transcribe (4s clip): **0.60s**. Word-level timestamps: present.

**Next:** Phase 1 = FastAPI service (lazy-load/idle-unload, single-flight queue, server-side yt-dlp/ffmpeg) + systemd + LAN bind:8923 + contention measurement.
