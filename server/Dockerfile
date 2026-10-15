# =============================================================================
# Sonic Agent Server - Multi-stage Production Build
# Node.js/LangGraph Backend
# =============================================================================

# Stage 1: Build
FROM node:20-alpine3.19 AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine3.19 AS production

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps && npm cache clean --force

# Remove build tools after native addon compilation
RUN apk del python3 make g++

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S sonic -u 1001 -G nodejs

# Create persistent data directory
RUN mkdir -p /app/data && chown sonic:nodejs /app/data

USER sonic

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:3001/api/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
