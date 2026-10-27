# =============================================================================
# Liner Notes API - Multi-stage Production Build
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

# An older npm ignores strict-allow-scripts and would run every install script; a version that
# cannot be read fails the build too.
RUN node -e 'const version = process.argv[1]; const parts = /^(\d+)\.(\d+)\.\d+$/.exec(version); if (!parts || Number(parts[1]) < 11 || (Number(parts[1]) === 11 && Number(parts[2]) < 18)) { console.error(`npm "${version}": 11.18 or later is needed to enforce strict-allow-scripts`); process.exit(1); }' "$(npm --version)"

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

# Stage 5: production (no package installs: the health check below is Node)
FROM base AS production

# Manifests and production node_modules. The API declares @liner-notes/contract as a
# dependency, so tsup leaves its imports external and node_modules/@liner-notes/contract links
# to packages/contract; the link needs the contract's built dist/, which is not in the
# repository.
COPY --from=deps /app ./
COPY --from=builder /app/packages/contract/dist ./packages/contract/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# The recorded runs (GET /api/replays, REPLAY_MODE): REPLAY_DIR's default, fixtures/replays at
# the repository root, is /app/fixtures/replays here.
COPY fixtures/replays ./fixtures/replays

# Create non-root user for security. The uid stays 1001, so existing data volumes, whose files
# that uid owns, stay writable.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home --shell /usr/sbin/nologin app

# Persistent directories: the database (/app/data) and the spend log (/app/spend, LLM_SPEND_LOG in
# deploy/compose.prod.yml), each a volume in production. A new named volume takes its owner from
# here.
RUN mkdir -p /app/data /app/spend && chown app:nodejs /app/data /app/spend

WORKDIR /app/apps/api

USER app

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV SQLITE_DB_PATH=/app/data/sonic-agent.db

EXPOSE 3001

# Health check: liveness (/api/health) with Node's fetch
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/health`, { signal: AbortSignal.timeout(5000) }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]

# Start server
CMD ["node", "dist/index.js"]
