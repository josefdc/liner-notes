# =============================================================================
# Sonic Agent Server - Multi-stage Production Build
# Node.js/LangGraph Backend
# =============================================================================

# Stage 1: Build
FROM node:20-alpine3.19 AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Build context is the repository root (one lockfile for all workspaces).
# Install dependencies first (for better caching)
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY services/audio/package.json services/audio/
COPY packages/contract/package.json packages/contract/
# Full install: build tools resolve exactly as in a local checkout
RUN npm ci

# Copy source files
COPY apps/api apps/api

# Build TypeScript
RUN npm run build -w apps/api

# Stage 2: Production
FROM node:20-alpine3.19 AS production

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY services/audio/package.json services/audio/
COPY packages/contract/package.json packages/contract/
RUN npm ci -w apps/api --omit=dev && npm cache clean --force

# Remove build tools after native addon compilation
RUN apk del python3 make g++

# Copy built files from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S sonic -u 1001 -G nodejs

# Create persistent data directory
RUN mkdir -p /app/data && chown sonic:nodejs /app/data

WORKDIR /app/apps/api

USER sonic

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3001
ENV SQLITE_DB_PATH=/app/data/sonic-agent.db

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:3001/api/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
