# siftly web (x.ace) — Next.js production server, containerized.
# Build from the repo root:  docker build -f deploy/docker/Dockerfile -t siftly-web:local .
# Node is pinned to the same major/minor the launchd unit runs today (Homebrew node 26.8.2)
# so better-sqlite3's native ABI and Next's output match the live server.
ARG NODE_IMAGE=node:26.8.2-bookworm-slim

# ── deps + build ──────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# better-sqlite3 falls back to a source build when no prebuilt matches this ABI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# postinstall runs scripts/ensure-native-abi.sh (host self-heal); not needed in a fresh image.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY . .
RUN node_modules/.bin/prisma generate \
 && npm run build \
 && npm prune --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_URL=file:/data/prisma/dev.db \
    SIFTLY_TWEET_CACHE_PATH=/data/local/tweet-cache.db

COPY --from=builder --chown=node:node /app/package.json /app/next.config.ts ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public

# /data/prisma holds dev.db (bind-mounted); /data/local holds tweet-cache.db.
RUN mkdir -p /data/prisma /data/local && chown -R node:node /data
USER node
EXPOSE 3000
# No `prisma migrate deploy` here: schema migrations stay with the host-side ingest
# tooling (same as the launchd unit), the web server only opens the existing DB.
CMD ["node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
