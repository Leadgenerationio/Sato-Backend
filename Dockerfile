FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Production
FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle.config.ts ./

EXPOSE 3001
# Boot order: migrate → seed-if-empty → start.
#
#   1. db:auto-migrate — defensive idempotent migrator (tolerates "already
#      exists"; works whether prod was bootstrapped via db:push or db:migrate).
#   2. db:seed-if-empty — creates the four internal users on a fresh DB only
#      (no-op when users already exist). In production it refuses to seed
#      unless SEED_OWNER_PASSWORD is set, so default passwords never reach
#      production.
#   3. node dist/index.js — start the API.
#
# A real migration error or missing prod password causes the container to
# exit non-zero so Railway shows the failure instead of starting a broken
# server.
CMD ["sh", "-c", "pnpm db:auto-migrate && pnpm db:seed-if-empty && node dist/index.js"]
