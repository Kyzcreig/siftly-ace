# Ace X Knowledge Base PRD — Review Summary

**Pipeline:** Opus (claude-opus-4-8 via F1 bridge — main sub was weekly-exhausted), 2 passes, fixes between.

- **Pass 1:** BLOCK — 4 blockers (OAuth2/forge-reuse risk, shared-token credit depletion vs briefs, live-prompt edit safety, pf-score can kill brief) + 8 required changes. Artifact: `pass1.md`.
- **v2:** all 4 blockers + 7/8 RCs resolved.
- **Pass 2:** APPROVE WITH CHANGES — RC4 doc contradiction (set-reconciliation added but old short-circuit language left in) + pin credit-reserve in Phase 0. Artifact: `pass2.md`.
- **v3:** RC4 contradiction fixed (§5.1 State), credit-balance-readability caveat added (§5.1), reserve number deferred to Phase 0 gate. **→ Review cleared.**

**Status: APPROVED to build (Phase 0 OAuth2 hard gate is the first real-work step).**
