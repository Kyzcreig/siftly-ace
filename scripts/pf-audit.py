#!/usr/bin/env python3
"""Personal-fit audit wrapper for Siftly brief crons — Wave 5 Feature 2.

Wraps `pf-score.py` so a brief run leaves DURABLE PROOF of whether personal-fit
actually fired and how it scored each item. Closes the "should have fired" gap:
the per-run /tmp/*-pf-score.json was ephemeral and the timeout case (helper killed)
left no JSON at all.

Pipeline (one invocation per brief, replaces the bare pf-score call):
  1. Run pf-score.py as a subprocess under our own timeout.
  2. Classify the outcome precisely:
       - subprocess timed out / killed        -> fired=false, reason="timeout"
       - returned ok:false (ran, declined)    -> fired=false, reason=<sentinel reason>
       - returned ok:true but PF_WEIGHT==0     -> fired=false, reason="kill-switch (PF_WEIGHT=0)"
       - returned ok:true with weight          -> fired=true
  3. Persist a durable per-run artifact (RC3: id + scores + top-2 signals ONLY;
     NO raw tweet text/title/url — the Obsidian archive already holds the tweets).
  4. Append a one-line summary to log.jsonl.
  5. Prune per-run artifacts + log lines older than --prune-days (default 7),
     mirroring the seen-list retention so PII doesn't accumulate unbounded.
  6. Re-emit pf-score's ORIGINAL stdout JSON to our stdout (unless --no-emit) so
     the brief's downstream scoring logic is unchanged.

Like pf-score, this NEVER blocks the load-bearing brief: any internal failure
still emits a fail-safe sentinel and exits 0.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_AUDIT_DIR = Path.home() / ".hermes/state/x-bookmarks/pf-audit"
DEFAULT_PF_SCORE = Path(__file__).resolve().parent / "pf-score.py"
DEFAULT_TIMEOUT = 30.0
DEFAULT_PRUNE_DAYS = 7
SIGNAL_KEYS = ("topic_score", "author_score", "format_score", "downrank_score")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(dt: datetime) -> str:
    # e.g. 2026-06-08T1314Z  (filesystem-safe, minute resolution)
    return dt.strftime("%Y-%m-%dT%H%MZ")


def top_signals(signals: dict[str, Any], n: int = 2) -> list[dict[str, Any]]:
    """Return the n signals with the largest absolute magnitude."""
    scored = []
    for key in SIGNAL_KEYS:
        val = signals.get(key)
        if isinstance(val, (int, float)):
            scored.append({"name": key, "score": round(float(val), 4)})
    scored.sort(key=lambda s: abs(s["score"]), reverse=True)
    return scored[:n]


def _embed_env() -> dict[str, str] | None:
    """Best-effort embed provisioning for SHADOW/embed pf modes (Wave 6).

    Returns a child env with OPENAI_API_KEY (from 1Password via the project's
    with-secrets.sh op path) + SIFTLY_SQLITE_VEC_EXTENSION_PATH, so a live cron
    pf-score run can actually compute the embed-affinity shadow delta instead of
    silently keyword-falling-back. FAIL-OPEN: returns None on any error so the
    caller runs pf-score with the bare env (which keyword-falls-back — the brief
    never breaks). Never raises, never prints the secret.
    """
    try:
        repo = Path(__file__).resolve().parent.parent
        wrapper = repo / "scripts" / "with-secrets.sh"
        vec = repo / ".local" / "vec0.dylib"
        # Fast path: if OPENAI_API_KEY is already in the env (cron pre-export, tests,
        # or a prior export), use it directly — skip the ~3s 1Password op probe.
        existing = os.environ.get("OPENAI_API_KEY")
        if existing:
            env = dict(os.environ)
            if vec.exists():
                env.setdefault("SIFTLY_SQLITE_VEC_EXTENSION_PATH", str(vec))
            return env
        # Opt-out for tests / environments that must not shell out to 1Password.
        if os.environ.get("PF_AUDIT_NO_OP_PROBE") == "1":
            return None
        if not wrapper.exists():
            return None
        # with-secrets.sh prints a non-secret confirmation to stdout then runs the
        # given command; we use it to PRINT the resolved env keys we need, nothing else.
        probe = subprocess.run(
            ["bash", str(wrapper), "bash", "-c", "printf 'OPENAI_API_KEY=%s\\n' \"${OPENAI_API_KEY:-}\""],
            capture_output=True, text=True, timeout=20, check=False,
            cwd=str(repo),
        )
        key = ""
        for line in (probe.stdout or "").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                key = line.split("=", 1)[1].strip()
        if not key:
            return None
        env = dict(os.environ)
        env["OPENAI_API_KEY"] = key
        if vec.exists():
            env.setdefault("SIFTLY_SQLITE_VEC_EXTENSION_PATH", str(vec))
        return env
    except Exception:
        return None


def _affinity_mode_wants_embed(config: str) -> bool:
    """True only when the resolved pf affinity mode is shadow/embed (needs the
    embed env). keyword mode / PF_WEIGHT=0 don't, so we skip the op probe — keeps
    the common path and the test suite fast (the probe shells out to 1Password)."""
    try:
        mode = os.environ.get("PF_AFFINITY_MODE") or os.environ.get("SIFTLY_PF_AFFINITY_MODE")
        if mode is None:
            cfg = Path(config)
            if cfg.exists():
                data = json.loads(cfg.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    mode = data.get("PF_AFFINITY_MODE") or data.get("pf_affinity_mode")
        mode = (mode or "shadow").strip().lower()
        return mode in ("shadow", "embed")
    except Exception:
        return True  # fail toward provisioning; pf-score still fails-open to keyword


def run_pf_score(pf_score: Path, input_arg: str | None, profile: str, config: str,
                 timeout: float) -> tuple[str, bool]:
    """Run pf-score.py; return (stdout_text, timed_out)."""
    cmd = [sys.executable, str(pf_score)]
    if input_arg:
        cmd.append(input_arg)
    cmd += ["--profile", profile, "--config", config, "--include-affinity-audit"]
    # Provision embed env ONLY for shadow/embed modes (fail-open to bare env ->
    # keyword fallback). keyword mode / PF_WEIGHT=0 skip the op probe entirely.
    child_env = _embed_env() if _affinity_mode_wants_embed(config) else None
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=child_env,
        )
        return proc.stdout, False
    except subprocess.TimeoutExpired as e:
        partial = e.stdout
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", "replace")
        return (partial or ""), True


def classify(raw_stdout: str, timed_out: bool) -> tuple[dict[str, Any], bool, str]:
    """Parse pf-score output and classify. Returns (parsed, fired, reason)."""
    if timed_out:
        return {"ok": False, "items": []}, False, "timeout"
    text = (raw_stdout or "").strip()
    if not text:
        return {"ok": False, "items": []}, False, "empty-output"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "items": []}, False, "unparseable-output"
    if not isinstance(parsed, dict):
        return {"ok": False, "items": []}, False, "unexpected-shape"

    if not parsed.get("ok", False):
        reason = str(parsed.get("reason") or "declined")
        return parsed, False, reason

    weight = parsed.get("pf_weight", 0)
    try:
        weight_num = float(weight)
    except (TypeError, ValueError):
        weight_num = 0.0
    if weight_num == 0:
        return parsed, False, "kill-switch (PF_WEIGHT=0)"
    return parsed, True, "fired"


def build_audit(parsed: dict[str, Any], brief: str, ts: datetime, fired: bool,
                reason: str) -> dict[str, Any]:
    items = parsed.get("items") or []
    affinity_audit = parsed.get("affinity_audit") if isinstance(parsed.get("affinity_audit"), dict) else {}
    audit_item_by_index: dict[Any, dict[str, Any]] = {}
    audit_item_by_id: dict[str, dict[str, Any]] = {}
    for audit_item in affinity_audit.get("items", []) if isinstance(affinity_audit, dict) else []:
        if not isinstance(audit_item, dict):
            continue
        if "index" in audit_item:
            audit_item_by_index[audit_item.get("index")] = audit_item
        if audit_item.get("id") is not None:
            audit_item_by_id[str(audit_item.get("id"))] = audit_item
    audit_items: list[dict[str, Any]] = []
    n_positive = 0
    n_negative = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        delta = it.get("personal_fit_delta", 0) or 0
        try:
            delta_num = float(delta)
        except (TypeError, ValueError):
            delta_num = 0.0
        if delta_num > 0:
            n_positive += 1
        elif delta_num < 0:
            n_negative += 1
        # RC3: id + scores + top-2 signals ONLY. Drop raw text/title/url.
        audit_item = {
            "id": it.get("id"),
            "personal_fit_affinity": it.get("personal_fit_affinity"),
            "personal_fit_raw": it.get("personal_fit_raw"),
            "personal_fit_delta": it.get("personal_fit_delta"),
            "top_signals": top_signals(it.get("signals") or {}),
        }
        audit_extra = audit_item_by_index.get(it.get("index")) or audit_item_by_id.get(str(it.get("id"))) or {}
        for key in (
            "affinity_source",
            "keyword_personal_fit_affinity",
            "keyword_personal_fit_raw",
            "keyword_personal_fit_delta",
            "shadow_personal_fit_affinity",
            "shadow_personal_fit_raw",
            "shadow_personal_fit_delta",
            "embedding_affinity",
            "keyword_secondary_affinity",
            "vec_metric",
        ):
            if key in it:
                audit_item[key] = it.get(key)
            if key in audit_extra and key != "affinity_source":
                audit_item[key] = audit_extra.get(key)
        audit_items.append(audit_item)
    vec_metric = parsed.get("vec_metric")
    if not vec_metric and isinstance(affinity_audit, dict):
        vec_metric = affinity_audit.get("vec_metric")
    return {
        "ts": ts.isoformat(),
        "brief": brief,
        "fired": fired,
        "reason": reason,
        "ok": bool(parsed.get("ok", False)),
        "pf_weight": parsed.get("pf_weight"),
        "pf_baseline": parsed.get("pf_baseline"),
        "affinity_mode": parsed.get("affinity_mode"),
        "affinity_source": parsed.get("affinity_source"),
        "vec_metric": vec_metric,
        "n_items": len(audit_items),
        "n_positive": n_positive,
        "n_negative": n_negative,
        "items": audit_items,
    }


def prune(audit_dir: Path, brief: str, prune_days: int, now: datetime) -> None:
    """Delete per-run artifacts + trim log lines older than prune_days."""
    cutoff = now - timedelta(days=prune_days)
    cutoff_ts = cutoff.timestamp()
    # Per-run JSON files (heavy; carry per-item data).
    for f in audit_dir.glob(f"{brief}-*.json"):
        try:
            if f.stat().st_mtime < cutoff_ts:
                f.unlink()
        except OSError:
            pass
    # Trim log.jsonl to entries within the window.
    log_path = audit_dir / "log.jsonl"
    if not log_path.exists():
        return
    try:
        kept: list[str] = []
        for line in log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                rec_ts = datetime.fromisoformat(rec["ts"])
                if rec_ts.tzinfo is None:
                    rec_ts = rec_ts.replace(tzinfo=timezone.utc)
                if rec_ts >= cutoff:
                    kept.append(line)
            except (json.JSONDecodeError, KeyError, ValueError):
                kept.append(line)  # keep unparseable lines rather than lose data
        log_path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    except OSError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Personal-fit audit wrapper for Siftly briefs")
    ap.add_argument("input", nargs="?", help="candidate JSON path; omit or '-' for stdin")
    ap.add_argument("--brief", required=True, help="brief name, e.g. x-feed-brief or morning-digest")
    ap.add_argument("--profile", default=str(Path.home() / ".hermes/state/x-bookmarks/preference-profile.json"))
    ap.add_argument("--config", default=str(Path.home() / ".hermes/state/x-bookmarks/brief-config.json"))
    ap.add_argument("--pf-score", default=str(DEFAULT_PF_SCORE))
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--audit-dir", default=str(DEFAULT_AUDIT_DIR))
    ap.add_argument("--prune-days", type=int, default=DEFAULT_PRUNE_DAYS)
    ap.add_argument("--no-emit", action="store_true", help="do not echo pf-score JSON to stdout (tests)")
    args = ap.parse_args()

    now = _utc_now()
    audit_dir = Path(args.audit_dir)

    try:
        # stdin can only be consumed once; if input is stdin, buffer it so we can
        # both feed pf-score and (implicitly) not need it again.
        input_arg = args.input
        raw_stdout, timed_out = run_pf_score(
            Path(args.pf_score), input_arg, args.profile, args.config, args.timeout
        )
        parsed, fired, reason = classify(raw_stdout, timed_out)

        audit = build_audit(parsed, args.brief, now, fired, reason)

        audit_dir.mkdir(parents=True, exist_ok=True)
        artifact = audit_dir / f"{args.brief}-{_stamp(now)}.json"
        artifact.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")

        summary = {
            "ts": audit["ts"],
            "brief": args.brief,
            "ok": audit["ok"],
            "pf_weight": audit["pf_weight"],
            "pf_baseline": audit["pf_baseline"],
            "affinity_mode": audit.get("affinity_mode"),
            "affinity_source": audit.get("affinity_source"),
            "vec_metric": audit.get("vec_metric"),
            "n_items": audit["n_items"],
            "n_positive": audit["n_positive"],
            "n_negative": audit["n_negative"],
            "fired": fired,
            "reason": reason,
        }
        with (audit_dir / "log.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(summary, ensure_ascii=False) + "\n")

        prune(audit_dir, args.brief, args.prune_days, now)

        # Re-emit pf-score's original JSON so the brief's downstream is unchanged.
        if not args.no_emit:
            if timed_out or not raw_stdout.strip():
                # Provide a fail-safe sentinel the brief already knows how to handle.
                print(json.dumps({
                    "ok": False, "base_score_only": True, "reason": reason, "items": [],
                }, ensure_ascii=False))
            elif isinstance(parsed, dict) and "affinity_audit" in parsed:
                emitted = dict(parsed)
                emitted.pop("affinity_audit", None)
                print(json.dumps(emitted, ensure_ascii=False))
            else:
                sys.stdout.write(raw_stdout if raw_stdout.endswith("\n") else raw_stdout + "\n")
        return 0
    except Exception as e:  # never block the brief
        if not args.no_emit:
            print(json.dumps({
                "ok": False, "base_score_only": True, "reason": f"pf-audit error: {e}", "items": [],
            }, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
