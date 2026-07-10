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

    # 3b. The overview as a WHOLE must not end on a dangling ellipsis. Rule 3 only guards
    #     bullet lines; a trailing "…"/"..." on the LEAD PARAGRAPH (or wherever the prose
    #     ends) is equally a pasted/truncated fragment and reads as broken on the page.
    if re.search(r"(…|\.\.\.)\.?\s*$", p):
        errors.append("overview ends with a dangling ellipsis (…) — finish the thought; "
                      "an ellipsis at the end reads as a truncated/pasted fragment")

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

    # 6. Stat-dump density: a lead that stacks raw item-counts reads like a spreadsheet.
    #    Rule 3 allows at most ONE soft quantity; 2+ bare counts = reject.
    stat_res = [
        r"\b\d{1,4}\s+[a-z][a-z-]*\s+items?\b",        # "85 coding items"
        r"\b\d{1,4}\s+(?:on-topic|off-topic)\b",        # "196 on-topic"
        r"\b\d{1,4}-item\b",                            # "225-item sample"
        r"[a-z]{3,}\s*\(\s*\d{1,4}\s*\)",               # "models (109)", "agents (63)"
        r"\b\d{1,4}\s+(?:posts?|tweets?|repos?|stories|launches|items?)\b",
    ]
    stat_hits = []
    for rx in stat_res:
        stat_hits += re.findall(rx, low)
    if len(stat_hits) >= 2:
        errors.append(
            f"stat-dump detected ({len(stat_hits)} raw item-counts) — the overview must read as PROSE, "
            "not a readout; describe the shape of the day in words, at most one soft quantity")

    return errors


def build_prompt(agg: dict, brief: str, prior_errors: list[str] | None = None) -> str:
    header = HEADERS.get(brief, HEADERS["morning-digest"])
    if brief == "morning-digest":
        scope = "the global AI news day, drawn from X, HN, Reddit, GitHub, and newsletters"
        lead_ex = ('e.g. "The day tilted from model takes toward implementation — builders shipping '
                   'vertical agent tools rather than arguing benchmarks. GLM-5.2 became free to run '
                   'through Cloudflare Workers AI [1], while Gemini Spark brought an agentic assistant '
                   'onto the Mac desktop [7]. A build-day, not a think-piece day."')
    else:
        scope = "Ace's X timeline — the feed's mood, recurring themes, and loudest voices"
        lead_ex = ('e.g. "Ace\'s graph stayed mostly on Fable, Hermes, and practical agent ops. '
                   'Mollick framed delegation as an org-design problem, routing work between '
                   'expensive and cheap agents [1]; Teknium shipped Hermes Agent v0.18.0 with MoA '
                   'and /learn [3]. Security ran underneath it all — browser-agent prompt-injection '
                   'is now a workflow concern, not a curiosity [6]."')
    fb = ""
    if prior_errors:
        fb = ("\n\nYOUR PREVIOUS DRAFT FAILED THESE DETERMINISTIC CHECKS — fix ALL of them:\n- "
              + "\n- ".join(prior_errors))
    return f"""You are the editor of a daily AI brief for Ace, an AI-builder. Write the overview section — a tight, well-written editorial read of {scope}, from the aggregate JSON below. Think "sharp newsletter columnist," NOT "dashboard." It should read as flowing PROSE a person wrote, naming the specific people/tools/models that mattered and what they actually did.

SHAPE (exactly):
{header}
<A substantial lead paragraph (3–5 flowing sentences) — the heart of the overview. Lead with what the period was ABOUT: the recurring themes, who was loud, what actually moved, and the mood/shift underneath it. Weave named people and their real claims into the sentences. This paragraph carries most of the content; {lead_ex}>
• **<Theme>** — <ONE crisp sentence naming who's doing what in this lane.>
• **<Theme>** — <same>
<2–4 bullets total — they're a SHORT coda to the paragraph, not the main event. Keep them tight.>
<optional one-line Mood: closer>

HARD RULES (a deterministic linter rejects violations):
1. NEVER use "@handle highlighted/shared/posted/noted/flagged <fragment>" as a sentence spine. Lead with the EVENT/CLAIM; @handle and [N] ride inside the sentence as attribution. ❌ "@alex_atoms highlighted how to use GLM-5.2 for free [1]." ✅ "GLM-5.2 is now runnable for free via Cloudflare Workers AI, per a circulating guide [1]."
2. NEVER paste raw titles/labels/tweet fragments verbatim — paraphrase into a claim. If a fragment is too thin to turn into a real claim, DROP that story and pick another.
3. PROSE-FIRST, NOT STATS: the lead is a written READ, not a readout. Do NOT open with or lean on raw item counts ("85 coding items and 74 agent items", "196 on-topic, 29 off-topic"). At most ONE soft quantity may ride inside a sentence ("the busiest lane by far"); a draft that stacks multiple bare numbers reads like a spreadsheet and will be REJECTED. Describe the shape of the day in WORDS.
4. The LEAD PARAGRAPH does the heavy lifting; bullets are a short coda (2–4, each one tight sentence naming who's doing what). Do NOT dump the content into bullets and leave a thin lead — the paragraph should be the richest part, like a columnist's opening.
5. Theme bullets: full written sentences (≥60 chars), never a bare repo slug or a truncated "…" fragment.
6. Cite stories with [N] using ONLY the integer `ref` values in `top_stories`; each ref at most once; 3–6 citations total. Do not write URLs.
7. ≤1900 chars total. No meta-talk about scoring/selection/salience/clusters. Every sentence carries a proper noun and tells Ace something NEW.{fb}

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
    statdump = ("🗞️ **The Landscape**\n"
                "AI Builder Twitter tilted toward implementation: 85 coding items and 74 agent items made the day "
                "feel less about benchmarks, with models (109) and agents (63) leading the mix [1]. Gemini Spark also shipped [2].\n"
                "• **Coding** — Vibe-Trading from HKUDS turned an LLM loop into a live trading agent, the lane's most-starred repo today.\n"
                "• **Agents** — Agent frameworks dominated GitHub trending, with three of the top five repos being orchestration layers.")
    checks = [
        ("bad: roll-call", any("roll-call" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: paste", any("paste" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: thin bullet", any("too thin" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: ellipsis bullet", any("ellipsis" in e for e in lint(bad, agg, "morning-digest"))),
        ("bad: dangling para ellipsis", any("dangling ellipsis" in e for e in lint(
            "🗞️ **The Landscape**\nGLM-5.2 is now free to run through Cloudflare Workers AI, "
            "per a widely-shared setup guide [1], and the day skewed toward shipping over think-pieces. …",
            agg, "morning-digest"))),
        ("good passes", lint(good, agg, "morning-digest") == []),
        ("bogus ref", any("don't exist" in e for e in lint(good.replace("[2]", "[9]"), agg, "morning-digest"))),
        ("dup ref", any("more than once" in e for e in lint(good.replace("[2]", "[1]"), agg, "morning-digest"))),
        ("missing header", any("header" in e for e in lint(good.replace("🗞️ **The Landscape**", "Landscape"), agg, "morning-digest"))),
        ("too long", any("too long" in e for e in lint(good + "\nx" * 2000, agg, "morning-digest"))),
        ("stat-dump rejected", any("stat-dump" in e for e in lint(statdump, agg, "morning-digest"))),
        ("one soft count ok", not any("stat-dump" in e for e in lint(good, agg, "morning-digest"))),
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
