# Plan — "Also Noted feels stubby / weak" — diagnosis + fix options

**Ace, 2026-06-22:** "the Also Noted section feels stubby and weak."

## What's actually happening (measured, not guessed)

The screenshot's weak items (`palmier-io/palmier-pro`, `mukul975/...`) were from a **stale pre-fix
render** — on the CURRENT live engine those github repos score 83-85 and land in **Top Stories**, and
today's real Also-Noted is two Perplexity roundups (78, 77). So the *specific* screenshot items are
already gone.

But the underlying feeling is real and the data shows why. The **45-77 contention zone** (what
Also-Noted fishes from) is dominated by **Reddit `analysis/reference` forum chatter**:

```
65  reddit  Conflict of Interest
63  reddit  Expiring tokens are a disgrace.
62  reddit  Human beings are a disease, a cancer of this planet…
62  reddit  The Simple Outreach System My Friend Uses to Generate…
58  reddit  Hello!
58  reddit  AI might make me fail my class
58  reddit  GPT 5.6 Cancelled
```

These are venting / self-promo / low-signal threads. They cluster at 58-65, just under the Also gate
(50) — and on a quiet day they're exactly what fills Also-Noted.

## Root cause

The model labels almost everything from Reddit `analysis` + `reference` + `concrete`, which is
`BASE=50 (+3 concrete +recency)` → 58-65. Two systemic over-valuations:
1. **Reddit discussion threads aren't "analysis/reference"** in the way a real writeup is — most are
   questions, complaints, or self-promo. The model over-grades them.
2. **`substance=concrete` is applied to ~everything** (the model never marks `mixed`/`vague`), so the
   substance penalty that *should* separate a real writeup from "Hello!" never fires.

(GitHub side: a separate, smaller issue — thin trending repos like `mikumifa/biliTickerBuy`, an 11-char
desc bilibili ticket bot, get full `launch/actionable_now` base 70. Only 2 such items today; lower
priority than the Reddit flood.)

## Fix options (pick one or combine)

### A. Raise the Also-Noted floor (simplest, highest leverage)
Bump `ALSO_GATE` 50 → ~58-62. Drops the whole 58-65 Reddit-chatter band below the line. Cost: on a
genuinely quiet day Also-Noted may be empty (which is honest — better than filler). **Recommend as the
first move; it's one constant + a gate re-derivation, fully reversible.**

### B. Demote low-signal Reddit `analysis/reference` in the scorer
A Reddit-source guard: a reddit `analysis`/`reference` thread with low engagement (upvotes < ~30,
comments < ~15) and no real substance signal gets a base cap (treat as `context_only` ~36, or −10).
Targets the chatter specifically without touching curated github/HN. More surgical than A.

### C. Thin-repo demotion (small, complementary)
github `launch/actionable_now` with a thin description (<140 chars) AND low momentum (stars_today <
~300) → base `reference` not `actionable_now`. Catches `biliTickerBuy`/`spiderfoot`-class. ~2 items/day.

## My recommendation
**A + B together:** raise the Also gate to ~58 (kills the bulk of the chatter) AND add the Reddit
low-signal demotion (so the *next* tier of chatter can't just float up to the new gate). C is a nice-to-
have. All three are scorer/gate changes that shift what posts → ship behind the dark-flag discipline
(land the code, re-derive the gate, prove before/after on real pools, then Ace's go on the live gate).

**Open question for Ace:** how aggressive? Conservative (gate→56, light Reddit demote) keeps Also-Noted
fuller; aggressive (gate→62, hard Reddit demote) makes it sparse-but-strong. Which way?
