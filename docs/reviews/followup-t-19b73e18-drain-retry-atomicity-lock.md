# t_19b73e18 (drain retry/atomicity/lock) — Pass-2 Senior Opus Review

Let me analyze the diff carefully for the three claimed fixes and any regressions.

Key concerns:
1. **R1 retry logic**: Test starts attempts:1, maxAttempts:3. First fail: attempts<3 so canRetry, attempts->2, pending. Second: 2<3, ->3, pending. Third: 3<3 false, status=error, attempts stays 3. Matches test. Correct.

2. **R2 idempotency**: Now checks `videoTranscriptChars` before transcribing; if transcript already present, marks done without re-running transcribe. Test confirms. Correct.

3. **R3 lock**: mkdir-based advisory lock. Test creates lock dir, expects enqueue to block until removed. 

Now adversarial issues:

**Lock retry loop is infinite (no timeout/attempts cap).** If a stale lock exists (crashed process), `mkdir` always EEXIST -> infinite loop forever. No stale-lock detection despite writing owner.json with pid. This is a deadlock/liveness risk - data not lost but process hangs indefinitely. The owner.json is written but never used for recovery. MEDIUM regression.

**Lock not released on SIGKILL/crash** -> permanent deadlock for all future runs. Same root cause.

**Counting bug in retry path**: When transcript already exists (idempotent skip path), it does `continue` without incrementing `transcribed`. processed was already incremented. Test expects `{processed:1, transcribed:0, failed:0}`. Correct - not double counting.

**enqueue now acquires lock but `readVideoQueueState` inside — fine.** But note: drain and enqueue both lock same path, good serialization within process. Cross-process: mkdir is atomic on most filesystems, reasonable.

**`maxAttempts` in drain**: when canRetry, error message is still set on a pending record. On the third attempt the test expects error field present on error status - yes `...record` spreads but record is the prior pending which had error from attempt 2; explicitly overwritten with new error. Fine.

Let me check the lock test's `enqueueVideoItems` is imported — assume yes. The lock test relies on real timing (delay 50ms) which is slightly flaky but acceptable.

```json
{"verdict":"APPROVE_WITH_CHANGES","fixes_confirmed":["R1","R2","R3"],"fixes_not_confirmed":[],"new_regressions":[{"id":"R3a","severity":"MEDIUM","file":"src/lib/enrich/index.ts","issue":"acquireVideoQueueLock loops forever on EEXIST with no timeout/attempts cap and no stale-lock detection. A crashed/SIGKILLed process (or leftover .lock dir) leaves the mkdir lock permanently held, so every future enqueue/drain deadlocks indefinitely. owner.json{pid,createdAt} is written but never used for recovery, so it provides no liveness benefit.","fix":"Add a lock acquisition timeout (throw after N retries / wall-clock budget) and/or stale-lock reclamation: read owner.json, and if createdAt older than a TTL or pid not alive, force-rm and retry once. Surface a clear error instead of hanging."},{"id":"R3b","severity":"MEDIUM","file":"src/lib/enrich/index.ts","issue":"Lock is process-local-atomic but provides no protection if the holding process dies between mkdir and release (no finally at process level / no signal handler). Combined with R3a this converts a transient crash into a permanent outage of the video pipeline.","fix":"Pair the TTL/stale reclamation from R3a with best-effort cleanup; document that orphaned <queue>.lock dirs are auto-reclaimed after TTL."},{"id":"R3c","severity":"MEDIUM","file":"src/lib/enrich/enrich.test.ts","issue":"Lock test asserts blocking via a real 50ms sleep (timing-dependent) and only exercises the happy unlock path; it never asserts the loop terminates on a stuck/stale lock, so the deadlock in R3a is untested and could not have been caught.","fix":"Add a test that a never-released/stale lock causes acquisition to error within a bounded time (after TTL or attempts cap), not hang."}],"notes":"R1 retry-until-cap, R2 hasVideoTranscript()/videoTranscriptChars idempotency skip (no re-transcribe + no double-count), and R3 mkdir advisory lock + atomic writeVideoQueueState are all correctly implemented and the assertions are genuine (not rigged). Retry math verified: attempts 1->2->3 pending then error at cap, transcribe called exactly 3x. Idempotent skip returns transcribed:0 correctly. Blocking concern is purely the lock's missing liveness/stale-recovery: it is safe for data integrity (atomic rename writes preserved, no data loss) but introduces an indefinite-hang/permanent-deadlock availability regression on crash. Approve once R3a stale-lock TTL/timeout is added."}
```