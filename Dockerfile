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
# Creative library thumbnails: images use sharp (bundled). Video poster
# frames need ffmpeg; without it videos keep no thumbnail and the library
# shows their player instead.
RUN apk add --no-cache ffmpeg
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/src/db/migrations ./src/db/migrations
# The scripts copied below import this one file from src (the index name); see scripts/lib/creative-unique-index.ts.
COPY --from=build /app/src/db/creative-index.ts ./src/db/creative-index.ts
COPY --from=build /app/scripts ./scripts
# The MCP setup guide, served by GET /api/v1/mcp-docs. Only this one file: docs/ also holds internal runbooks that do not belong in the image.
COPY --from=build /app/docs/mcp-setup.md ./docs/mcp-setup.md
COPY --from=build /app/drizzle.config.ts ./

EXPOSE 3001
# Boot order: migrate → start. No data is seeded on boot.
#
#   1. db:auto-migrate — defensive idempotent migrator (tolerates "already
#      exists"; works whether prod was bootstrapped via db:push or db:migrate).
#   2. node dist/index.js — start the API.
#
# A real migration error causes the container to exit non-zero so Railway
# shows the failure instead of starting a broken server.
# STAGING ONLY: also seed the internal users (idempotent, passwords from SEED_*
# env) because NODE_ENV=production skips the in-memory dev seed. Do not merge
# this line to main.
CMD ["sh", "-c", "pnpm db:auto-migrate && node dist/db/seed.js && node dist/index.js"]
