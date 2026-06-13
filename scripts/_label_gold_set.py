#!/usr/bin/env python3
"""
One-shot: attach the 4 ideal enum labels + label_rationale to each gold item, per
PRD-gold-set-certification D-1/D-2 (Apollo proposes ideal labels; Ace ratifies).
Ideal = the labels a perfect classifier would emit for the text, so the gate tests
the SCORER, not the labeler. Writes the labeled set back to digest-gold-set.json
with status still DRAFT (ratification flips it on Ace's word).
"""
import json, os

GOLD = os.path.expanduser("~/Projects/siftly-ace/docs/eval/digest-gold-set.json")

# id -> (content_type, actionability, substance, on_topic, rationale)
LABELS = {
    "incident-yohei-2like": (
        "field_report", "reference", "concrete", "core",
        "Real hands-on agent field report (trace-db debugging, resumable eval runs) — "
        "genuinely on-topic & substantive, but only 2 likes. The LABELS are correct; the "
        "low-reach cap (2 likes, unknown-ish reach) is what must keep it out of TOP, NOT a "
        "bad label. neutral overall because no crowd signal."),
    "incident-bitnewsbot-spam": (
        "promo", "none", "vague", "off",
        "Crypto pump spam — promo content_type → BASE 5, off-topic (no AI/builder tokens) → −40. "
        "Must score ~0 regardless of engagement."),
    "incident-emollick-routing": (
        "analysis", "actionable_now", "concrete", "core",
        "Thought-leader concrete walkthrough of how a routing model changes agent design — "
        "actionable, on-topic, real engagement (249 likes). Should clear ALSO/TOP."),
    "incident-elon-reply-fragment": (
        "reply_fragment", "none", "vague", "adjacent",
        "Bare one-word reply ('True') — reply_fragment → BASE 0 regardless of 5k likes. "
        "is_bare_fragment backstop also forces this. High engagement must not rescue it."),
    "incident-elon-politics": (
        "opinion", "none", "vague", "off",
        "Political rage-bait, no AI/builder content → on_topic=off (−40) + TL author bump "
        "gated off. Must stay out of TOP regardless of 8k likes."),
    "real-anthropic-policy": (
        "news", "context_only", "mixed", "core",
        "Real lab policy-framework announcement — on-topic but policy-PR, not actionable "
        "builder content. Fine as ALSO, not a TOP must-have → neutral."),
    "real-ibab-river-launch": (
        "launch", "actionable_now", "concrete", "core",
        "Genuine product launch (River API: post-training/RL/continual-learning tools) from a "
        "known builder, real engagement, actionable. launch×actionable_now → high BASE."),
    "real-steipete-orchestrator-loop": (
        "tutorial", "actionable_now", "concrete", "core",
        "Concrete actionable builder workflow (codex maintainer loop) — strong engagement, "
        "on-topic. Top-tier digest material. tutorial×actionable_now."),
    "real-hn-fable-guardrails": (
        "news", "reference", "concrete", "core",
        "Front-page HN (234 pts), on-topic AI safety/security discussion of Fable guardrails. "
        "HN source → low-reach cap exempt; should clear ALSO/TOP by base+points."),
    "real-hn-apache-burr": (
        "launch", "actionable_now", "concrete", "core",
        "Show-HN agent tooling (Apache Burr: build reliable AI agents) — on-topic, actionable "
        "for a builder. HN source, exempt from low-reach cap."),
    "real-hn-css-bad-parts": (
        "analysis", "reference", "mixed", "off",
        "Decent HN post but pure web-CSS, off the AI/agent core → on_topic=off. Must not "
        "displace on-topic items in TOP. neutral."),
    "real-hn-klondike-curses": (
        "analysis", "context_only", "mixed", "off",
        "Fun hobby C/curses project, no AI/builder relevance → off. neutral, never TOP."),
    "real-hn-world-capitals-voronoi": (
        "analysis", "context_only", "vague", "off",
        "Off-topic visualization toy → off. neutral, never TOP."),
    "real-voxyz-claude-learning-repo": (
        "tutorial", "actionable_now", "concrete", "core",
        "Actionable Claude Code template (build a learning repo for any field) — on-topic & "
        "concrete, but 36 likes / unknown handle. Labels correct; the unknown-handle engagement "
        "cap is what keeps it ALSO-not-auto-TOP. neutral overall (borderline)."),
    "real-vigilantfox-ivermectin": (
        "news", "none", "vague", "off",
        "Health/politics rage-bait (ivermectin), high engagement (2170 likes) → on_topic=off "
        "(−40) must override engagement. The exact off-topic-with-engagement case. known_bad."),
}


def main():
    data = json.load(open(GOLD))
    missing = []
    for item in data["items"]:
        lab = LABELS.get(item["id"])
        if not lab:
            missing.append(item["id"]); continue
        ct, ac, su, ot, why = lab
        item["content_type"] = ct
        item["actionability"] = ac
        item["substance"] = su
        item["on_topic"] = ot
        item["label_rationale"] = why
    if missing:
        raise SystemExit(f"no labels for: {missing}")
    # update _meta bar definitions to the v5 score-framed bars + adaptation note
    data["_meta"]["shadow_pass_bar"] = [
        "Bar1: no known_bad has final >= TOP_GATE (score-framed, D-11)",
        "Bar2: every known_good has final >= ALSO_GATE (score-framed)",
        "Bar3: no neutral has final >= TOP_GATE (score-framed)",
        "Bar4: no known_bad's final exceeds any known_good's final (anti-inversion)",
    ]
    data["_meta"]["bar_strength"] = (
        "Bars 1 & 3 structurally-satisfied on this fixture (known_bad/neutral floor-pinned); "
        "Bars 2 & 4 are the load-bearing nets. See PRD D-4."
    )
    data["_meta"]["labels_proposed_by"] = "Apollo (ideal labels; awaiting Ace ratification)"
    json.dump(data, open(GOLD, "w"), ensure_ascii=False, indent=2)
    print(f"labeled {len(data['items'])} items; status still {data['_meta']['status']!r}")


if __name__ == "__main__":
    main()
