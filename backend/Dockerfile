# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the signaling + SFU backend.
#   1. base    — node 24 alpine, sets working dir
#   2. deps    — installs production deps (bind mount package.json) so the
#                runtime image is small
#   3. build   — installs dev deps + tsc compiles src/ → dist/
#   4. runtime — copies dist + production node_modules from earlier stages.
#                Runs `node dist/server.js`. The mediasoup worker binary
#                ships pre-built in the npm package and works on alpine
#                glibc-via-musl-shim variants; if you hit dlopen issues
#                switch the runtime base to `node:24-bookworm-slim`.
#
# Build context expected at the backend/ directory.

FROM node:24-alpine AS base
WORKDIR /app

# --- prod deps only (small layer) ---
FROM base AS deps
COPY package.json package-lock.json* ./
# Try `npm ci` first; fall back to `npm install` if the lockfile can't
# be applied cleanly (e.g. cross-platform optional-dep mismatches when
# the lockfile was generated on a different OS).
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 || npm install --omit=dev --no-audit --no-fund --ignore-scripts

# --- build (typecheck + tsc emit) ---
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --ignore-scripts \
 || npm install --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -b

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 3000
USER node

CMD ["node", "dist/server.js"]
