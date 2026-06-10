#!/usr/bin/env python3
"""
discord_md.py — First-line Discord-markdown escaper for user-sourced text.

WHY THIS EXISTS
---------------
The briefs interpolate PUBLIC, user-controlled X content (handles, author names,
tweet bodies, derived titles) into a Discord message. Any active Discord
formatting token in that text (`* _ ~ | ` `` ` `` or a leading `# - > ` / `N.`)
can open/close formatting unintentionally — e.g. a handle ending in `__` opens
underline that bleeds across the whole message (the 2026-06-10 underline bug).

This helper backslash-escapes those tokens in a tweet-derived substring BEFORE
it goes into the message, so the text renders literally. It is the FIRST line of
defense (called per-field while composing the brief); the notify.py
`_sanitize_unbalanced_markdown` linter is the BACKSTOP at the send chokepoint.

USAGE
-----
    from discord_md import escape
    line = f"**{i}.** @{escape(handle)} · {likes} likes · {grade}"
    body = escape(tweet_text)

Only escape SUBSTRINGS that come from X. Do NOT escape your own template chrome
(the `**{i}.**`, section headers, emoji) — those are intentional markdown.
"""
from __future__ import annotations
import re

# Inline tokens that open/close Discord formatting. Order: multi-char first so we
# don't double-escape (e.g. escape `__` as a unit, not two `_`).
_INLINE_TOKENS = ("```", "``", "~~", "||", "__", "**", "*", "_", "~", "`", "|", ">")

# Leading-of-line tokens that start a block element (quote, header, list).
_LEADING_RE = re.compile(r"^(\s*)(#{1,6}\s|>\s|-\s|\*\s|\d+\.\s)", re.MULTILINE)


def escape(text: str) -> str:
    """Backslash-escape Discord markdown in user-sourced text.

    Faithful (lossless to the reader): Discord renders `\\_\\_` as literal `__`.
    Idempotency is NOT guaranteed — call once on raw user text, not on already
    escaped text.
    """
    if not text:
        return text

    out = []
    i = 0
    n = len(text)
    while i < n:
        matched = False
        for tok in _INLINE_TOKENS:
            if text.startswith(tok, i):
                # escape each char of the token so Discord sees literals
                out.append("".join("\\" + c for c in tok))
                i += len(tok)
                matched = True
                break
        if not matched:
            out.append(text[i])
            i += 1
    escaped = "".join(out)

    # escape leading block-element markers at line starts
    escaped = _LEADING_RE.sub(lambda m: m.group(1) + "\\" + m.group(2), escaped)
    return escaped


if __name__ == "__main__":
    # tiny self-test
    cases = [
        ("alexalbert__", "alexalbert\\_\\_"),
        ("*bold*", "\\*bold\\*"),
        ("||spoiler||", "\\|\\|spoiler\\|\\|"),
        ("normal text", "normal text"),
    ]
    ok = True
    for src, want in cases:
        got = escape(src)
        status = "PASS" if got == want else "FAIL"
        if got != want:
            ok = False
        print(f"  {status}  escape({src!r}) = {got!r}")
    print("ALL PASS" if ok else "SOME FAILED")
    raise SystemExit(0 if ok else 1)
