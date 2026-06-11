#!/usr/bin/env python3
"""
xfeed_label.py — label a joined x-feed pool with the 4 enum labels via the Opus
bridge (the qualitative task the model is reliable at). Batches the pool, asks
for STRICT enum JSON keyed by tweet_id, merges labels back onto each row, and
writes a labeled pool the deterministic engine can score. Idempotent: caches
labels to disk by tweet_id so reruns don't re-spend.

This is the offline equivalent of the live prompt's Step 5b — used to derive
x-feed gates NOW from cached pools instead of waiting days for live runs.
"""
import argparse, json, os, subprocess, sys, tempfile, time

CACHE = "/tmp/xfeed-label-cache.json"

CONTENT_TYPES = "launch|benchmark|tutorial|field_report|analysis|news|opinion|promo|reply_fragment"
SYSTEM = f"""You label tweets for an AI-builder content brief. For EACH tweet, emit ONLY these 4 enum labels — no prose, no scores:
- content_type: one of {CONTENT_TYPES}
  launch=new product/model/tool shipped; benchmark=eval/leaderboard result; tutorial=how-to/recipe; field_report=hands-on experience/result; analysis=substantive explanation; news=event report; opinion=take/commentary; promo=ad/shill; reply_fragment=bare reply with no standalone substance.
- actionability: one of actionable_now|reference|context_only|none
  actionable_now=reader can use it today; reference=worth saving; context_only=background; none=nothing to act on.
- substance: one of concrete|mixed|vague
  concrete=specifics/numbers/code; mixed=some; vague=empty.
- on_topic: one of core|adjacent|off
  core=AI/agents/building; adjacent=tangential incl. memes; off=politics/health/unrelated. A personal attack, political insult, name-calling, dunking, culture-war take, or health/medical claim (ivermectin, vaccines) is ALWAYS off — even from a builder you respect."""


def call_bridge(tweets, retries=4):
    lines = [f'id={t["tweet_id"]} @{t.get("authorHandle")}: {(t.get("tweet_text") or "")[:280]}'
             for t in tweets]
    prompt = (SYSTEM + "\n\nReturn ONLY a single-line JSON object (no prose, no "
              "markdown, no per-line lists) mapping each tweet's id (string) to "
              "{\"content_type\":..,\"actionability\":..,\"substance\":..,\"on_topic\":..}. "
              "Start your reply with { and end with }.\n\n" + "\n\n".join(lines))
    for attempt in range(retries):
        try:
            r = subprocess.run(
                ["hermes", "-z", prompt,
                 "--provider", "claude-api-proxy-f2", "-m", "claude-opus-4-8"],
                capture_output=True, text=True, timeout=240)
            text = r.stdout
            s, e = text.find("{"), text.rfind("}")
            if s >= 0 and e > s:
                return json.loads(text[s:e + 1])
            raise ValueError(f"no JSON in output: {text[:200]}")
        except Exception as ex:
            if attempt == retries - 1:
                print(f"  batch failed after {retries}: {ex}", file=sys.stderr)
                return {}
            time.sleep(3 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="/tmp/xfeed-labeled-pool.json")
    ap.add_argument("--out", default="/tmp/xfeed-scored-pool.json")
    ap.add_argument("--batch", type=int, default=40)
    args = ap.parse_args()

    pool = json.load(open(args.inp))["all_scored"]
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}

    todo = [t for t in pool if str(t["tweet_id"]) not in cache]
    print(f"pool={len(pool)} cached={len(pool) - len(todo)} to-label={len(todo)}")
    for i in range(0, len(todo), args.batch):
        batch = todo[i:i + args.batch]
        labels = call_bridge(batch)
        for t in batch:
            lab = labels.get(str(t["tweet_id"])) or {}
            cache[str(t["tweet_id"])] = lab
        json.dump(cache, open(CACHE, "w"))
        print(f"  labeled {min(i + args.batch, len(todo))}/{len(todo)}")

    labeled = 0
    for t in pool:
        lab = cache.get(str(t["tweet_id"])) or {}
        for k in ("content_type", "actionability", "substance", "on_topic"):
            if lab.get(k):
                t[k] = lab[k]
        if lab.get("on_topic"):
            labeled += 1
    json.dump({"all_scored": pool,
               "selected_top_ids": [t["tweet_id"] for t in pool if t["legacy_final_score"] >= 60][:5],
               "quick_hits_ids": [t["tweet_id"] for t in pool if 50 <= t["legacy_final_score"] < 60][:5]},
              open(args.out, "w"), ensure_ascii=False, indent=2)
    print(f"labeled {labeled}/{len(pool)} rows → {args.out}")


if __name__ == "__main__":
    main()
