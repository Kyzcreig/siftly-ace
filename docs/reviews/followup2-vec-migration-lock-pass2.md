# Follow-up fixes pass-2 (vec0 legacy migration + integer guard + drain lock TTL) — Senior Opus

VERDICT: APPROVE_WITH_CHANGES. All 3 fixes confirmed correct.
- HIGH vec0 legacy idmap-rename migration: shadow-table drop is rebuild/create-path only; self-heal test confirms re-embed+query works; no healthy-store wipe. Independently reproduced working by Apollo (legacy bookmark_vec_rowids orphan -> store.mode=sqlite-vec, not demoted).
- MEDIUM integer limit guard: Math.trunc+isInteger, behavior-preserving for valid positives.
- MEDIUM video-queue lock: bounded acquisition timeout + stale reclaim replaces infinite-hang deadlock; strictly safer.

Remaining MEDIUM hardening (folded into e2e task t_<e2e>):
- REC-TOCTOU: narrow race in stale-lock reclaim under concurrent multi-process drain (single-process cron unaffected today). Fix: verify dir identity (inode/mtime) across read->rm, or rename-then-remove.
- REC-PID-COV: add a test for the PID-death reclaim branch (owner.json with dead pid + fresh createdAt).
