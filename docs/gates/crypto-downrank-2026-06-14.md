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

## Follow-up — "token" disambiguation (2026-06-14, same day)
Ace flagged a collision risk: the Step-3 hard-discard list above used the bare word **"tokens"** as
a crypto trigger. In Ace's world "token" almost always means **LLM/AI tokens** (context windows,
token limits, tokenizers, per-token pricing, tokens/sec) — CORE content — so a bare "tokens" keyword
could nuke legit AI posts.

Audit (only the prompt was at risk; code layers were already clean):
- `scripts/pf-score.py` — only `token` is in the `security-privacy` alias (auth tokens). finance
  alias has no crypto/token terms. NO change needed.
- `scripts/profile.ts` EXCLUDED_TOPICS — excludes crypto/web3/blockchain/defi/nft, NO bare `token`.
  NO change needed.
- `~/.hermes/state/cron/morning-digest/prompt.md` — the ONE real risk. Fixed (CONFIG, G1-class;
  backup `prompt.md.bak-g1-crypto-token-disambig-20260614-145858`):
  `tokens, coins` -> `crypto tokens/coins`; `token launches` -> `coin/token launches`;
  `trading` -> `crypto trading`; added explicit disambiguation: "token" alone is NOT a crypto
  signal (it means LLM/AI tokens = CORE); only treat it as crypto when clearly a coin/asset
  (paired with a chain, exchange, ticker, price, or trading).

Net: "200k token context" / "cheaper per-token inference" stays core; "$TOKEN launches on BNB"
still dropped.

## Verify next run
- Next morning-digest (3:33am): no pure-crypto item in Top/Also-Noted; a crypto post should be
  discarded at Step 3 (or, if AI-crossover, judged on the AI merits). An AI-tokens post must NOT be
  discarded as crypto.
- Rollback: restore the prompt.md .bak(s); revert 51ee06c.
