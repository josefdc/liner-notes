# =============================================================================
# Sonic Agent Web - Multi-stage Production Build
# React/Vite Frontend with Nginx
# =============================================================================

# Stage 1: Build
# node:24-slim (Debian bookworm), pinned to the build of Node 24.21.0 with npm 11.19.0, the same
# image as the API.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder

WORKDIR /app

# Install scripts: .npmrc sets strict-allow-scripts, which npm enforces from 11.18 on, so only
# the scripts listed under "allowScripts" in package.json run, as in a local checkout and in CI.
# An older npm ignores the setting and would run every install script; a version that cannot be
# read fails the build too.
RUN node -e 'const version = process.argv[1]; const parts = /^(\d+)\.(\d+)\.\d+$/.exec(version); if (!parts || Number(parts[1]) < 11 || (Number(parts[1]) === 11 && Number(parts[2]) < 18)) { console.error(`npm "${version}": 11.18 or later is needed to enforce strict-allow-scripts`); process.exit(1); }' "$(npm --version)"

# Build context is the repository root (one lockfile for all workspaces).
# Install dependencies first (for better caching)
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY services/audio/package.json services/audio/
COPY packages/contract/package.json packages/contract/
RUN npm ci -w apps/web -w packages/contract

# Copy source files: the shared contract and the web app
COPY packages/contract packages/contract
COPY apps/web apps/web

# Build for production
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w packages/contract && npm run build -w apps/web

# Stage 2: Nginx Production
FROM nginx:alpine AS production

# Copy built files to nginx
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Copy nginx configuration
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Create non-root user for nginx (security)
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]
