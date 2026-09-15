# =============================================================================
# Aegis — Dockerfile
#
# Phase 0: Demonstrates the TypeScript build and startup.
#
# This Dockerfile builds the API application.
# In future phases, this will be split into service-specific images
# with proper multi-stage builds optimized for production.
# =============================================================================

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install pnpm
RUN npm install -g pnpm@12

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.base.json ./

# Copy all package manifests
COPY packages/foundation/package.json ./packages/foundation/
COPY packages/types/package.json ./packages/types/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

# Copy tsconfigs for project references
COPY packages/foundation/tsconfig.json ./packages/foundation/
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/config/tsconfig.json ./packages/config/
COPY packages/logger/tsconfig.json ./packages/logger/
COPY apps/api/tsconfig.json ./apps/api/

# Build
RUN pnpm build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN npm install -g pnpm@12

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/foundation/package.json ./packages/foundation/
COPY packages/types/package.json ./packages/types/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY apps/api/package.json ./apps/api/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/packages/foundation/dist ./packages/foundation/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/logger/dist ./packages/logger/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Set production environment
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Create a non-root user for security
RUN addgroup --system --gid 1001 aegis \
  && adduser --system --uid 1001 --ingroup aegis aegis
USER aegis

EXPOSE 3000

CMD ["node", "apps/api/dist/main.js"]
