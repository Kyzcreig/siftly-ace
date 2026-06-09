# Wave 5 Review — Evidence Pack (ground truth; trust this)

## x-feed-brief prompt Step 1 (the timeline pull — currently inline, no cache)
File: ~/.hermes/state/cron/x-feed-brief/prompt.md (lines 12-48)
- Paginates GET /2/users/56282605/timelines/reverse_chronological?max_results=100 (+pagination_token) until oldest tweet < SINCE(24h) or PAGE>=MAX_PAGES(20).
- Cost note in-prompt: "~1,300 tweets/day => ~13 pages, ~$6.50/run at $0.005/read. HARD CAP 20 pages."
- Then 3x: xurl --auth app '/2/tweets/search/recent?query=...&max_results=20...'
- NO cache read/write anywhere. run-*/responses.jsonl is an incidental agent debug dump (no script reads it back).

## morning-digest prompt (X portion — search-only, cheap)
File: ~/.hermes/state/cron/morning-digest/prompt.md (lines ~138-170)
- Uses direct bearer curl to /2/tweets/search/recent (max_results 10-100). No reverse_chronological timeline sweep.

## pf-score.py output shape (already shipped, commit 375ca87)
File: scripts/pf-score.py
- Emits JSON: {ok, base_score_only, profile_path, pf_weight, pf_baseline, items:[{index,id,url,title,personal_fit_raw,personal_fit_affinity,personal_fit_delta,base_score_only,signals:{topic_score,topic_hits,author_score,author_hits,format_score,format_hits,downrank_score,downrank_hits}}]}
- Fail-safe: ALL errors exit 0 with {ok:false, base_score_only:true, reason, items:[]}.
- PF_WEIGHT=0 => base_score_only true, delta 0. PF_BASELINE default 0.18 (env/config tunable), raw = clamp(affinity - baseline).

## Brief prompt pf-score call site (both briefs, already wired)
- x-feed Step 4.5 (prompt lines 76-88): timeout 30s pf-score.py /path/candidates.json > /tmp/x-feed-pf-score.json; final_score = base + delta; archive audit line per item.
- morning-digest Step (lines ~221-226): same pattern -> /tmp/morning-digest-pf-score.json.
- Archive paths: Obsidian "Content/X Feed Brief/YYYY-MM-DD.md" (x-feed Step 7.5); morning digest archive similar.

## AI-search route (the latent 90s hang)
File: app/api/search/ai/route.ts
- L196 getDbApiKey() reads prisma.setting (openaiApiKey|anthropicApiKey by provider). DB rows currently EMPTY but resolveAIClient picks up env OPENAI_API_KEY.
- L204 resolveAIClient({dbKey}) — provider from getProvider().
- L208 getActiveModel(); L209 getProvider().
- L357-372 SDK path (fast, ~10s). L374-403 CLI fallback: codexPrompt(prompt,{timeoutMs:90_000}) or claudePrompt(...,{timeoutMs:90_000}) — the 90s hang.
- L395-401 returns error JSON only if CLI also fails.

## getProvider() default (lib/settings.ts L44-51)
- key 'aiProvider'; returns 'openai' if val==='openai', 'minimax' if 'minimax', ELSE 'anthropic' (silent default).
- DB currently: aiProvider=openai (verified). getOpenAIModel default 'gpt-4.1-mini'; getActiveModel default model 'claude-haiku-4-5-20251001'.

## AI-search page (no progress UI)
File: app/ai-search/page.tsx
- L83-121 handleSearch: AbortController 100_000ms timeout; loading bool only; button shows "Searching…" with spinner while loading. No elapsed timer / "~10-15s" hint.

## Live verification (2026-06-08)
- POST /api/search/ai {"query":"<unique> crypto wallet tools"} -> HTTP 200, real AI matches, 10.5s (genuine LLM call). NOT broken.
- DB aiProvider=openai; launchd web server (ai.siftly.web) runs scripts/web-server.sh -> with-secrets.sh npm run start (injects OPENAI_API_KEY len 164).

## Project conventions
- npm run verify = typecheck + lint(--max-warnings 14) + vitest + e2e. Python tests: scripts/__tests__/pf_score_test.py run by path.
- Secrets via scripts/with-secrets.sh (1Password). Launchd PATH stripped -> use npx tsx / absolute paths.
- Config-class: never edit ~/.hermes/state/cron/*/prompt.md without diff+.bak+Ace approval (G-W5-1, G-W5-2).
