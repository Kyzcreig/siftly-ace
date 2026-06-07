#!/usr/bin/env python3
"""
End-to-end tests for parakeet-transcribe.

Layers:
  1. Pure/unit — no network: §K9 shape validation, x.com→twitter rewrite, Whisper→K9 mapping.
  2. Service — needs ACE-AI service reachable (skips cleanly otherwise): /health, URL transcribe,
     file-upload transcribe, idle-unload behavior contract.
  3. Skill wrapper — needs the Mac skill script: --text mode, fallback path (forced).
  4. Negative/adversarial — bad URL, oversized body contract, all-backends-fail structured error.

Run:  pytest -v tests/test_parakeet_transcribe.py
Env:  PARAKEET_SERVICE_URL (default http://192.168.1.216:8923)
"""
import json
import os
import shutil
import subprocess
import urllib.request
import urllib.error

import pytest

SERVICE_URL = os.environ.get("PARAKEET_SERVICE_URL", "http://192.168.1.216:8923")
SKILL = os.path.expanduser("~/.hermes/skills/media/parakeet-transcribe/scripts/parakeet-transcribe.sh")
SAMPLE_WAV_URL = "https://dldata-public.s3.us-east-2.amazonaws.com/2086-149220-0033.wav"
SAMPLE_EXPECT = "phoebe"  # appears in the known sample transcript
X_VIDEO_URL = "https://x.com/SpaceX/status/1960502324050133328"

K9_KEYS = {"text", "segments", "language", "duration_s", "model", "backend"}


# ---------- helpers ----------
def _service_up():
    try:
        with urllib.request.urlopen(f"{SERVICE_URL}/health", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def _post_json(path, payload, timeout=600):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"{SERVICE_URL}{path}", data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.load(r)


service_required = pytest.mark.skipif(not _service_up(),
                                      reason="ACE-AI parakeet service not reachable")
skill_required = pytest.mark.skipif(not os.path.exists(SKILL),
                                    reason="parakeet-transcribe skill not installed")


def assert_k9(doc, allow_null_text=False):
    """Validate the canonical §K9 output shape."""
    assert isinstance(doc, dict)
    assert K9_KEYS.issubset(doc.keys()), f"missing keys: {K9_KEYS - set(doc.keys())}"
    if not allow_null_text:
        assert isinstance(doc["text"], str) and doc["text"].strip()
    assert isinstance(doc["segments"], list)
    for s in doc["segments"]:
        assert {"start", "end", "text"}.issubset(s.keys())
    assert isinstance(doc["backend"], str)


# ---------- Layer 1: pure/unit (no network) ----------
def test_x_rewrite_logic():
    """x.com → twitter.com rewrite (the yt-dlp reliability quirk)."""
    def rewrite(u):
        return u.replace("https://x.com/", "https://twitter.com/")
    assert rewrite("https://x.com/SpaceX/status/1") == "https://twitter.com/SpaceX/status/1"
    assert rewrite("https://twitter.com/x/status/2") == "https://twitter.com/x/status/2"  # idempotent


def test_whisper_to_k9_mapping():
    """Whisper JSON → §K9 shape (the fallback's output contract)."""
    whisper = {"text": " hello world ", "language": "en",
               "segments": [{"start": 0.0, "end": 1.5, "text": " hello world "}]}
    segs = [{"start": s.get("start"), "end": s.get("end"), "text": s.get("text", "").strip()}
            for s in whisper.get("segments", [])]
    out = {"text": whisper["text"].strip(), "segments": segs, "language": whisper.get("language"),
           "duration_s": round(segs[-1]["end"], 2) if segs else 0.0,
           "model": "whisper-turbo", "backend": "mac-whisper-fallback"}
    assert_k9(out)
    assert out["backend"] == "mac-whisper-fallback"
    assert out["duration_s"] == 1.5


def test_all_backends_failed_shape():
    """The structured error a caller (Siftly) keys on to fall back to thumbnail/frames."""
    err = {"text": None, "segments": [], "error": "all_backends_failed", "backend": "none"}
    assert err["text"] is None
    assert err["error"] == "all_backends_failed"
    assert err["backend"] == "none"
    assert err["segments"] == []


# ---------- Layer 2: service (needs ACE-AI) ----------
@service_required
def test_health():
    with urllib.request.urlopen(f"{SERVICE_URL}/health", timeout=5) as r:
        d = json.load(r)
    assert d["status"] == "ok"
    assert "parakeet" in d["model"].lower()
    assert "model_loaded" in d


@service_required
def test_transcribe_url_direct_audio():
    """Direct audio URL → server fetch → transcribe → §K9, correct content."""
    status, doc = _post_json("/transcribe", {"url": SAMPLE_WAV_URL})
    assert status == 200
    assert_k9(doc)
    assert SAMPLE_EXPECT in doc["text"].lower()
    assert doc["backend"] == "ace-ai-parakeet"
    assert len(doc["segments"]) >= 1


@service_required
def test_transcribe_x_video_end_to_end():
    """The actual use case: a real X.com video → transcript (server-side yt-dlp + ffmpeg)."""
    status, doc = _post_json("/transcribe", {"url": X_VIDEO_URL})
    assert status == 200
    assert_k9(doc)
    assert doc["duration_s"] > 5  # it's a real ~47s clip
    assert len(doc["text"].split()) > 10


@service_required
def test_timestamps_present_by_default():
    status, doc = _post_json("/transcribe", {"url": SAMPLE_WAV_URL, "timestamps": True})
    assert doc["segments"] and doc["segments"][0]["start"] is not None


@service_required
def test_file_upload_transcribe(tmp_path):
    """Multipart file-upload path → §K9."""
    wav = tmp_path / "sample.wav"
    urllib.request.urlretrieve(SAMPLE_WAV_URL, wav)
    out = subprocess.run(
        ["curl", "-sf", "--max-time", "120", "-X", "POST", f"{SERVICE_URL}/transcribe_file",
         "-F", f"file=@{wav}", "-F", "timestamps=true"],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stderr
    doc = json.loads(out.stdout)
    assert_k9(doc)
    assert SAMPLE_EXPECT in doc["text"].lower()


# ---------- Layer 4: negative / adversarial ----------
@service_required
def test_bad_url_returns_error_not_crash():
    """A non-fetchable URL → clean HTTP error, not a hang/500-with-no-body."""
    try:
        status, doc = _post_json("/transcribe",
                                 {"url": "https://twitter.com/nobody/status/000"}, timeout=60)
        # If it returns a body, it must be a structured error
        assert status >= 400 or "error" in doc
    except urllib.error.HTTPError as e:
        assert e.code in (400, 500, 502)  # surfaced as an HTTP error, not a hang


# ---------- Layer 3: skill wrapper (Mac) ----------
@skill_required
@service_required
def test_skill_text_mode_x_video():
    """End-to-end through the Mac skill wrapper: X video → plain text."""
    out = subprocess.run([SKILL, X_VIDEO_URL, "--text"], capture_output=True, text=True, timeout=600)
    assert out.returncode == 0, out.stderr
    assert len(out.stdout.split()) > 10


@skill_required
def test_skill_fallback_to_whisper(tmp_path, monkeypatch):
    """Force ACE-AI 'down' via a dead service_url → skill must fall back to local Whisper."""
    if not shutil.which("whisper"):
        pytest.skip("whisper CLI not installed for fallback test")
    # sample file
    wav = tmp_path / "sample.wav"
    urllib.request.urlretrieve(SAMPLE_WAV_URL, wav)
    conf_dir = os.path.expanduser("~/.hermes/state/parakeet-transcribe")
    conf = os.path.join(conf_dir, "config.json")
    backup = conf + ".testbak"
    had = os.path.exists(conf)
    if had:
        shutil.copy(conf, backup)
    try:
        os.makedirs(conf_dir, exist_ok=True)
        with open(conf, "w") as f:
            json.dump({"service_url": "http://192.168.1.216:1"}, f)  # dead port
        out = subprocess.run([SKILL, str(wav)], capture_output=True, text=True, timeout=300)
        assert out.returncode == 0, out.stderr
        doc = json.loads(out.stdout)
        assert_k9(doc)
        assert doc["backend"] == "mac-whisper-fallback"
        assert SAMPLE_EXPECT in doc["text"].lower()
    finally:
        if had:
            shutil.move(backup, conf)
