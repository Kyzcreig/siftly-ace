#!/usr/bin/env python3
"""docs-ace-canary.py — health canaries for the docs.ace system (PRD v1.3 §7).
Silent on green; alerts #alerts on real degradation (house style).

Checks:
  1. docs-host healthz (service up).
  2. token-health: the scoped X token is still VALID (before buttons 403 all day).
  3. cross-origin-preflight: an OPTIONS from a DISALLOWED origin must be REFUSED
     (ACAO withheld). Alerts LOUD if a CORS misconfig ever *allows* it (B1 reopen).
  4. cert pre-expiry: alert if the *.docs.ace leaf expires within N days.
Run from launchd/cron. Exit 0 always (alerting is the signal, not exit code).
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

HOST_IP = "192.168.1.18"
CA = os.path.expanduser("~/.hermes/var/skills-portal/public/Ace-Local-Root-CA.crt")
CERT = os.path.expanduser("~/.hermes/var/docs-portal/certs/docs.crt")
NOTIFY = os.path.expanduser("~/.hermes/scripts/notify.py")
CERT_WARN_DAYS = 21

problems = []


def alert(msg):
    problems.append(msg)


def check_host():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8790/healthz", timeout=6) as r:
            if r.status != 200:
                alert(f"docs-host healthz HTTP {r.status}")
    except Exception as e:
        alert(f"docs-host DOWN: {e}")


def check_token():
    sys.path.insert(0, os.path.expanduser("~/.hermes/var/docs-portal"))
    try:
        import x_token
        d = json.load(open(x_token.MIRROR))
        if not x_token._token_ok(d["access_token"]):
            # try a refresh before alerting
            try:
                x_token._refresh_locked()
            except Exception as e:
                alert(f"docs.ace X token INVALID and refresh failed: {str(e)[:120]}")
    except Exception as e:
        alert(f"docs.ace X token check errored: {str(e)[:120]}")


def check_preflight():
    """A disallowed-origin OPTIONS must be REFUSED (no ACAO). Alert if it's ever allowed."""
    cmd = ["curl", "-s", "-o", "/dev/null", "-D", "-", "--max-time", "8",
           "--cacert", CA, "--resolve", f"docs.ace:443:{HOST_IP}",
           "-X", "OPTIONS", "https://docs.ace/api/x/like",
           "-H", "Origin: https://evil.attacker.com",
           "-H", "Access-Control-Request-Method: POST"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=12).stdout.lower()
        if "access-control-allow-origin" in out:
            alert("🔴 CORS MISCONFIG: docs.ace reflects ACAO to a DISALLOWED origin (B1 reopened!)")
    except Exception as e:
        alert(f"preflight canary errored: {str(e)[:80]}")


def _latest_strict_brief_slug():
    """Newest live briefs slug that carries the .strict marker (X buttons force strict CSP).
    Returns None if none found — the check then no-ops (green) rather than false-alarms."""
    sys.path.insert(0, os.path.expanduser("~/.hermes/var/docs-portal"))
    docroot = os.path.expanduser("~/.hermes/var/docs-portal/docroot")
    try:
        import docs_index
        con = __import__("sqlite3").connect(docs_index.DB, timeout=8)
        rows = con.execute(
            "SELECT slug FROM docs WHERE type='briefs' AND (deleted IS NULL OR deleted=0) "
            "ORDER BY rowid DESC LIMIT 20").fetchall()
        con.close()
        for (slug,) in rows:
            if os.path.exists(os.path.join(docroot, "briefs", slug, ".strict")):
                return slug
    except Exception:
        return None
    return None


def check_brief_media_csp():
    """A live strict brief page MUST serve a CSP that allows video.twimg.com via media-src.
    Without it, embedded X videos silently fail to play (strict default-src 'none' block).
    This guards against LIVE DRIFT: the fix lives in docs_host.py but a revert / skipped
    deploy / stale process would drop it, and only the SERVED header proves it's actually up.
    Regressed & re-fixed 2026-07-15; see skill local-here-now-clone-docs-ace refs/csp-media-src-video.md."""
    slug = _latest_strict_brief_slug()
    if not slug:
        return  # no strict brief to probe -> nothing to assert (green)
    host = f"{slug}.docs.ace"
    cmd = ["curl", "-s", "-o", "/dev/null", "-D", "-", "--max-time", "8",
           "--cacert", CA, "--resolve", f"{host}:443:{HOST_IP}", f"https://{host}/"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=12).stdout
        csp = ""
        for line in out.splitlines():
            if line.lower().startswith("content-security-policy:"):
                csp = line.split(":", 1)[1].strip().lower()
                break
        if not csp:
            return  # no CSP header (non-strict page served) -> not this check's concern
        if "media-src" not in csp or "video.twimg.com" not in csp:
            alert(f"🔴 CSP REGRESSION: strict brief {host} serves NO media-src for video.twimg.com "
                  f"→ embedded X videos will NOT play. Live docs_host.py CSP drifted; redeploy the fix.")
    except Exception as e:
        alert(f"brief media-CSP canary errored: {str(e)[:80]}")


def check_cert():
    try:
        end = subprocess.run(["openssl", "x509", "-enddate", "-noout", "-in", CERT],
                             capture_output=True, text=True, timeout=8).stdout.strip().split("=", 1)[1]
        exp = subprocess.run(["date", "-j", "-f", "%b %e %T %Y %Z", end, "+%s"],
                             capture_output=True, text=True, timeout=8).stdout.strip()
        import time
        days = (int(exp) - int(time.time())) / 86400
        if days < CERT_WARN_DAYS:
            alert(f"*.docs.ace cert expires in {int(days)}d ({end})")
    except Exception as e:
        alert(f"cert check errored: {str(e)[:80]}")


def main():
    check_host()
    check_token()
    check_preflight()
    check_brief_media_csp()
    check_cert()
    if problems:
        msg = "⚠️ **docs.ace canary**\n" + "\n".join(f"• {p}" for p in problems)
        try:
            subprocess.run(["python3", NOTIFY, "--send", msg, "--severity", "high"],
                           timeout=20, capture_output=True)
        except Exception:
            print(msg, file=sys.stderr)
        sys.exit(0)
    # green = silent
    print("docs.ace canary: all green")


if __name__ == "__main__":
    main()
