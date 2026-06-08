# siftly-ace e2e tests

Run the full end-to-end pipeline suite with the real sqlite-vec extension enabled:

```bash
SIFTLY_SQLITE_VEC_EXTENSION_PATH=./.local/vec0.dylib npx vitest run --dir e2e
```

The sqlite-vec gate is intentionally hard-fail when `SIFTLY_SQLITE_VEC_EXTENSION_PATH` is set. If the dylib is missing, fails to load, or the vector store falls back to brute-force, the real-vec e2e tests fail instead of skipping.

If the env var is unset, the real-vec cases skip and print:

```text
VEC0 E2E SKIPPED — set SIFTLY_SQLITE_VEC_EXTENSION_PATH to enforce
```

CI should set `SIFTLY_SQLITE_VEC_EXTENSION_PATH`. `.local/vec0.dylib` is gitignored; if absent on macOS, fetch it from the standalone package in a throwaway directory:

```bash
npm i sqlite-vec-darwin-arm64@0.1.9 --ignore-scripts
cp node_modules/sqlite-vec-darwin-arm64/vec0.dylib /path/to/siftly-ace/.local/vec0.dylib
```

Embeddings default to recorded deterministic keyword vectors, so the suite does not need a network call or paid API key. To exercise the live OpenAI embedding seam, set `SIFTLY_E2E_LIVE_EMBED=1` plus `OPENAI_API_KEY` or `SIFTLY_EMBED_API_KEY`; missing keys hard-fail instead of falling back to recorded vectors.
