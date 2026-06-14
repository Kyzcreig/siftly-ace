# Crypto downrank — 2026-06-14

Trigger: a BNB/Binance "This Week on @BNBCHAIN" post made the live digest (Top story #4,
B(86)). Ace: "I don't care about crypto at all."

## Root cause (from the item's actual score)
base_score 84 + boost 8 = 92; personal_fit_delta only +4.17 -> final 88. So the BIG lever was
the LLM rubric scoring crypto as on_topic:core/actionable_now (84), NOT the PF model (+4).

## Two fixes (both reversible)
1. PRIMARY — `~/.hermes/state/cron/morning-digest/prompt.md` Step 3 hard-discard list (CONFIG, a
   G1-class edit; backed up `prompt.md.bak-crypto-discard-20260614-052538`):
   added a crypto/web3/blockchain/token/exchange/DeFi/NFT hard-discard with a narrow carve-out
   for (a) genuine AI<->crypto crossover where the AI angle is the story, (b) security incidents
   hitting Ace's stack. Takes effect next digest run.
2. SECONDARY — siftly-ace `scripts/profile.ts` EXCLUDED_TOPICS (commit 51ee06c, pushed): crypto
   topics dropped from the preference profile's taste vector; finance (Ace's #1, weight 2014)
   preserved. `scripts/pf-score.py` finance alias stripped of trading/bitcoin/crypto. Live profile
   rebuilt — crypto topics gone, finance intact. Daily-ingest will keep it excluded on rebuild.

## Verify next run
- Next morning-digest (3:33am): no pure-crypto item in Top/Also-Noted; a crypto post should be
  discarded at Step 3 (or, if AI-crossover, judged on the AI merits).
- Rollback: restore the prompt.md .bak; revert 51ee06c.
