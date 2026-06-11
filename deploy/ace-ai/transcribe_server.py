#!/usr/bin/env python3
"""
parakeet-transcribe — ACE-AI batch transcription service.

Serves NVIDIA Parakeet TDT 0.6b v3 (offline, word+segment timestamps) over HTTP.
- Lazy-load + idle-unload (frees GPU when idle).
- Single-flight queue (max-concurrent=1) so a long job can't saturate the shared card.
- Server-side yt-dlp + ffmpeg for URL inputs (caller sends a URL, not audio).
- Emits the canonical §K9 JSON shape.

Design contract: PRD-parakeet-transcribe-skill.md (siftly-ace/docs/plans).
"""
import asyncio
import hashlib
import os
import subprocess
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel

MODEL_NAME = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
IDLE_UNLOAD_S = int(os.environ.get("PARAKEET_IDLE_UNLOAD_S", "600"))   # 10 min
MAX_DURATION_S = int(os.environ.get("PARAKEET_MAX_DURATION_S", "5400"))  # 90 min cap
MAX_BODY_MB = int(os.environ.get("PARAKEET_MAX_BODY_MB", "200"))
QUEUE_MAX_WAIT_S = int(os.environ.get("PARAKEET_QUEUE_MAX_WAIT_S", "1800"))  # long-poll ceiling

# ---- single-flight: serialize all transcribes (protects the shared GPU) ----
_job_lock = asyncio.Lock()

# ---- lazy model with idle-unload ----
class _ModelHolder:
    def __init__(self):
        self._model = None
        self._last_used = 0.0
        self._lock = threading.Lock()

    def get(self):
        with self._lock:
            if self._model is None:
                import nemo.collections.asr as nemo_asr
                self._model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
                # RTX 5090 (sm_120): the TDT greedy CUDA-graph decoder GP-faults
                # (general protection fault / heap corruption) on every transcribe,
                # while CPU + the same code on the Blackwell PRO 6000 work. Disable
                # CUDA graphs in the greedy decoder (known NeMo workaround). The
                # Blackwell box is unaffected but the patch is harmless there, so
                # it ships everywhere. Override with PARAKEET_DISABLE_CUDA_GRAPHS=0.
                if os.environ.get("PARAKEET_DISABLE_CUDA_GRAPHS", "1") not in ("0", "false", ""):
                    try:
                        from omegaconf import open_dict
                        with open_dict(self._model.cfg.decoding):
                            if "greedy" not in self._model.cfg.decoding:
                                self._model.cfg.decoding.greedy = {}
                            self._model.cfg.decoding.greedy.use_cuda_graph_decoder = False
                            self._model.cfg.decoding.greedy.allow_cuda_graphs = False
                        self._model.change_decoding_strategy(self._model.cfg.decoding)
                    except Exception as _e:
                        print("WARN: could not disable cuda graphs:", _e, flush=True)
            self._last_used = time.time()
            return self._model

    def maybe_unload(self):
        with self._lock:
            if self._model is not None and (time.time() - self._last_used) > IDLE_UNLOAD_S:
                self._model = None
                try:
                    import torch, gc
                    gc.collect()
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                return True
        return False

    def loaded(self):
        return self._model is not None

_holder = _ModelHolder()
_stop_idle = threading.Event()

def _idle_watcher():
    while not _stop_idle.wait(60):
        _holder.maybe_unload()

@asynccontextmanager
async def lifespan(app: FastAPI):
    t = threading.Thread(target=_idle_watcher, daemon=True)
    t.start()
    yield
    _stop_idle.set()

app = FastAPI(title="parakeet-transcribe", lifespan=lifespan)


class UrlReq(BaseModel):
    url: str
    lang: Optional[str] = None
    timestamps: bool = True


def _rewrite_x(url: str) -> str:
    # yt-dlp reliability quirk: x.com sometimes fails where twitter.com works
    return url.replace("https://x.com/", "https://twitter.com/").replace("http://x.com/", "http://twitter.com/")


def _ffmpeg_to_wav16k(src: str, dst: str):
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-f", "wav", dst],
        check=True, capture_output=True,
    )


def _probe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _fetch_url_audio(url: str, workdir: str) -> str:
    url = _rewrite_x(url)
    out_tmpl = os.path.join(workdir, "dl.%(ext)s")
    ytdlp = os.path.join(os.path.dirname(__file__), "venv", "bin", "yt-dlp")
    if not os.path.exists(ytdlp):
        ytdlp = "yt-dlp"
    subprocess.run(
        [ytdlp, "-x", "--audio-format", "wav", "-o", out_tmpl, url],
        check=True, capture_output=True,
    )
    for f in os.listdir(workdir):
        if f.startswith("dl."):
            return os.path.join(workdir, f)
    raise RuntimeError("yt-dlp produced no audio file")


def _transcribe_file(wav_path: str, want_ts: bool) -> dict:
    model = _holder.get()
    dur = _probe_duration(wav_path)
    if dur > MAX_DURATION_S:
        # local-attention for long audio (Parakeet v3 supports ~3hr local-attn)
        try:
            model.change_attention_model(self_attention_model="rel_pos_local_attn",
                                          att_context_size=[256, 256])
        except Exception:
            pass
    out = model.transcribe([wav_path], timestamps=want_ts)
    res = out[0]
    text = res.text if hasattr(res, "text") else str(res)
    segments = []
    if want_ts and hasattr(res, "timestamp") and res.timestamp:
        for s in res.timestamp.get("segment", []) or []:
            segments.append({"start": s.get("start"), "end": s.get("end"), "text": s.get("segment", "")})
    return {
        "text": text,
        "segments": segments,
        "language": None,            # v3 auto-detects; NeMo doesn't surface it cleanly here
        "duration_s": round(dur, 2),
        "model": MODEL_NAME,
        "backend": "ace-ai-parakeet",
    }


async def _run_with_queue(coro_fn):
    try:
        await asyncio.wait_for(_job_lock.acquire(), timeout=QUEUE_MAX_WAIT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "60"})
    try:
        return await asyncio.to_thread(coro_fn)
    finally:
        _job_lock.release()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "model_loaded": _holder.loaded(),
            "idle_unload_s": IDLE_UNLOAD_S}


@app.post("/transcribe")
async def transcribe_url(req: UrlReq):
    def work():
        with tempfile.TemporaryDirectory() as wd:
            src = _fetch_url_audio(req.url, wd)
            wav = os.path.join(wd, "audio16k.wav")
            _ffmpeg_to_wav16k(src, wav)
            return _transcribe_file(wav, req.timestamps)
    try:
        return JSONResponse(await _run_with_queue(work))
    except HTTPException:
        raise
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=502, detail=f"fetch/transcode failed: {e.stderr.decode()[:300] if e.stderr else e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"transcribe failed: {e}")


@app.post("/transcribe_file")
async def transcribe_upload(file: UploadFile = File(...), timestamps: bool = Form(True)):
    data = await file.read()
    if len(data) > MAX_BODY_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"file > {MAX_BODY_MB}MB")
    def work():
        with tempfile.TemporaryDirectory() as wd:
            src = os.path.join(wd, file.filename or "upload.bin")
            with open(src, "wb") as f:
                f.write(data)
            wav = os.path.join(wd, "audio16k.wav")
            _ffmpeg_to_wav16k(src, wav)
            return _transcribe_file(wav, timestamps)
    try:
        return JSONResponse(await _run_with_queue(work))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"transcribe failed: {e}")
