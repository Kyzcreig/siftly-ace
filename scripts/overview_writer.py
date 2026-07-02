#!/usr/bin/env python3
"""overview_writer.py — generate the brief's Overview ("The Landscape" / "Your Timeline")
prose via a RELIABLE model + a deterministic lint gate.

Why this exists (2026-07-02): the cron's own model (gpt-5.5/openai-codex) repeatedly
ignores the prompt's prose rules and emits the banned roll-call pattern
("@handle highlighted <raw fragment> [1]. @handle2 highlighted ...") plus pasted-fragment
bullets — the 7th recurrence of the "model ignores a prose scoring/format rule" class.
Structural fix, same doctrine as the deterministic renderer/selector: take the flaky
synthesis OUT of the cron model. This script:
  1. reads the deterministic aggregate (overview_digest.py output),
  2. asks the Opus bridge (hermes -z --provider claude-api-proxy-f2) to write the prose,
  3. LINTS the result deterministically (roll-call spine, verbatim fragment paste,
     thin/truncated bullets, length, header, ref validity),
  4. retries with the lint errors fed back (up to --attempts),
  5. writes the passing prose to --out; exits NON-ZERO if no attempt passes
     (caller must then SKIP the overview — a missing Landscape beats an incoherent one).

Usage:
  python3 scripts/overview_writer.py --agg /tmp/morning-digest-overview-input.json \
      --brief morning-digest --out /tmp/morning-digest-overview.txt
  python3 scripts/overview_writer.py --lint-only --prose <file> --agg <agg>   # gate an existing draft
  python3 scripts/overview_writer.py --selftest
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

DEFAULT_MODEL = "gpt-5.5"
DEFAULT_PROVIDER = "openai-codex"

ROLLCALL_VERBS = r"(?:highlighted|shared|posted|noted|flagged|mentioned|discussed)"
# "@handle <verb>" used as the sentence spine
ROLLCALL_RE = re.compile(r"@\w{1,20}[\w'’]*\s+" + ROLLCALL_VERBS, re.IGNORECASE)

HEADERS = {
    "morning-digest": "🗞️ **The Landscape**",
    "x-feed-brief": "📡 **Your Timeline**",
}

BANNED_META = [
    "shows the same lane from a different angle", "rounds out the theme",
    "salience", "the selection guard", "the cleanest example in the cluster",
    "repeated coverage usually means", "set the pace today",
]


def _norm(s: str) -> str:
    """Lowercase + collapse to alphanumerics for verbatim-paste detection."""
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _fragments(agg: dict, min_len: int = 40) -> list[tuple[str, str]]:
    """Raw source fragments the prose must not paste verbatim: story titles/labels
    + theme examples. Returns (display, normalized) pairs."""
    frags = []
    for s in (agg.get("top_stories") or []):
        for k in ("title", "label"):
            v = s.get(k) or ""
            v = re.sub(r"^@[\w]+:\s*", "", v).strip()  # drop the @handle: prefix on labels
            if len(v) >= min_len:
                frags.append((v[:60], _norm(v)[:48]))
    for t in (agg.get("themes") or []):
        for ex in (t.get("examples") or []):
            ex = re.sub(r"^@[\w]+:\s*", "", str(ex)).strip()
            if len(ex) >= min_len:
                frags.append((ex[:60], _norm(ex)[:48]))
    return frags


def lint(prose: str, agg: dict, brief: str) -> list[str]:
    """Deterministic gate. Returns a list of failures (empty = pass)."""
    errors = []
    p = prose.strip()
    header = HEADERS.get(brief, HEADERS["morning-digest"])
    if not p.startswith(header):
        errors.append(f"must start with the header line: {header}")
    if len(p) > 1900:
        errors.append(f"too long: {len(p)} chars (hard cap 1900)")

    # 1. Roll-call spine: 2+ "@handle <listverb>" constructions = the banned pattern.
    hits = ROLLCALL_RE.findall(p)
    if len(hits) >= 2:
        errors.append(
            f"roll-call spine detected ({len(hits)}x '@handle {ROLLCALL_VERBS}') — "
            "banned; lead with the EVENT/CLAIM in your own words, attribution rides inside the sentence")

    # 2. Verbatim fragment paste: a >=48-char normalized run copied from a raw title/label.
    np = _norm(p)
    pasted = [disp for disp, nf in _fragments(agg) if nf and len(nf) >= 40 and nf in np]
    if pasted:
        errors.append(
            "verbatim source-fragment paste detected — paraphrase into a real claim, never copy raw titles: "
            + "; ".join(f"'{d}…'" for d in pasted[:3]))

    # 3. Theme bullets must be written sentences, not pasted stubs / truncations.
    for line in p.splitlines():
        m = re.match(r"^\s*[•\-]\s*\*\*(.+?)\*\*\s*—\s*(.*)$", line)
        if m:
            body = m.group(2).strip()
            if len(body) < 60:
                errors.append(f"theme bullet '{m.group(1)}' too thin ({len(body)} chars) — write a full sentence with a real claim")
            if re.search(r"(…|\.\.\.)\.?\s*$", body):
                errors.append(f"theme bullet '{m.group(1)}' ends with a truncation ellipsis — that's a pasted fragment, not writing")

    # 4. Ref validity: every [N] must exist in the aggregate; each used at most once.
    valid = {s.get("ref") for s in (agg.get("top_stories") or []) if isinstance(s.get("ref"), int)}
    used = [int(n) for n in re.findall(r"(?<!\[)\[(\d{1,3})\](?![\(\]])", p)]
    bogus = [n for n in used if n not in valid]
    if bogus:
        errors.append(f"citations {bogus} don't exist in the aggregate (valid: {sorted(valid)})")
    dupes = sorted({n for n in used if used.count(n) > 1})
    if dupes:
        errors.append(f"citations used more than once: {dupes}")

    # 5. Meta/scaffolding talk.
    low = p.lower()
    meta = [b for b in BANNED_META if b in low]
    if meta:
        errors.append("banned meta/scaffolding phrases: " + "; ".join(meta))

    return errors


def build_prompt(agg: dict, brief: str, prior_errors: list[str] | None = None) -> str:
    header = HEADERS.get(brief, HEADERS["morning-digest"])
    scope = ("global AI news day (multi-source: X, HN, Reddit, GitHub, newsletters)"
             if brief == "morning-digest" else "Ace's X timeline — feed mood, themes, loud voices")
    fb = ""
    if prior_errors:
        fb = ("\n\nYOUR PREVIOUS DRAFT FAILED THESE DETERMINISTIC CHECKS — fix ALL of them:\n- "
              + "\n- ".join(prior_errors))
    return f"""You are the editor of a daily AI brief for Ace, an AI-builder. Write the overview section: a tight ~250-word editorial synthesis of the {scope}, from the aggregate JSON below.

SHAPE (exactly):
{header}
<lead paragraph, 2–4 flowing sentences: what actually MOVED today — the 1–2 biggest events in your own words — placed against the shape of the field (busiest lanes, shippers vs think-pieces). A count may ride INSIDE a sentence, never open it.>
• **<Theme>** — <ONE written sentence with a real, specific claim about that lane.>
• **<Theme>** — <same>
• **<Theme>** — <same>
<optional one-line mood/shape closer>

HARD RULES (a deterministic linter rejects violations):
1. NEVER use "@handle highlighted/shared/posted/noted/flagged <fragment>" as a sentence spine. Lead with the EVENT/CLAIM; @handle and [N] ride inside the sentence as attribution. ❌ "@alex_atoms highlighted how to use GLM-5.2 for free [1]." ✅ "GLM-5.2 is now runnable for free via Cloudflare Workers AI, per a circulating guide [1]."
2. NEVER paste raw titles/labels/tweet fragments verbatim — paraphrase into a claim. If a fragment is too thin to turn into a real claim, DROP that story and pick another.
3. Theme bullets: full written sentences (≥60 chars), never a bare repo slug or a truncated "…" fragment.
4. Cite stories with [N] using ONLY the integer `ref` values in `top_stories`; each ref at most once; 3–6 citations total. Do not write URLs.
5. ≤1900 chars total. No meta-talk about scoring/selection/salience/clusters. Every sentence carries a proper noun or number and tells Ace something NEW.
6. Cover the FIELD (themes/content_mix breadth), not just the top stories.{fb}

AGGREGATE:
{json.dumps(agg, ensure_ascii=False)}

Reply with ONLY the overview text between the markers, nothing else:
<<<OVERVIEW>>>
(your text)
<<<END>>>"""


def call_model(prompt: str, provider: str, model: str, timeout: int = 300) -> str:
    r = subprocess.run(
        ["hermes", "-z", prompt, "--provider", provider, "-m", model],
        capture_output=True, text=True, timeout=timeout)
    text = r.stdout or ""
    s = text.find("<<<OVERVIEW>>>")
    e = text.find("<<<END>>>")
    if s >= 0 and e > s:
        return text[s + len("<<<OVERVIEW>>>"):e].strip()
    return text.strip()  # model may reply bare — lint will judge it


def selftest() -> int:
    agg = {"top_stories": [
        {"ref": 1, "title": "How to using GLM-5.2 for free? just briefly described the guide from my friend and i advise you", "label": "@alex_atoms: How to using GLM-5.2 for free? just briefly…", "url": "https://x.com/x/status/1"},
        {"ref": 2, "title": "What's coming to AgenC. Everything below is either building now or behind an audit gate.", "label": "@tetsuoai: What's coming to AgenC…", "url": "https://x.com/x/status/2"},
    ], "themes": [{"topic": "Coding", "examples": ["HKUDS/Vibe-Trading"]}]}
    bad = ("🗞️ **The Landscape**\n"
           "@alex_atoms highlighted how to using GLM-5.2 for free? just briefly described the guide from my… [1]. "
           "@tetsuoai highlighted what's coming to AgenC. Everything below is either building now or behind an… [2].\n"
           "• **Coding** — HKUDS/Vibe-Trading.\n"
           "• **Agents** — You don't understand how BIG this update….")
    good = ("🗞️ **The Landscape**\n"
            "GLM-5.2 is now free to run through Cloudflare Workers AI, per a widely-shared setup guide [1], while "
            "AgenC previewed its build pipeline — everything gated behind audits before release [2]. Agent tooling was "
            "the busiest lane, and the day skewed heavily toward shipping over think-pieces.\n"
            "• **Coding** — Vibe-Trading from HKUDS turned an LLM loop into a live trading agent, the lane's most-starred repo today.\n"
            "• **Agents** — Agent frameworks dominated GitHub trending, with three of the top five repos being orchestration layers.")
    checks = [
        ("bad: roll-call", any("roll-call" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: paste", any("paste" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: thin bullet", any("too thin" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: ellipsis bullet", any("ellipsis" in e for e in lint(bad, agg, "morning-digest"))),
        ("good passes", lint(good, agg, "morning-digest") == []),
        ("bogus ref", any("don't exist" in e for e in lint(good.replace("[2]", "[9]"), agg, "morning-digest"))),
        ("dup ref", any("more than once" in e for e in lint(good.replace("[2]", "[1]"), agg, "morning-digest"))),
        ("missing header", any("header" in e for e in lint(good.replace("🗞️ **The Landscape**", "Landscape"), agg, "morning-digest"))),
        ("too long", any("too long" in e for e in lint(good + "\nx" * 2000, agg, "morning-digest"))),
    ]
    ok = True
    for name, passed in checks:
        print(("PASS" if passed else "FAIL"), name)
        ok &= passed
    print(f"{sum(p for _, p in checks)}/{len(checks)} selftests passed")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agg", help="overview aggregate JSON (overview_digest.py output)")
    ap.add_argument("--brief", default="morning-digest", choices=["morning-digest", "x-feed-brief"])
    ap.add_argument("--out", help="write passing prose here")
    ap.add_argument("--attempts", type=int, default=3)
    ap.add_argument("--provider", default=DEFAULT_PROVIDER)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--lint-only", action="store_true", help="lint --prose against --agg, no model call")
    ap.add_argument("--prose", help="existing prose file for --lint-only")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    if not a.agg:
        print("--agg required", file=sys.stderr); return 2
    try:
        agg = json.load(open(a.agg))
    except Exception as e:
        print(f"cannot read aggregate: {e}", file=sys.stderr); return 2

    if a.lint_only:
        prose = open(a.prose).read() if a.prose else sys.stdin.read()
        errs = lint(prose, agg, a.brief)
        for e in errs:
            print("LINT-FAIL:", e, file=sys.stderr)
        print("lint:", "PASS" if not errs else f"FAIL ({len(errs)})")
        return 0 if not errs else 1

    errors: list[str] = []
    for attempt in range(1, a.attempts + 1):
        try:
            prose = call_model(build_prompt(agg, a.brief, errors or None), a.provider, a.model)
        except Exception as e:
            print(f"attempt {attempt}: model call failed: {e}", file=sys.stderr)
            continue
        errors = lint(prose, agg, a.brief)
        if not errors:
            if a.out:
                tmp = a.out + ".tmp"
                with open(tmp, "w") as f:
                    f.write(prose.strip() + "\n")
                os.replace(tmp, a.out)
            else:
                print(prose)
            print(f"overview_writer: PASS on attempt {attempt} ({len(prose)} chars)", file=sys.stderr)
            return 0
        print(f"attempt {attempt}: lint failed: {errors}", file=sys.stderr)

    print(f"overview_writer: FAILED after {a.attempts} attempts — caller must SKIP the overview", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
