# siftly web (x.ace) as a container

Status (2026-10-18, card t_9b3391b7): **side-by-side only.** The live server is still the
launchd unit `ai.siftly.web` on `*:3000`. This directory adds an image and a compose file that run
the same app on `127.0.0.1:13000`. Nothing here stops, replaces or repoints the live unit.

## What it runs

The Next.js 16 production server (`next start`) for the Siftly bookmark UI and its `/api/*` routes.
The app reads and writes one SQLite database (`prisma/dev.db`, Prisma 7 + better-sqlite3) and a
small tweet-syndication cache (`.local/tweet-cache.db`).

It does **not** run the scheduled jobs. `ai.siftly.daily-ingest` and `ai.siftly.video-drain-once`
stay launchd jobs on the host and keep writing the host's `prisma/dev.db`. Schema migrations stay
with that host tooling too: the container never runs `prisma migrate`.

## What talks to it

- Ace's browser, via `https://x.ace`. x.ace resolves to 192.168.1.18 (the Studio frontdoor Caddy),
  which proxies to `:3000`. Cutover keeps `:3000`, so the frontdoor needs no change.
- The x.com bookmarklet posts to `/api/import/bookmarklet`.
- Outbound from the app: X API (Connect-X import), OpenAI (AI search and categorize, when a key is
  set), the cliproxyapi translation lane at `127.0.0.1:18812`, and `cdn.syndication.twimg.com`.
  Inside the container `127.0.0.1` is the container itself. To reach a host-loopback service, set
  `SIFTLY_TRANSLATE_BASE_URL=http://host.docker.internal:18812/v1` in the env file.

## Image

- Source: `deploy/docker/Dockerfile`, built locally from this repo. It is not pushed to a registry.
  Image: `siftly-web:local`.
- Base: `node:26.8.2-bookworm-slim`, the same node version as the Homebrew node behind the live unit.
- Dependencies come from `deploy/docker/package-lock.live.json`. The repo-root `package-lock.json`
  has drifted from `package.json` (react-tweet, swr and vitest are missing; better-sqlite3 and
  prisma are older), so `npm ci` refuses it. The `.live` lock pins the exact tree the live server
  runs (taken from its `node_modules`), plus the linux native binaries. Versions: next 16.1.6,
  react 19.2.3, better-sqlite3 12.10.0, @prisma/client 7.8.0, react-tweet 3.3.1.
- Runs as the image's `node` user. Memory-capped at 1 GB (about 175-250 MiB measured), 2 CPUs.

## Config and secrets

The image contains no secrets. All of these are optional at runtime. The pages and read APIs work
without them; that is how the parity run below was done.

| Var | Used by | Source |
|---|---|---|
| `OPENAI_API_KEY` | AI search, categorize, vision | `op://Engineering/zizaufjihwcwxk6am5rga5xpgm/credential` |
| `X_OAUTH_CLIENT_ID` / `X_OAUTH_CLIENT_SECRET` | Connect-X import | `op://Engineering/n32tdp5kpvb7i4pga2thzatqwy/oauth2_client_id` / `oauth2_client_secret` |
| `SIFTLY_TRANSLATE_BASE_URL` / `_API_KEY` / `_MODEL` | translation lane | defaults in `scripts/with-secrets.sh` (local cliproxyapi key) |
| `SIFTLY_USERNAME` / `SIFTLY_PASSWORD` | optional basic auth (`middleware.ts`) | unset today |

To use them, render an env file outside the repo, mode 600, and point `SIFTLY_ENV_FILE` at it.
Compose passes it in at run time with `env_file`. Never commit that file and never bake it into
the image.

```bash
umask 077; f=~/.config/siftly-web.env
{ echo "OPENAI_API_KEY=$(~/.hermes/scripts/op-cached-read op://Engineering/zizaufjihwcwxk6am5rga5xpgm/credential)"
  echo "X_OAUTH_CLIENT_ID=$(~/.hermes/scripts/op-cached-read op://Engineering/n32tdp5kpvb7i4pga2thzatqwy/oauth2_client_id)"
  echo "X_OAUTH_CLIENT_SECRET=$(~/.hermes/scripts/op-cached-read op://Engineering/n32tdp5kpvb7i4pga2thzatqwy/oauth2_client_secret)"
  echo "SIFTLY_TRANSLATE_BASE_URL=http://host.docker.internal:18812/v1"; } > "$f"
```

Other env, set in the image or compose: `DATABASE_URL=file:/data/prisma/dev.db`,
`SIFTLY_TWEET_CACHE_PATH=/data/local/tweet-cache.db`, and `TZ` (default `America/Los_Angeles`;
the index greeting is computed from server local time).

## Volumes

| Container path | Host source | Mode | Notes |
|---|---|---|---|
| `/data/prisma` | `$SIFTLY_PRISMA_DIR` (required) | rw | directory holding `dev.db` |
| `/data/local` | `$SIFTLY_LOCAL_DIR`, else the named volume `siftly-web_tweet_cache` | rw | `tweet-cache.db` |

**The web process writes to the database.** Settings, category create/delete, bookmark category
edits, imports, categorize and "delete all" all write `dev.db`. Reading `tweet-cache.db` also writes
it, because the cache fills on read. So the side-by-side container must **never** mount the live
`~/Projects/siftly-ace/prisma`. Two servers writing one SQLite file across the OrbStack file share
can corrupt it. Side-by-side mounts a snapshot copy. Only the cutover mounts the live directory,
after the launchd unit is stopped.

## Ports

- Side-by-side: `127.0.0.1:13000` (default `SIFTLY_BIND`).
- Production after cutover: `0.0.0.0:3000` (`SIFTLY_BIND=0.0.0.0:3000`), the same as the unit today.
- fleet/ports.json is owned by the integration card t_53d9d5ee. This card does not edit it.

## Host requirements

Mac Studio with OrbStack (docker + compose v2). The build needs network access to
registry.npmjs.org and nodejs.org (for node headers: better-sqlite3 compiles from source because
no prebuilt exists for node 26). Plan for about 1 GB of free memory and 0.3 GB of disk for the image.

## Side-by-side run (what this card did)

```bash
cd ~/Projects/siftly-ace
S=/Volumes/fleet-scratch/siftly-web-sbs; mkdir -p $S/prisma $S/local
sqlite3 -readonly prisma/dev.db         ".backup '$S/prisma/dev.db'"        # online, consistent copy
sqlite3 -readonly .local/tweet-cache.db ".backup '$S/local/tweet-cache.db'"
docker build -f deploy/docker/Dockerfile -t siftly-web:local .
cd deploy/docker
SIFTLY_PRISMA_DIR=$S/prisma SIFTLY_LOCAL_DIR=$S/local docker compose up -d --no-build
./parity.sh                       # old http://127.0.0.1:3000 vs new http://127.0.0.1:13000
docker compose down; rm -rf $S    # teardown
```

## Parity probe

`deploy/docker/parity.sh [OLD] [NEW]` runs 15 GETs: `/`, `/bookmarks`, `/ai-search`, the
bookmark text search (`/api/bookmarks?q=claude`), the newest-5 list, 5 single bookmarks (pages
101-105 at `limit=1`), a category page, `/api/categories`, `/api/stats`, `/mindmap`, and
`/api/tweets/<id>`, the cached-tweet route the bookmark rows hydrate from. For each it compares the
HTTP status and the sha256 of the normalized body. Exit 0 means 15/15 match.

Normalization strips only per-build values:
- the Next build id, both as-is and in its `-`→`_` form in the `<!--…-->` head comment;
- hashed asset file names under `/_next/static/(chunks|media|css)/`;
- `nonce="…"` attributes (none are emitted today).

Data, markup and text must match byte for byte. Both servers must read the same data: take the
snapshot right before the probe. A nightly ingest that lands in between shows up as a diff, and so
does any write sent to only one side (verified with a canary category).

The web app has no "brief" page. The morning and x-feed briefs are rendered offline by
`scripts/html_report.ts` and published to docs.ace, so they are out of scope for this server.

## Cutover (separate, operator-verified step; NOT run by this card)

```bash
cd ~/Projects/siftly-ace/deploy/docker
docker build -f Dockerfile -t siftly-web:local ../..                      # image from current main
cp ~/Projects/siftly-ace/prisma/dev.db ~/Projects/siftly-ace/prisma/dev.db.bak-precutover-$(date +%Y%m%d)
launchctl bootout gui/$(id -u)/ai.siftly.web                              # stop the unit (:3000 frees)
lsof -nP -iTCP:3000 -sTCP:LISTEN || echo ":3000 free"
SIFTLY_BIND=0.0.0.0:3000 SIFTLY_PRISMA_DIR=$HOME/Projects/siftly-ace/prisma \
  SIFTLY_LOCAL_DIR=$HOME/Projects/siftly-ace/.local SIFTLY_ENV_FILE=$HOME/.config/siftly-web.env \
  docker compose up -d --no-build
curl -sk -o /dev/null -w '%{http_code}\n' https://x.ace/                # 200 through the frontdoor
```

Parity after cutover: the old unit is down, so compare the container on :3000 with a scratch
container started from a fresh snapshot on :13000 (the side-by-side recipe above), then remove the
scratch container. Keep the plist file. Mark it disabled so a login does not race the container for
:3000: `launchctl disable gui/$(id -u)/ai.siftly.web`. Also add a docker/OrbStack start-at-login.

## Rollback

```bash
cd ~/Projects/siftly-ace/deploy/docker && docker compose down
launchctl enable gui/$(id -u)/ai.siftly.web
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.siftly.web.plist
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

The plist and `scripts/web-server.sh` are not modified by any of this.

## Start / stop / upgrade / backup / restore

- Start: `docker compose up -d --no-build`. Stop: `docker compose down`. Logs: `docker logs -f siftly-web`.
- Health: the compose healthcheck GETs `/api/stats`. Check it with `docker inspect siftly-web --format '{{.State.Health.Status}}'`.
- Upgrade the app: pull main, `docker build -f deploy/docker/Dockerfile -t siftly-web:local .`, then `docker compose up -d --no-build`.
- Upgrade dependencies: after changing deps on the host (`npm install`), regenerate the `.live` lock
  from the host's `node_modules/.package-lock.json`. Then fill the linux optional entries with
  `docker run --rm -v $PWD:/w -w /w node:26.8.2-bookworm-slim npm install --package-lock-only --ignore-scripts`,
  run on a copy of `package.json` plus the lock. Or fix the root `package-lock.json` and point the Dockerfile back at it.
- Backup: the data lives on the host, not in the image. Back up with
  `sqlite3 -readonly prisma/dev.db ".backup '<dest>'"` (safe while the server runs), plus `.local/tweet-cache.db` (a disposable cache).
- Restore: `docker compose down`, copy the backup over `prisma/dev.db`, then `docker compose up -d --no-build`.
