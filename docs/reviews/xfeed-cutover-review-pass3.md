I'll verify each of the 5 Pass-2 changes against v3, checking both that they landed and that no old contradictory wording survives or new defects were introduced.

Let me work through each NI systematically against the ground-truth facts.

**NI-1 (P2C1):** Pass-2 required: gate re-throw on "error IS the timeout," not "signal currently aborted"; define/confirm `timedOut`; add throw-then-abort-race test.

v3 P2C1 catch:
```
if (timedOut || err instanceof DailyIngestFailureError && err.failure.kind === 'timeout') throw err
```
- Ground truth: `timedOut` IS defined at :146 ✓ (v3 correctly corrects the reviewer's false premise). `timeoutFailure()` returns `DailyIngestFailureError` with `failure.kind==='timeout'` ✓ — so `err instanceof DailyIngestFailureError && err.failure.kind === 'timeout'` is a valid, true classification. The spoofable `abortController.signal.aborted` is GONE from the catch. ✓ Throw-then-abort-race test (b) added. ✓
- **Leftover check:** The §B1 block (the v2 version) still shows the OLD catch: `if (timedOut || abortController.signal.aborted) throw err`. This is the exact wording P2C1 replaced. P2C1 says "Final B1 catch:" and presents the corrected version, but §B1 above it was NOT edited — it still contains `abortController.signal.aborted` in the catch. That's a residual contradiction: two different "final" catch blocks in the same doc.

**NI-2 (P2C2):** Required: remove "instead of (or in addition to)" from §2.2.1.
- §2.2.1 now reads "in addition to (additive; legacy ratings retained until P2.4)". ✓
- **Leftover check:** §2.1 (Problem) last bullet STILL says: *"x-feed's prompt must be changed to emit the 4 enum labels per tweet instead of (or in addition to) the per-metric ratings."* The exact forbidden "instead of (or in addition to)" phrase survives in §2.1. Pass-2 NI-2 named §2.2.1 specifically, but the required-change intent was that the optionality wording be GONE, not just contradicted. It's still present in §2.1.

**NI-3 (P2C3):** Required: freshness window as "≥ stage-start timestamp captured in TS before spawn," not fixed duration.
- P2C3: captures `stageStart = Date.now()` before spawn, asserts `updated_at >= stageStart - skewMs`, skewMs for clock granularity only, no upper bound. ✓ Mechanism is sound and matches ground truth (cron passes no `now` → `updated_at` is wall-clock).
- **Leftover check:** §B5 still says "`updated_at` within this run's wall-clock window" — the vague phrasing P2C3 supersedes. This is a softer residual (B5 is the older resolution layer and P2C3 explicitly refines it), but the imprecise "window" language remains in B5.

**NI-4 (P2C4):** Required: enumerate call sites, thread `low_reach_cap_val` into each, end-to-end test.
- Ground truth: `low_reach_cap()` is called from exactly ONE site (score_item, line 439). P2C4 says "called from exactly ONE site: inside `score_item()`." ✓ Matches ground truth exactly. Threading path specified, end-to-end cap-moves test added. ✓ No new false claim. **Clean.**
- Minor: P2C4's worked example ("clears DEFAULT cap 45 but not overridden 40 is dropped when also_gate=45") is slightly loose — if `also_gate=45` then `low_reach_cap_val = 45-5 = 40`, so the override-to-40 is what `also_gate=45` produces, and default cap would be `ALSO_GATE-5`. The example is internally consistent if default ALSO_GATE=50→cap 45. Not a defect, just confirm the arithmetic holds: 50→45 default, 45→40 override. Consistent. ✓

**NI-5 (P2C5):** Required: promote OQ4 answer into normative §2.2.4; confirm caps read generically.
- §2.2.4 (item 4 in §2.2) now states normatively: same event-collapse/forced-distribution, "keys off the constructed selected set and the passed caps generically — it must NOT assume a literal `MAX_TOP==5`/`MAX_ALSO==2`," with the 5-account pile-on Quick-Hits dedupe test. ✓ **Clean.**

Now the new-contradiction scan: P2C1's classification claim is technically correct per ground truth. P2C3's monotonic-bound logic is correct. P2C4 matches the one-call-site fact. No new false technical claims introduced by the fixes themselves. The defects are all **leftover old wording**, exactly the failure mode Pass-3 was told to catch ("must be GONE, not just contradicted").

# Pass-3 Delta

## Verdict
APPROVE WITH CHANGES

## Change Verification
- **NI-1 — INCOMPLETE.** P2C1's corrected catch is right (`timedOut` confirmed defined at :146; gates on `err instanceof DailyIngestFailureError && err.failure.kind==='timeout'`; race test added) — but §B1 still shows the OLD catch `if (timedOut || abortController.signal.aborted) throw err`, leaving two conflicting "final" catch blocks in the doc.
- **NI-2 — INCOMPLETE.** §2.2.1 fixed to "in addition to (additive…)", but the forbidden phrase "instead of (or in addition to)" still survives verbatim in §2.1's last bullet.
- **NI-3 — LANDED (with stale echo).** P2C3 specifies the monotonic `stageStart - skewMs` lower bound correctly; §B5's older "within this run's wall-clock window" phrasing remains but is explicitly superseded.
- **NI-4 — LANDED.** Single call site (score_item) matches ground truth exactly; `cap_val` threading + end-to-end cap-moves test specified. Clean.
- **NI-5 — LANDED.** OQ4 answer promoted to normative §2.2.4; caps-read-generically assertion + Quick-Hits pile-on dedupe test present. Clean.

## Residual
1. **§B1 stale catch (blocks NI-1).** §B1's code block still reads `if (timedOut || abortController.signal.aborted) throw err` — the exact spoofable-signal wording P2C1 replaced. Edit §B1's catch to match P2C1 (`err instanceof DailyIngestFailureError && err.failure.kind==='timeout'`), or add a one-line "superseded by P2C1" pointer in §B1, so the doc doesn't ship two contradictory final catches.
2. **§2.1 stale optionality (blocks NI-2).** §2.1's last bullet still contains "instead of (or in addition to) the per-metric ratings." Change to "in addition to" to kill the last instance of the forbidden optionality wording.
3. **§B5 imprecise window (minor).** §B5 still says "`updated_at` within this run's wall-clock window." Replace with the P2C3 monotonic-bound phrasing (or mark superseded) so freshness has one definition, not two.

Two genuine leftover contradictions (Residual 1 and 2) hit the precise thing this pass was told to verify — old wording GONE, not merely contradicted — so they're required, not cosmetic. The fixes themselves introduced no new false technical claim. Mechanically all five decisions are correct; this is a find-and-replace cleanup of three stale echoes, after which it's a clean APPROVE.
