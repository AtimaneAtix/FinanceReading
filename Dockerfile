# syntax=docker/dockerfile:1

# --- dependencies ----------------------------------------------------------
# better-sqlite3 ships prebuilt binaries for common platforms but falls back to
# compiling, so the build stage carries a toolchain the runtime image does not.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Playwright is an optional dependency and pulls a large browser; the web and
# worker services never need it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=optional --no-audit --no-fund

# --- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/app/data/feeds.db \
    PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY config ./config

# The database lives on a mounted volume; the directory must exist either way.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
CMD ["npm", "start"]
