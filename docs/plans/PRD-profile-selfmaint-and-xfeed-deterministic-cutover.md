<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>PRD — Self-Maintaining pf Profile + x-feed Deterministic Cutover</title></head>
<body>
<h1>PRD: pf-Profile Self-Maintenance (#1) + x-feed-brief Deterministic-Engine Cutover (#2)</h1>
<p><strong>Status:</strong> v4 — <strong>APPROVED</strong> (3-pass Opus review: BLOCK→AWC→APPROVE; Pass-3 stale-echo cleanups applied). Ready to build. <strong>Owner:</strong> Apollo. <strong>Repo:</strong> Kyzcreig/siftly-ace.
<strong>Project root:</strong> <code>~/Projects/siftly-ace</code>. <strong>Date:</strong> 2026-06-11.</p>
<p><strong>Context:</strong> Follows the 2026-06-11 calibration session that shipped (to <em>morning-digest only</em>): recency→tiebreak,
engagement-cap 6→10, on-topic stem fallback, and a brief-relevant-only pf profile. Two gaps remained:
(#1) nothing keeps the pf profile fresh or enforces the de-contamination flag; (#2) x-feed-brief never got the deterministic
engine and is still model-prose-scoring, so none of the calibration protections reach it.</p>

<hr>
<h2>PART 1 (#1) — Self-Maintaining pf Profile Rebuild</h2>

<h3>1.1 Problem (ground-truthed)</h3>
<ul>
<li><strong>Verified:</strong> <code>scripts/daily-ingest.ts</code> <code>buildDailyIngestStages()</code> runs exactly 4 stages: ingest→enrich→embed→export. It does <strong>not</strong> rebuild the pf profile (grep for <code>profile|runPreference|briefRelevant</code> in daily-ingest.ts → 0 hits).</li>
<li><strong>Consequence A (staleness):</strong> new bookmarks ingested daily never update <code>~/.hermes/state/x-bookmarks/preference-profile.json</code>. The taste vector drifts from current saves over time.</li>
<li><strong>Consequence B (re-contamination footgun):</strong> a manual <code>npx tsx scripts/profile.ts</code> <em>without</em> <code>--brief-relevant-only</code> silently reverts the de-contamination (politics topic returns to rank 4, w≈1057). Nothing enforces the correct invocation.</li>
</ul>

<h3>1.2 Fix</h3>
<p>Add a 5th stage, <code>profile</code>, to <code>buildDailyIngestStages()</code>, appended <strong>after</strong> <code>export</code>, with <code>--brief-relevant-only</code> baked in:</p>
<pre>{ name: 'profile', command: 'npx', args: ['tsx', 'scripts/profile.ts', '--brief-relevant-only'] }</pre>
<p>Add <code>'profile'</code> to the <code>DailyIngestStageName</code> union type.</p>

<h3>1.3 Design decisions</h3>
<ol>
<li><strong>Soft-fail (non-blocking).</strong> The profile is an enhancement layer; <code>pf-score.py</code> already fail-safes to base-score-only if the profile is missing/stale. A profile-rebuild failure MUST NOT abort the ingest or block the brief. <em>Current <code>runDailyIngest</code> aborts the stage loop on any throw (verified: line ~168, <code>for (const stage of stages){…throw…}</code>).</em> So the <code>profile</code> stage must be marked soft: its failure is caught, logged, and alerted (to #alerts) but the run still returns <code>ok:true</code> with <code>export</code> already complete. Implementation: a per-stage <code>soft?: boolean</code> flag on <code>DailyIngestStageCommand</code>; the loop catches throws from soft stages, records them in the result, and continues.</li>
<li><strong>Provenance assertion.</strong> After the stage runs, assert the written profile's <code>signal_basis.mode === 'brief-relevant-only'</code>. If not, the stage soft-fails loudly (alert) — a cheap guard against silent re-contamination if someone edits the stage args.</li>
<li><strong>Atomic write.</strong> <code>profile.ts</code> currently does a plain <code>fs.writeFile</code> on the JSON. Change to write-temp-then-rename so a crash mid-write can't leave a half-written profile that <code>pf-score.py</code> then parses. (The markdown artifact can stay non-atomic; only the JSON is load-bearing.)</li>
<li><strong>Cost/timing.</strong> Profile rebuild is a pure read over <code>dev.db</code> + 2 file writes (~1–2s, no API/embedding cost). Safe within the 20-min ingest wall budget. Runs last so it can never delay <code>export</code>.</li>
<li><strong>Cadence.</strong> Daily is fine; bookmarks change slowly. No separate schedule.</li>
</ol>

<h3>1.4 Tests</h3>
<ul>
<li>Unit: <code>buildDailyIngestStages()</code> includes <code>profile</code> as the LAST stage, command <code>npx tsx scripts/profile.ts --brief-relevant-only</code>.</li>
<li>Unit: a throw from the <code>profile</code> stage → <code>runDailyIngest</code> still returns <code>ok:true</code>, <code>stagesRun</code> includes the 4 hard stages, and the soft failure is recorded (mock <code>runStage</code> to throw only on <code>profile</code>).</li>
<li>Unit: a throw from a HARD stage (e.g. <code>embed</code>) still aborts with <code>ok:false</code> (regression — soft flag must not weaken hard stages).</li>
<li>Unit (profile.ts): atomic write — temp file renamed to final path; a simulated write error leaves the prior profile intact.</li>
<li>Existing 171 tests stay green; <code>daily-ingest.test.ts</code> stage-count assertions updated (4→5).</li>
</ul>

<h3>1.5 Out of scope</h3>
<ul><li>Not changing rebuild cadence. Not touching either brief prompt (they read whatever profile is on disk).</li></ul>

<hr>
<h2>PART 2 (#2) — x-feed-brief Deterministic-Engine Cutover</h2>

<h3>2.1 Problem (ground-truthed)</h3>
<ul>
<li><strong>Verified:</strong> <code>~/.hermes/state/cron/x-feed-brief/prompt.md</code> Step 5 scores by <em>model-authored per-metric ratings × weights → 0–100</em> (the exact "model emits a number in prose" pattern morning-digest abandoned). Gates: Top ≥60 (Step 6), Quick Hits ≥50 (Step 6). pf is an additive layer: <code>final = base + personal_fit_delta</code> (Step 4.5/4.95).</li>
<li><strong>Consequence:</strong> none of the 2026-06-11 deterministic protections reach x-feed-brief — no recency-as-tiebreak, no engagement cap, no on-topic stem backstop, no fragment/off-topic Python override, no event-collapse, no forced-distribution. It can still be gamed by purchased engagement and inflated by recency, and it trusts the model's self-scored number — the failure mode <code>score_digest.py</code> exists to kill.</li>
<li><strong>Key integration gap:</strong> <code>score_digest.score_item</code> requires enum labels (<code>content_type</code>, <code>actionability</code>, <code>substance</code>, <code>on_topic</code>) — which x-feed Step 5 does <strong>not</strong> currently emit. So the cutover is NOT just a flag flip (unlike morning-digest, which already emitted those labels). x-feed's prompt must be changed to emit the 4 enum labels per tweet in addition to the per-metric ratings (additive; see §2.2.1 + §B3).</li>
</ul>

<h3>2.2 Design — mirror the morning-digest cutover exactly</h3>
<ol>
<li><strong>Prompt Step 5 rewrite:</strong> change Step 5 so each tweet emits the 4 enum labels (same definitions as morning-digest prompt §395) <strong>in addition to</strong> the legacy per-metric ratings (additive; legacy ratings retained until P2.4 so the live <code>base_score</code> selector is provably unchanged during shadow — see §B3). <code>base_score</code> stays as an advisory/audit field. At P2.4 the legacy ratings are removed and the deterministic engine becomes the sole selector.</li>
<li><strong>Selection via the shared engine:</strong> x-feed already writes a full scored dump to <code>_last_run_scored.json</code> (Step 6.7, schema mirrors morning-digest's <code>_last_run_debug.json</code>). Add a Step 6.x that runs <code>select_digest.py --engine deterministic</code> over that dump (with <code>RECENCY_AS_TIEBREAK=1</code>), exactly like morning-digest Step 6.7, and renders the returned selected/also(=Quick Hits) sets.</li>
<li><strong>Gate mapping:</strong> x-feed's product shape is "Top up to 5 (≥60)" + "Quick Hits up to 5 (≥50)". Map to <code>score_digest</code> gates. <strong>Gate values must be re-derived</strong> from x-feed's own scored-dump history (NOT inherited from morning-digest's 49/45, since x-feed's pool/score distribution differs — interest-search timeline tweets, not the 4-source digest mix). <strong>Acceptance = membership-quality (see §B4), NOT cardinality parity.</strong> Volume parity (±1) is only a sanity floor.</li>
<li><strong>Quick Hits = "also" with a higher cap:</strong> morning-digest's <code>MAX_ALSO=2</code>; x-feed Quick Hits allows up to 5. The engine call for x-feed passes <code>max_also=5</code> (and <code>max_top=5</code>) via the explicit kwargs (§B2) — never by mutating module globals. <strong>OQ4 answer (normative):</strong> Quick Hits flow through the SAME event-collapse + forced-distribution as Top; <code>max_also</code> is only the slot cap. The distribution/event-collapse code path keys off the constructed <em>selected</em> set and the passed caps generically — it must NOT assume a literal <code>MAX_TOP==5</code>/<code>MAX_ALSO==2</code>. A test asserts a 5-account pile-on event-dedupes within Quick Hits (not just within Top). <em>This is a real code change to score_digest/select_digest, not just prompt.</em></li>
<li><strong>pf stays additive and unchanged:</strong> x-feed already injects <code>personal_fit_delta</code> via <code>pf-audit.py</code>. <code>score_digest</code> consumes <code>personal_fit_delta</code> as its bounded <code>pf</code> term (same as morning-digest). The pf-audit wrapper/artifacts stay exactly as-is. The brief-relevant-only profile (#1) already benefits x-feed today.</li>
<li><strong>Shadow-first rollout:</strong> per the shadow-cutover discipline. Build the engine path + prompt label emission, run it in shadow (compute deterministic selection in parallel, keep posting the legacy prose-scored selection) for a window, diff the two selections on real x-feed pools, re-derive gates from that shadow data, THEN flip the live render. The live flip is the Hard-Config gate (touches the load-bearing daily x-feed post).</li>
</ol>

<h3>2.3 Why this is bigger than #1</h3>
<p>It changes (a) the x-feed prompt's scoring instructions (load-bearing), (b) adds parameterized MAX_TOP/MAX_ALSO + gate args to <code>score_digest</code>/<code>select_digest</code> (shared code morning-digest also uses — must not regress morning-digest), and (c) requires a shadow window + gate re-derivation before the live flip. Three coupled surfaces vs #1's one isolated stage.</p>

<h3>2.4 Tests</h3>
<ul>
<li>Unit: <code>select_shadow</code>/<code>build_render_input</code> accept <code>max_top</code>/<code>max_also</code>/<code>top_gate</code>/<code>also_gate</code> overrides; morning-digest defaults unchanged (regression: existing selftests still pass with 5/2 and 49/45).</li>
<li>Unit: x-feed label→score path produces a deterministic selection on a fixture pool; spam/promo with high engagement still blocked; off-topic/political tweet force-dropped.</li>
<li>Shadow-diff harness (like <code>calibrate_gate_recency.py</code>): runs both engines on recent <code>_last_run_scored.json</code> snapshots, reports selection delta + cardinality parity, used to re-derive gates.</li>
<li>Full project suite green; morning-digest selftest (both modes) unchanged.</li>
</ul>

<h3>2.5 Phasing</h3>
<ol>
<li><strong>P2.1 (code, safe):</strong> parameterize MAX_TOP/MAX_ALSO/gates in score_digest/select_digest + tests. No behavior change to morning-digest.</li>
<li><strong>P2.2 (code, safe) — BUILT 2026-06-11 (commit 637c269):</strong> shadow-diff harness (<code>scripts/xfeed_shadow.py</code>) + x-feed additive label-emission prompt change (Step 5b) + deterministic shadow compute (Step 6.75, <code>_shadow_deterministic</code>) behind a shadow path (compute, don't post). <code>select_digest</code> CLI gained <code>--max-top/--max-also/--top-gate/--also-gate</code>; <code>_item_text</code> reads x-feed's <code>text_snippet</code> as last-resort fallback (morning-digest byte-identical). Verify gate green (tsc+lint+180 unit+e2e+py selftests); 17 py tests. Live prompt edit backed up (<code>prompt.md.bak-20260611-144234-pre-p22-labels</code>), additive-only so the posted selection is provably unchanged.</li>
<li><strong>P2.3 (data):</strong> run shadow over a window; re-derive x-feed gates from real pools.</li>
<li><strong>P2.4 (Hard-Config gate):</strong> flip x-feed live render to the deterministic engine. Ace-gated diff, backup, rollback = revert prompt + drop flag.</li>
</ol>

<h3>2.6 Out of scope</h3>
<ul><li>Not unifying the two prompts into one. Not changing x-feed's gather/cost-guard/anti-rerun logic. Not changing pf-score math.</li></ul>

<hr>
<h2>Acceptance Criteria (both)</h2>
<ul>
<li>#1: daily ingest runs 5 stages; <code>profile</code> last + soft; written profile asserts <code>signal_basis.mode==='brief-relevant-only'</code>; profile-stage failure does not block export/heartbeat; atomic JSON write; tests green.</li>
<li>#2: x-feed prompt emits enum labels; deterministic engine selects via shared score_digest with x-feed-specific caps/gates re-derived from shadow data; morning-digest unaffected (selftests + suite green); live flip only after shadow window + Ace gate.</li>
</ul>

<h2>Rollback</h2>
<ul>
<li>#1: remove the 5th stage (one-line revert). Profile on disk unaffected.</li>
<li>#2: P2.1/P2.2 are additive/behind-shadow. P2.4 live flip reverts by restoring the prompt backup + dropping the engine flag.</li>
</ul>

<h2>Open Questions (for review)</h2>
<ol>
<li>#1 soft-stage: add a generic <code>soft?</code> flag to the stage type, or special-case <code>profile</code> by name? (Generic flag is cleaner + reusable; special-case is smaller.)</li>
<li>#2 gates: is cardinality-parity the right acceptance target, or should x-feed deliberately tighten (post fewer, higher-quality) on cutover?</li>
<li>#2 MAX_ALSO=5 for Quick Hits: confirm Quick Hits should flow through the same event-collapse/forced-distribution as Top, or stay a looser second tier.</li>
<li>#2: does x-feed's interest-search pool contain enough non-thought-leader high-engagement tweets that the cap 6→10 change matters there, or is it mostly known authors (making the cap moot)?</li>
</ol>
<hr>
<h2>§Blocker-Resolution (Pass-1 BLOCK → addressed, v2)</h2>
<p>Pass-1 (Opus via f2) returned BLOCK with 5 blockers. All accepted as legitimate; ground-truthed before fixing.
Artifact: <code>docs/reviews/xfeed-cutover-review-pass1.md</code>.</p>

<h3>B1 — #1 soft-fail loop must be shown as an exact diff, and must NOT swallow the timeout-abort throw</h3>
<p><strong>Resolved.</strong> The soft-fail is the load-bearing edit, specified exactly. The abort-signal check stays OUTSIDE the try so a wall-budget timeout on the <code>profile</code> iteration is never misclassified as a soft failure:</p>
<pre>// DailyIngestStageCommand gains: soft?: boolean
for (const stage of stages) {
  activeStage = stage.name
  if (abortController.signal.aborted) throw timeoutFailure(activeStage, wallBudgetMs)  // UNCHANGED, before try
  try {
    const stageResult = await runStage(stage, { signal: abortController.signal, cwd: config.cwd, env: config.env })
    mergeSourceRows(successSummary, stageResult)
    stagesRun.push(stage.name)
  } catch (err) {
    if (timedOut || err instanceof DailyIngestFailureError && err.failure.kind === 'timeout') throw err  // timeout wins, never soft-swallowed (final form: see P2C1)
    if (stage.soft) { softFailures.push({ stage: stage.name, reason: errorMessage(err) }); continue }
    throw err                                                            // hard stage: abort as today
  }
}</pre>
<p>The <code>profile</code> stage is declared <code>soft:true</code>. <code>DailyIngestResult</code> gains <code>softFailures?: {stage,reason}[]</code>; on any soft failure the run still returns <code>ok:true</code> but fires a #alerts message. Test (B1): a timeout during the <code>profile</code> iteration surfaces as <code>kind:'timeout'</code>, NOT a swallowed soft failure.</p>

<h3>B2 — Parameterize via explicit args, never global mutation; recompute LOW_REACH_SCORE_CAP in-function</h3>
<p><strong>Resolved + ground-truthed.</strong> Confirmed: <code>LOW_REACH_SCORE_CAP = ALSO_GATE - 5</code> is module-scope (score_digest.py:134) and <code>low_reach_cap()</code> returns it directly (line 311) — a param override would NOT propagate. Also confirmed: morning-digest and x-feed are <strong>separate cron jobs → separate <code>hermes</code> agent processes</strong> (verified in <code>~/.hermes/cron/jobs.json</code>), so they never share a live Python process. Global mutation is therefore not cross-brief-contaminating, but it remains fragile and is forbidden anyway. Design:</p>
<pre>def select_shadow(pool, tl_handles=None, tl_aliases=None, tracked=None, now=None, *,
                  max_top=None, max_also=None, top_gate=None, also_gate=None):
    mt = MAX_TOP if max_top is None else max_top
    ma = MAX_ALSO if max_also is None else max_also
    tg = TOP_GATE if top_gate is None else top_gate
    ag = ALSO_GATE if also_gate is None else also_gate
    low_reach_cap_val = ag - 5            # recomputed locally from the EFFECTIVE also_gate
    # low_reach_cap() gains a cap_val param (default LOW_REACH_SCORE_CAP) so the override threads through.</pre>
<p>Thread the same four overrides through <code>build_render_input(..., max_top=None, max_also=None, top_gate=None, also_gate=None)</code> into the <code>_sd.select_shadow(...)</code> call. <strong>No code path assigns to module globals.</strong> Tests (B2): (a) <code>build_render_input(engine="deterministic")</code> with NO overrides → byte-identical selection to the current morning-digest selftest on a frozen fixture (regression guard); (b) an override path test that exercises <code>also_gate</code> and asserts the in-function <code>low_reach_cap</code> moved with it; (c) a static guard test that grepping score_digest/select_digest finds no <code>MAX_TOP =</code>/<code>TOP_GATE =</code> reassignment outside the definition block.</p>

<h3>B3 — Shadow must not leak the prompt label change into the live post</h3>
<p><strong>Resolved (decision made).</strong> The shadow path uses an <strong>additive</strong> prompt change, not a forked file: during the shadow window x-feed's Step 5 emits BOTH the legacy per-metric ratings (which still drive the live <code>base_score</code> post, provably unchanged) AND the new 4 enum labels (consumed only by the shadow deterministic computation, which writes a shadow artifact and does NOT post). Only at P2.4 do we remove the legacy ratings and flip the live render. This keeps "compute, don't post" literally true with a single <code>prompt.md</code>. Acceptance: during shadow, the live posted selection is identical to pre-change (the ratings block is untouched); the deterministic selection is written to <code>_last_run_scored.json</code>'s shadow section only.</p>

<h3>B4 — Replace "cardinality parity" with membership-quality acceptance</h3>
<p><strong>Resolved.</strong> Cardinality parity was wrong — it could re-admit the exact gamed tweets the cutover exists to drop. New acceptance: on N≥5 recent <code>_last_run_scored.json</code> snapshots, the deterministic selection must (a) DROP every tweet the legacy path admitted that fails a known guard (engagement-gamed unknown-author, off-topic/political, bare fragment), (b) report the full membership diff (added/removed with per-item reason), and (c) land within ±1 of legacy volume as a sanity FLOOR, not the target. The intended post-cutover volume question (Open Q2) must be answered by Ace BEFORE P2.3 gate derivation — default target: "same volume, better membership" unless Ace says tighten.</p>

<h3>B5 — Provenance assert must verify FRESHNESS + mode of the just-written file</h3>
<p><strong>Resolved (final mechanism in P2C3).</strong> After the atomic rename, re-read the FINAL path and assert BOTH <code>signal_basis.mode === 'brief-relevant-only'</code> AND that <code>updated_at &gt;= stageStart - skewMs</code> (the monotonic lower bound defined in P2C3 — proves the file was written during THIS stage; a stale-but-valid profile from a prior manual run must soft-fail loudly, not pass). The soft-failure carries a distinguishable reason: <code>profile-write-failed</code> | <code>profile-stale</code> | <code>profile-contaminated</code>, so the #alerts message is actionable. Ground-truth note (OQ5): <code>profile.ts</code> writes <code>updated_at</code> from <code>isoNow(options.now)</code> — the daily cron passes no <code>options.now</code>, so it IS wall-clock in production; the freshness check uses the assert's own captured <code>stageStart</code>, not the profile's self-reported field, to avoid a spoofable self-report.</p>

<h3>Remaining Open-Question answers</h3>
<ul>
<li><strong>OQ1 (shared process):</strong> NO — separate cron jobs, separate processes (verified). Param-only design still mandated.</li>
<li><strong>OQ4 (MAX_ALSO=5 routing):</strong> Must be answered before P2.1. Quick Hits should flow through the SAME event-collapse + forced-distribution as Top (so a 5-account pile-on doesn't fill Quick Hits with dupes); MAX_ALSO is only the slot cap. Test asserts Quick Hits are event-deduped.</li>
<li><strong>OQ6 (atomic rename vs reader):</strong> <code>pf-score.py</code> opens the JSON fresh each invocation (<code>json.load(open(...))</code>), no mmap/cache — rename-over is safe for the consumer.</li>
</ul>

<hr>
<h2>§Pass-2-Changes (APPROVE-WITH-CHANGES → applied, v3)</h2>
<p>Pass-2 (Opus via f2) returned APPROVE-WITH-CHANGES: all 5 blockers RESOLVED, 5 tightening issues, no re-opened blockers. Artifact: <code>docs/reviews/xfeed-cutover-review-pass2.md</code>. Resolutions:</p>

<h3>P2C1 — B1 catch must gate on "error IS the timeout," + throw-then-abort-race test (NI-1)</h3>
<p><strong>Ground-truth correction:</strong> the reviewer assumed <code>timedOut</code> was undefined — but it IS defined (<code>daily-ingest.ts:146</code> <code>let timedOut = false</code>, set true in the timer at :149, already read at :191). So it is NOT a build error. The reviewer's substantive point stands and is adopted: the catch must distinguish "this error is the timeout" from "the signal happens to be aborted now" to avoid re-throwing a genuine soft-stage error that merely raced the deadline. Final B1 catch:</p>
<pre>  } catch (err) {
    // A real timeout/abort always wins (never soft-swallowed). Gate on the ERROR
    // being the timeout failure OR the timer having fired — both are unambiguous,
    // unlike "signal.aborted at this instant" which can race a non-timeout throw.
    if (timedOut || err instanceof DailyIngestFailureError && err.failure.kind === 'timeout') throw err
    if (stage.soft) { softFailures.push({ stage: stage.name, reason: errorMessage(err) }); continue }
    throw err
  }</pre>
<p>Tests: (a) timeout DURING <code>profile</code> → <code>kind:'timeout'</code> (not soft-swallowed); (b) NEW — a soft <code>profile</code> stage that throws a plain error while <code>timedOut===false</code> → recorded as soft, run <code>ok:true</code> (the throw-then-abort-race inverse).</p>

<h3>P2C2 — §2.2.1 additive optionality removed (NI-2)</h3>
<p><strong>Done</strong> — §2.2.1 now reads "in addition to (additive; legacy ratings retained until P2.4)"; the "instead of (or in addition to)" optionality is gone.</p>

<h3>P2C3 — B5 freshness window is a monotonic lower bound, not a magic duration (NI-3)</h3>
<p><strong>Resolved.</strong> Capture <code>stageStart = Date.now()</code> in TS immediately BEFORE spawning the <code>profile</code> stage. After the rename, assert the written <code>updated_at</code> (parsed to epoch ms) <code>&gt;= stageStart - skewMs</code> (small <code>skewMs</code>≈2000 only for clock granularity, NOT a freshness budget). This proves "the file was written during THIS stage" without a brittle duration: a slow rebuild still passes (no upper bound on the stage's own duration within the 20-min wall budget), while yesterday's profile fails (its <code>updated_at</code> &lt; today's <code>stageStart</code>). Reason code <code>profile-stale</code> fires only when <code>updated_at &lt; stageStart - skewMs</code>.</p>

<h3>P2C4 — Enumerate low_reach_cap() call sites + end-to-end cap-moves test (NI-4)</h3>
<p><strong>Resolved + ground-truthed.</strong> <code>low_reach_cap()</code> is defined at score_digest.py:~300 and called from exactly ONE site: inside <code>score_item()</code> (the <code>cap = low_reach_cap(item, is_known)</code> line). The override threads as: <code>score_item(..., low_reach_cap_val=None)</code> → passes to <code>low_reach_cap(item, is_known, cap_val=low_reach_cap_val)</code>; <code>select_shadow</code> passes its computed <code>ag - 5</code> down through <code>score_pool</code>/<code>score_item</code>. Test (end-to-end): an unknown-author item whose final score clears the DEFAULT cap (45) but not an overridden cap (e.g. 40) is dropped when <code>also_gate=45</code> is passed — proving the cap actually moved through the whole call chain, not just a local var.</p>

<h3>P2C5 — OQ4 answer promoted to normative §2.2.4 (NI-5)</h3>
<p><strong>Done</strong> — §2.2.4 now states normatively that Quick Hits use the same event-collapse/forced-distribution, caps are read generically (no <code>MAX_TOP==5</code> assumption), with the 5-account-pile-on Quick-Hits dedupe test.</p>

<h3>Pass-2 Open-Question answers</h3>
<ul>
<li><strong>P2-OQ1 (shadow section in <code>_last_run_scored.json</code>):</strong> NEW field — the Step-6.7 writer must add a <code>_shadow_deterministic</code> object (selected/also ids + the engine's <code>_select_audit</code>). This is part of P2.2's code scope; the spec's "add a Step 6.x" already implies a writer change — made explicit here.</li>
<li><strong>P2-OQ2 (additive prompt token/latency leak):</strong> Real risk, cheaply mitigated — P2.3 shadow acceptance adds a check that the live <code>base_score</code> distribution over the shadow window is unchanged vs the pre-additive baseline (if emitting labels degrades ratings, this catches it before the live flip).</li>
<li><strong>P2-OQ3 (volume target):</strong> Hard dependency on Ace. Default carried forward: "same volume, better membership" unless Ace says tighten — confirmed at the P2.3 gate, not assumed earlier.</li>
</ul>
</body></html>
