# parakeet-transcribe — tests

End-to-end test suite for the parakeet-transcribe skill + ACE-AI service.

## Run

```bash
cd ~/Projects/siftly-ace
python3 -m pytest deploy/ace-ai/tests/test_parakeet_transcribe.py -v
```

Override the service URL if not the default:
```bash
PARAKEET_SERVICE_URL=http://<host>:8923 python3 -m pytest deploy/ace-ai/tests/ -v
```

## Layers

| Layer | Needs | Tests |
|---|---|---|
| 1. Pure/unit | nothing | §K9 shape, x.com→twitter rewrite, Whisper→K9 mapping, all-backends-failed error shape |
| 2. Service | ACE-AI service reachable | `/health`, URL transcribe (direct audio), **X.com video e2e**, timestamps, file-upload |
| 3. Skill wrapper | Mac skill installed | `--text` mode via real X video, **forced Whisper fallback** |
| 4. Negative | service | bad/non-fetchable URL → clean error, not hang |

Service/skill tests **skip cleanly** when the dependency is unreachable (CI on the Mac without LAN access still runs the unit layer). Last full run: **11 passed** (2026-06-07).

## Prerequisites for the full suite

- ACE-AI service active (`systemctl is-active parakeet-transcribe` on 192.168.1.216) **and reachable** — note the ufw rule `allow from 192.168.1.0/24 to any port 8923` must be present (the service binds to the LAN IP but ufw default-denies; without the rule the service is only reachable via SSH-localhost).
- `whisper` CLI on the Mac for the fallback test (else it skips).
