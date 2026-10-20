# =============================================================================
# Sonic Agent Server - Multi-stage Production Build
# Node.js/LangGraph Backend
# =============================================================================
# Build context is the repository root (one lockfile for all workspaces).
#
# Base: node:24-slim (Debian bookworm), pinned to the build of Node 24.21.0 with npm 11.19.0.
# Every stage starts from the same image, so the native module built in one runs in the other.
#
# Install scripts: .npmrc sets strict-allow-scripts, which npm enforces from 11.18 on, so only
# the scripts listed under "allowScripts" in package.json run (better-sqlite3 here), as in a
# local checkout and in CI. A dependency with a script nobody approved fails the build.

# Stage 1: base image
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base

WORKDIR /app

# Stage 2: manifests, the install policy and the toolchain better-sqlite3 builds with when no
# prebuilt binary can be downloaded
FROM base AS toolchain

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# An older npm ignores strict-allow-scripts and would run every install script.
RUN node -e 'const [major, minor] = process.argv[1].split(".").map(Number); if (major < 11 || (major === 11 && minor < 18)) { console.error(`npm ${process.argv[1]}: 11.18 or later is needed to enforce strict-allow-scripts`); process.exit(1); }' "$(npm --version)"

COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY services/audio/package.json services/audio/
COPY packages/contract/package.json packages/contract/

# Stage 3: build
FROM toolchain AS builder

# Full install: build tools resolve exactly as in a local checkout
RUN npm ci

# Copy source files: the shared contract and the API
COPY packages/contract packages/contract
COPY apps/api apps/api

# Build TypeScript: the contract first (its dist/ is not in the repository), then the API
RUN npm run build -w packages/contract && npm run build -w apps/api

# Stage 4: production dependencies only, installed here so the runtime image has no toolchain
FROM toolchain AS deps

RUN npm ci -w apps/api --omit=dev && npm cache clean --force

# Stage 5: production
FROM base AS production

# wget runs the health checks (here and in docker-compose.yml); the slim image has none.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

# Manifests and production node_modules. The API declares @liner-notes/contract as a
# dependency, so tsup leaves its imports external and node_modules/@liner-notes/contract links
# to packages/contract; the link needs the contract's built dist/, which is not in the
# repository.
COPY --from=deps /app ./
COPY --from=builder /app/packages/contract/dist ./packages/contract/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Create non-root user for security
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin sonic

# Create persistent data directory
RUN mkdir -p /app/data && chown sonic:nodejs /app/data

WORKDIR /app/apps/api

USER sonic

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV SQLITE_DB_PATH=/app/data/sonic-agent.db

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3001/api/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
