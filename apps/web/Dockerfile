# check=skip=SecretsUsedInArgOrEnv
# (The only build setting named like a secret, VITE_TURNSTILE_SITE_KEY, is a public site key that
# ships in the bundle; the web image holds no secret.)
# =============================================================================
# Liner Notes web - Multi-stage Production Build
# The React/Vite app, served by Caddy (apps/web/Caddyfile), which also forwards /api to the API
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
# Empty: the footer's "Source" link points to the public repository.
ARG VITE_SOURCE_URL=
ENV VITE_SOURCE_URL=$VITE_SOURCE_URL
# The Cloudflare Turnstile site key (public, see apps/web/.env.example): the widget runs before
# each analysis. Empty: no widget, and the page sends the development bypass's token, which an
# API in production refuses.
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
RUN npm run build -w packages/contract && npm run build -w apps/web

# Stage 2: Caddy 2.11.7 on Alpine, pinned by digest. It serves dist/ from /srv and forwards /api/*
# to the API (apps/web/Caddyfile).
FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS production

# Unprivileged runtime user. Caddy needs no capability: the image's file capability (binding
# ports below 1024) is removed, so the binary also runs with every capability dropped and
# no-new-privileges. Docker lets any user of a container bind low ports in its own network
# namespace (net.ipv4.ip_unprivileged_port_start=0). /data (certificates) and /config are
# the only places Caddy writes.
RUN setcap -r /usr/bin/caddy \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app -s /sbin/nologin app \
    && chown app:app /data /config

COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 apps/web/caddy-start.sh /usr/local/bin/caddy-start
COPY --from=builder /app/apps/web/dist /srv

# The configuration must parse with the defaults it is shipped with.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

USER app

EXPOSE 80 443

# Health check: Caddy's own loopback-only endpoint (busybox wget is part of the base image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2020/health"]

# Caddy, after checking that a mounted site.d can be read (caddy-start.sh).
CMD ["/usr/local/bin/caddy-start"]
