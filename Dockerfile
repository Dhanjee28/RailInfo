# ─── Stage 1: builder ─────────────────────────────────────────────────────────
# Full toolchain (all deps + ts-node + prisma CLI). Compiles TS → dist and
# generates the Prisma client. This stage is also reused by the one-shot
# `migrate` compose service to run `migrate deploy` + `db seed`.
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma's query/schema engines need OpenSSL — not bundled in alpine.
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
# Slim image: production deps only, no source/devDeps, runs as a non-root user.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL for the Prisma query engine at runtime.
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Generated Prisma client (engine binary + client) from the builder. Same base
# image → the alpine query-engine binary matches.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

# Run as non-root.
RUN addgroup -S nodejs -g 1001 \
  && adduser -S nodejs -u 1001 -G nodejs \
  && chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000
CMD ["node", "dist/server.js"]
