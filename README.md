# Sato Backend

Express.js 5 REST API for the Stato business management system.

## Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** Express 5
- **Database:** PostgreSQL (via Drizzle ORM)
- **Queue:** BullMQ + Redis
- **Auth:** JWT (access + refresh tokens)
- **Integrations:** Xero (accounting)
- **Language:** TypeScript

## Prerequisites

- Node.js 20+
- pnpm 10+
- PostgreSQL 15+
- Redis 7+ (optional, needed for job queue)

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your database and Redis credentials:

```
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
JWT_SECRET=your-jwt-secret-min-32-chars-long-here
JWT_REFRESH_SECRET=your-refresh-secret-min-32-chars-long
DATABASE_URL=postgresql://user:password@localhost:5432/stato
REDIS_URL=redis://localhost:6379
```

### 3. Set up the database

```bash
# Push schema to database
pnpm db:push

# Seed default users
pnpm db:seed
```

### 4. Start the dev server

```bash
pnpm dev
```

The API will be running at **http://localhost:3001**.

## Default Users

After seeding, the following demo accounts are available:

| Email | Password | Role |
|-------|----------|------|
| owner@stato.app | owner123 | owner |
| finance@stato.app | finance123 | finance_admin |
| ops@stato.app | ops123 | ops_manager |
| client@stato.app | client123 | client |
| readonly@stato.app | readonly123 | readonly |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled production build |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm db:generate` | Generate Drizzle migration files |
| `pnpm db:push` | Push schema directly to database |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:studio` | Open Drizzle Studio (DB browser) |
| `pnpm db:seed` | Seed default users |
| `pnpm worker` | Start BullMQ background worker |

## API Base URL

All endpoints are prefixed with `/api/v1`.

## Project Structure

```
src/
  config/        # Database, Redis, env config
  controllers/   # Route handlers
  data/          # Static seed data and permissions
  db/
    schema/      # Drizzle table definitions
    migrations/  # SQL migration files
    seed.ts      # Database seeder
  integrations/  # Third-party integrations (Xero)
  jobs/          # BullMQ queues and workers
  middleware/    # Auth, RBAC, validation, error handling
  routes/        # Express route definitions
  services/      # Business logic
  types/         # Shared TypeScript types
  utils/         # Logger, crypto, error classes
  index.ts       # Server entrypoint
```
